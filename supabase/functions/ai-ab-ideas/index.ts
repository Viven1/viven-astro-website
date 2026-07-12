// Supabase Edge Function: ai-ab-ideas
// Ideas de A/B testing para una página: recibe lo extraído (h1, lead, CTAs)
// y devuelve variantes concretas con su hipótesis. Para el tab A/B del dashboard.
//
// Deploy:  supabase functions deploy ai-ab-ideas --no-verify-jwt
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
    if (!user) return json({ error: "unauthorized (sesión no llegó a la función — probá refrescar el dashboard)" });

    const { url = "", h1 = "", lead = "", ctas = [], lang = "en" } = await req.json();
    const prompt = `Sos un experto en CRO (conversion rate optimization) para una productora de video B2B en Zúrich (viven.ch — clientes UBS, Siemens, Porsche; el objetivo de cada página es generar leads: form de contacto o book-a-call).

Página: ${url}
H1 actual: ${h1 || "(sin h1)"}
Párrafo lead actual: ${lead || "(sin lead)"}
CTAs actuales: ${(ctas || []).join(" · ") || "(sin CTAs)"}

Proponé 5 variantes para testear A/B, cada una sobre UN elemento (h1, lead o cta). El texto propuesto en el MISMO idioma que el original. Variá el ángulo: urgencia, prueba social, beneficio concreto, especificidad numérica, reducción de fricción.

Respondé SOLO con JSON válido:
{"ideas":[{"target":"h1|lead|cta","proposal":"<el texto nuevo exacto>","hypothesis":"<1 frase: por qué podría convertir mejor>"}]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1800, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return json({ error: "Anthropic " + res.status + ": " + (await res.text()).slice(0, 200) });
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim().replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed: { ideas?: unknown[] } | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.ideas)) return json({ error: "La IA no devolvió ideas válidas." });
    return json({ ideas: parsed.ideas.slice(0, 6) });
  } catch (e) {
    return json({ error: String(e) });
  }
});
