// Supabase Edge Function: ai-suggest
// Genera un mensaje de follow-up personalizado con la API de Claude.
// La llama el dashboard (con el JWT del usuario logueado) → devuelve { suggestion }.
//
// Deploy:  supabase functions deploy ai-suggest   (verify-jwt ON por defecto → solo usuarios logueados)
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
//
// Costo: ~USD 0.003–0.01 por sugerencia con Claude Haiku. Es por uso, no fijo.

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

    const { lead, lang = "es", tone = "cálido y profesional" } = await req.json();
    const name = lead?.first_name || (lead?.name || "").split(" ")[0] || "";
    const days = lead?.contacted_at
      ? Math.max(0, Math.round((Date.now() - Date.parse(lead.contacted_at)) / 864e5))
      : null;

    const prompt = `Sos el asistente de ventas de Viven, una productora de video en Zúrich.
Escribí un email de follow-up ${tone}, breve (máx 90 palabras), en ${lang === "de" ? "alemán" : lang === "en" ? "inglés" : "español"}, para este lead. No inventes datos. Incluí un CTA claro (agendar una llamada de 15 min). No uses asunto, solo el cuerpo.

Datos del lead:
- Nombre: ${name || "desconocido"}
- Mensaje original: ${lead?.message || "(no dejó mensaje)"}
- Estado: ${lead?.status || "new"}
- Días desde el primer contacto: ${days ?? "aún no contactado"}
- Interés/canal: ${lead?.channel || "directo"}${lead?.utm_campaign ? " · campaña " + lead.utm_campaign : ""}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return new Response(await res.text(), { status: 502, headers: cors });
    const data = await res.json();
    const suggestion = (data.content?.[0]?.text ?? "").trim();
    return new Response(JSON.stringify({ suggestion }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: cors });
  }
});
