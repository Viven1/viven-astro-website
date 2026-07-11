// Supabase Edge Function: ai-enrich
// Enriquece un contacto con IA + búsqueda web EN VIVO (Claude web_search):
// info actual de la persona y su empresa — web, redes, noticias, y ganchos para la venta.
// El dashboard guarda el resultado en leads.enrichment (SQL 0021).
//
// Deploy:  supabase functions deploy ai-enrich --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado)

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { lead = {} } = await req.json();
    const name = (lead.name || "").trim();
    const company = (lead.company || "").trim();
    const domain = (lead.domain || "").trim();
    if (!name && !company && !domain) return json({ error: "Falta nombre o empresa del contacto." }, 400);

    const who = [
      name && `Person: "${name}"${lead.job_title ? ` (${lead.job_title})` : ""}`,
      lead.email && `Email: ${lead.email}`,
      (company || domain) && `Company: ${company || domain}${domain ? ` (website domain: ${domain})` : ""}`,
    ].filter(Boolean).join("\n");

    const prompt = `You are a B2B sales-research assistant for VIVEN AG, a video production company in Zürich, Switzerland. Research this LEAD using web search (search in English AND German — most prospects are Swiss):

${who}

Do 3-5 targeted searches: the company website/what they do, the person's LinkedIn/role, recent company news (funding, launches, hiring, events). Prioritize CURRENT info (2025-2026). If you can't find something, use null — NEVER invent facts, URLs or names.

Respond ONLY with valid minified JSON (no markdown):
{"persona":{"resumen":"2-3 frases sobre quién es y qué hace","cargo":null,"ubicacion":null,"linkedin":null,"redes":[{"tipo":"instagram|x|otro","url":"..."}]},
"empresa":{"nombre":"...","resumen":"2-3 frases: qué hace, tamaño, mercado","web":null,"industria":null,"empleados":null,"ubicacion":null,"redes":[{"tipo":"linkedin|instagram|youtube","url":"..."}],"noticias":[{"titulo":"...","url":"...","fecha":"YYYY-MM"}]},
"hooks":["2-4 ganchos CONCRETOS para la conversación de venta de video (ej: acaban de lanzar X → video de producto; están contratando mucho → employer branding)"],
"fuentes":["urls consultadas"]}
All text values in SPANISH (except names/titles). Max 3 noticias, the most recent.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 3500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) { const t = await res.text(); console.error("ANTHROPIC_ERROR", res.status, t); return json({ error: `Anthropic ${res.status}: ${t.slice(0, 200)}` }); }
    const data = await res.json();
    // con web search la respuesta trae varios bloques → tomar el ÚLTIMO bloque de texto
    const texts = (data.content || []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text);
    let text = (texts[texts.length - 1] || "").trim();
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first > -1 && last > first) text = text.slice(first, last + 1);
    let p: Record<string, unknown> | null = null;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || (!p.persona && !p.empresa)) return json({ error: "La IA no devolvió un resultado válido — probá de nuevo." });
    return json({ enrichment: p });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
