// Supabase Edge Function: get-portal (PÚBLICA)
// Devuelve el estado de un proyecto para el portal del cliente — valida el
// token server-side y solo expone campos seguros para el cliente (nunca
// deal_value, costos internos, notas del equipo, etc.)
//
// Deploy: supabase functions deploy get-portal --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
// comparación en tiempo constante — el token es el único control de acceso acá
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { id, t } = await req.json();
    if (!id || !t) return json({ error: "missing_params" }, 400);
    const { data: deal, error } = await service.from("deals").select("id,title,production_status,portal_note,deliverable_url,portal_token,lead_id,stage").eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!deal || !deal.portal_token || !timingSafeEqual(String(deal.portal_token), String(t))) return json({ error: "not_found" }, 404);

    let client: { name?: string; lang?: string } | null = null;
    if (deal.lead_id) { const { data } = await service.from("leads").select("name,lang").eq("id", deal.lead_id).maybeSingle(); client = data; }

    return json({
      ok: true,
      title: deal.title,
      production_status: deal.production_status || "pre_production",
      portal_note: deal.portal_note || null,
      deliverable_url: deal.deliverable_url || null,
      client_name: client?.name || null,
      lang: client?.lang || "en",
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
