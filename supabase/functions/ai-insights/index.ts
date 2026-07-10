// Supabase Edge Function: ai-insights
// Analiza el resumen de analytics + pipeline y devuelve 3–5 mejoras accionables (Claude).
// La llama el dashboard (usuario logueado). Devuelve { insights: [{icon,title,detail}] }.
//
// Deploy:  supabase functions deploy ai-insights --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado para ai-suggest)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { summary, lang = "es" } = await req.json();
    const language = lang === "de" ? "alemán" : lang === "en" ? "inglés" : "español";

    const prompt = `Sos un consultor de growth/marketing para Viven, una productora de video en Zúrich.
Te paso métricas reales del sitio (últimos días) y del pipeline de leads. Devolvé entre 3 y 5 mejoras CONCRETAS y accionables para conseguir más leads y cerrar más ventas — basadas SOLO en estos números, sin inventar. Priorizá impacto. En ${language}.

Respondé ÚNICAMENTE con un array JSON válido, sin texto extra, con este formato exacto:
[{"icon":"emoji","title":"título corto (máx 8 palabras)","detail":"1-2 frases con la acción concreta y por qué, citando el número relevante"}]

Datos:
${JSON.stringify(summary, null, 2)}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return json({ error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` });
    }
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    // por si viene envuelto en ```json ... ```
    const m = text.match(/\[[\s\S]*\]/);
    if (m) text = m[0];
    let insights;
    try { insights = JSON.parse(text); } catch { insights = null; }
    if (!Array.isArray(insights)) {
      console.error("PARSE_ERROR", text.slice(0, 300));
      return json({ error: "La IA no devolvió un JSON válido." });
    }
    return json({ insights: insights.slice(0, 5) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
