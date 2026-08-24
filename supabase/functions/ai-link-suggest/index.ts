// Supabase Edge Function: ai-link-suggest
// Sub-tab Search Console → ⚔️ Canibalización: sugiere CÓMO linkear internamente
// desde la página más débil hacia la que ya gana en Google para una búsqueda,
// para reforzarle a Google cuál página debería rankear. Solo SUGIERE — no edita
// ni commitea nada, Sebastián lo aplica a mano en el .astro correspondiente
// (pedido explícito: "sugerir el link, yo lo apruebo").
//
// La llama el dashboard (con el JWT del usuario logueado) → { anchor, snippet, placement }.
//
// Deploy:  supabase functions deploy ai-link-suggest --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado)
// Costo: ~USD 0.003–0.01 por llamada con Claude Haiku.

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
  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    const { query, weakUrl, weakTitle, weakDesc, strongUrl, strongTitle } = await req.json();
    if (!query || !weakUrl || !strongUrl) return json({ error: "faltan datos (query/weakUrl/strongUrl)" }, 400);

    const prompt = `Sos el SEO de Viven, una productora de video en Zúrich. Detectamos canibalización en Search Console: dos páginas del sitio compiten por la misma búsqueda y eso le resta fuerza a la que debería ganar.

Búsqueda en cuestión: "${query}"

Página que YA gana en Google (hay que reforzarla): ${strongUrl}${strongTitle ? ` — title actual: "${strongTitle}"` : ""}

Página más débil, DESDE la que hay que agregar el link interno: ${weakUrl}${weakTitle ? ` — title actual: "${weakTitle}"` : ""}${weakDesc ? ` — descripción: "${weakDesc}"` : ""}

Sugerí un link interno natural desde la página débil hacia la fuerte, con anchor text cercano a la búsqueda "${query}" (sin ser spam de keyword exacta).

Devolvé SOLO un JSON válido, sin texto antes ni después, con este formato exacto:
{"anchor":"texto del link, 3-6 palabras","snippet":"una oración completa en español mostrando el anchor en contexto natural, lista para insertar en la página débil","placement":"dónde insertarlo dentro de esa página, en pocas palabras"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return json({ error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` });
    }
    const data = await res.json();
    const raw = (data.content?.[0]?.text ?? "").trim();
    let parsed: { anchor?: string; snippet?: string; placement?: string } = {};
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (_e) {
      return json({ error: "La IA no devolvió JSON válido", raw });
    }
    if (!parsed.anchor || !parsed.snippet) return json({ error: "La IA devolvió un JSON incompleto", raw });
    return json({ anchor: parsed.anchor, snippet: parsed.snippet, placement: parsed.placement || "" });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
