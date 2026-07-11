// Supabase Edge Function: ai-suggest
// Genera SOLO la frase personalizada (el "hook"/proof) para el email de follow-up.
// El dashboard arma el resto del email (saludo, 2 CTAs: llamada + brief, firma) con código,
// así la IA NUNCA se olvida de las metas, el video call ni el brief.
// La llama el dashboard (con el JWT del usuario logueado) → devuelve { proof }.
//
// Deploy:  supabase functions deploy ai-suggest --no-verify-jwt
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
//
// Costo: ~USD 0.003–0.01 por llamada con Claude Haiku. Es por uso, no fijo.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Verificar que quien llama es un usuario autenticado del dashboard
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

    const { lead, lang = "es" } = await req.json();
    const language = lang === "de" ? "alemán" : lang === "en" ? "inglés" : "español";

    // La IA devuelve UNA sola frase de contexto/prueba, adaptada al mensaje del lead.
    // Se inserta en la plantilla así:  "Para que nos ubiques: <FRASE>."  (o su equivalente en/de)
    const prompt = `Sos el asistente de ventas de Viven, una productora de video en Zúrich (clientes: UBS, Siemens, Porsche, ON, V-ZUG, Franke, Philips, KPMG).
Te paso el mensaje de un lead. Devolvé UNA sola frase (máx 25 palabras), en ${language}, que sirva como prueba/gancho creíble y específica al interés del lead, para insertar después de "Para que nos ubiques:" / "For context:" / "Zur Einordnung:".

Reglas ESTRICTAS:
- SOLO la frase, sin comillas, sin punto final, sin saludo, sin CTA, sin firma, sin explicación.
- Referí a nuestra experiencia/casos reales relevantes a lo que pide; no inventes cifras que no sean plausibles.
- Debe encajar gramaticalmente como continuación de "Para que nos ubiques: ...".

Mensaje del lead: ${lead?.message || "(no dejó mensaje)"}
Canal: ${lead?.channel || "directo"}${lead?.utm_campaign ? " · campaña " + lead.utm_campaign : ""}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const data = await res.json();
    // limpiar comillas / punto final que a veces agrega el modelo
    const proof = (data.content?.[0]?.text ?? "").trim().replace(/^["'«»]|["'«».]$/g, "").trim();
    return new Response(JSON.stringify({ proof }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { headers: { ...cors, "Content-Type": "application/json" } });
  }
});
