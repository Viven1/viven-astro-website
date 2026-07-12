// Supabase Edge Function: ai-keywords
// KEYWORD RESEARCH desde el dashboard: cruza las búsquedas REALES de Search
// Console (posiciones, clicks, impresiones) con research de competencia vía
// Claude + búsqueda web, y devuelve oportunidades accionables priorizadas.
// Cada oportunidad se puede mandar directo a la cola del motor de contenido.
//
// Deploy:   supabase functions deploy ai-keywords --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN (scope webmasters), ANTHROPIC_API_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function googleToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status);
  return (await res.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    // 1) búsquedas reales de GSC (90 días, top 100 queries con posición)
    const token = await googleToken();
    let site = Deno.env.get("GSC_SITE") || "";
    if (!site) {
      const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
      const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
      const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
      const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
      site = pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
    }
    const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - 90 * 864e5);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const qres = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions: ["query"], rowLimit: 100 }),
    });
    const rows = qres.ok ? ((await qres.json()).rows ?? []) : [];
    const gscLines = rows.map((r: { keys: string[]; clicks: number; impressions: number; position: number }) =>
      `"${r.keys[0]}" — pos ${r.position.toFixed(1)}, ${r.impressions} impresiones, ${r.clicks} clicks`).join("\n");

    // 2) Claude + búsqueda web: cruza con la competencia y prioriza
    const prompt = `Sos el estratega SEO de viven.ch (productora de video en Zúrich; EN/DE/ES; hub /resources/ con 100 respuestas; blog activo; páginas de servicio: brand, product, employer branding, how-to, social, corporate; página local Geneva). Objetivo: LEADS de empresas suizas.

BÚSQUEDAS REALES de Google Search Console (últimos 90 días):
${gscLines || "(sin datos todavía — el sitio relanzó hace poco)"}

Usá la búsqueda web para revisar qué rankea la competencia suiza (p. ej. productoras de video en Zürich/Ginebra/Basilea, maybaum.ch, cognitives.ch, la-fabrica.ch u otras que encuentres) y detectá huecos.

Devolveme 8-12 OPORTUNIDADES accionables, priorizadas por impacto/esfuerzo:
- "quick_win": queries donde ya aparecemos en posición 5-20 → qué página reforzar y cómo
- "new_content": temas/keywords con demanda que NO cubrimos → título de artículo o página listo para escribir (en el idioma correcto del keyword)
- "page_fix": páginas existentes con impresiones pero CTR bajo → qué cambiar (title/meta)

Respondé SOLO JSON válido sin fences:
{"opportunities":[{"type":"quick_win|new_content|page_fix","keyword":"...","lang":"en|de|es","priority":1-10,"why":"<1-2 frases con el dato>","action":"<acción concreta; si es new_content: el TÍTULO exacto del artículo a escribir>"}]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return json({ error: "Anthropic " + res.status + ": " + (await res.text()).slice(0, 200) });
    const data = await res.json();
    let text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
    text = text.replace(/```json|```/g, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed: { opportunities?: unknown[] } | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.opportunities)) return json({ error: "La IA no devolvió oportunidades válidas." });
    return json({ site, queries: rows.length, opportunities: parsed.opportunities.slice(0, 15) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
