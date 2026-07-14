// Supabase Edge Function: ai-keywords
// KEYWORD RESEARCH: cruza las búsquedas REALES de Search Console (posiciones,
// clicks, impresiones) — y, cuando hay, los search terms reales de Google Ads
// (gads-stats) — con research de competencia vía Claude + búsqueda web, y
// devuelve oportunidades accionables priorizadas. Cada una se puede mandar
// directo a la cola del motor de contenido.
//
// SQL 0070/0071: las oportunidades ahora se acumulan (upsert por keyword+lang)
// en public.keyword_opportunities en vez de perderse al cerrar la tab — así
// esta misma función sirve tanto al botón manual del dashboard ("✨ Buscar
// oportunidades", con el JWT del usuario) como al cron semanal
// 'viven-keyword-research' (SQL 0071, sin usuario — net.http_post pelado).
//
// Deploy:   supabase functions deploy ai-keywords --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN (scope webmasters), ANTHROPIC_API_KEY,
//           SUPABASE_SERVICE_ROLE_KEY (para el upsert, RLS solo deja insertar
//           al service role — ver SQL 0070).

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    // auth: si viene con el JWT del dashboard, lo validamos (mismo patrón que
    // siempre); el cron semanal (SQL 0071) llama con net.http_post PELADO, sin
    // Authorization — como el resto de los crons de este proyecto (content-engine,
    // gsc-sitemap-submit) esa corrida no lleva usuario y es igual de válida: la
    // función no lee/escribe nada scoped a una persona, solo agrega a la cartera.
    const auth = req.headers.get("Authorization") ?? "";
    if (auth) {
      const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
    }

    // 0) señal opcional: search terms reales de Google Ads (gads-stats), si la
    // integración ya está configurada — best-effort, nunca tumba la corrida.
    // Si falla o no hay Ads conectado todavía, seguimos solo con GSC (source: 'gsc').
    let adsTerms: { term: string; clicks: number; cost: number }[] = [];
    try {
      const gr = await fetch(`${SB_URL}/functions/v1/gads-stats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: 30, search_terms: true }),
      });
      if (gr.ok) {
        const gd = await gr.json();
        if (Array.isArray(gd.search_terms)) adsTerms = gd.search_terms.slice(0, 40);
      }
    } catch { /* Ads no disponible — seguimos solo con GSC */ }
    const hasAds = adsTerms.length > 0;
    const adsLines = hasAds
      ? adsTerms.map((t) => `"${t.term}" — ${t.clicks} clicks, CHF ${t.cost.toFixed(2)}`).join("\n")
      : "";

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
${hasAds ? `\nSEARCH TERMS REALES de Google Ads (últimos 30 días — gente que ya está pagando clicks por esto):\n${adsLines}\n` : ""}
Usá la búsqueda web para revisar qué rankea la competencia suiza (p. ej. productoras de video en Zürich/Ginebra/Basilea, maybaum.ch, cognitives.ch, la-fabrica.ch u otras que encuentres) y detectá huecos.

Devolveme 8-12 OPORTUNIDADES accionables, priorizadas por impacto/esfuerzo:
- "quick_win": queries donde ya aparecemos en posición 5-20 → qué página reforzar y cómo
- "new_content": temas/keywords con demanda que NO cubrimos → título de artículo o página listo para escribir (en el idioma correcto del keyword)
- "page_fix": páginas existentes con impresiones pero CTR bajo → qué cambiar (title/meta)
${hasAds ? 'Si un keyword aparece TANTO en Search Console como en los search terms de Ads reales, marcá "source":"gsc+ads" (es la señal más fuerte — ya está pagando por eso). El resto queda en "source":"gsc".' : 'Marcá siempre "source":"gsc" (todavía no hay datos de Google Ads conectados).'}

Respondé SOLO JSON válido sin fences:
{"opportunities":[{"type":"quick_win|new_content|page_fix","keyword":"...","lang":"en|de|es","priority":1-10,"why":"<1-2 frases con el dato>","action":"<acción concreta; si es new_content: el TÍTULO exacto del artículo a escribir>","source":"gsc|gsc+ads"}]}`;

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
    const opportunities = parsed.opportunities.slice(0, 15) as {
      type?: string; keyword?: string; lang?: string; priority?: number; why?: string; action?: string; source?: string;
    }[];

    // acumular en la cartera (SQL 0070) — upsert por keyword+lang para no duplicar
    // si la misma oportunidad sale de nuevo en una corrida futura; solo pisamos los
    // campos "de contenido" (type/priority/why/action/source), nunca el status —
    // así una que ya se marcó accionada/descartada no vuelve a 'new' sola.
    try {
      const rowsToSave = opportunities.filter((o) => o.keyword && o.keyword.trim()).map((o) => ({
        keyword: o.keyword!.trim().toLowerCase(),
        lang: (o.lang || "en").toLowerCase(),
        type: ["quick_win", "new_content", "page_fix"].includes(o.type || "") ? o.type : "new_content",
        priority: Math.max(1, Math.min(10, Math.round(Number(o.priority) || 5))),
        why: o.why || null,
        action: o.action || null,
        source: o.source === "gsc+ads" ? "gsc+ads" : "gsc",
        updated_at: new Date().toISOString(),
      }));
      if (rowsToSave.length) {
        const { error: upErr } = await service.from("keyword_opportunities")
          .upsert(rowsToSave, { onConflict: "keyword,lang", ignoreDuplicates: false });
        if (upErr) console.error("KWOPP_UPSERT_ERROR", upErr.message);
      }
    } catch (e) {
      // nunca tumba la respuesta al botón manual por un problema de la tabla nueva
      console.error("KWOPP_SAVE_ERROR", String(e));
    }

    return json({ site, queries: rows.length, opportunities });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
