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
    /* El estado de producción vive en `projects` desde la SQL 0152 — antes eran
       columnas de `deals`, que es la tabla de VENTA, y ahí estuvieron en NULL en los
       197 deals: este portal nunca se encendió una sola vez. El token sigue en el deal
       porque es el handle público de la URL (/portal/?id=<deal_id>&t=<token>) y mover
       eso rompería cualquier link ya repartido. */
    const { data: deal, error } = await service.from("deals").select("id,title,portal_token,lead_id,stage").eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!deal || !deal.portal_token || !timingSafeEqual(String(deal.portal_token), String(t))) return json({ error: "not_found" }, 404);

    const { data: proj } = await service.from("projects")
      .select("title,stage,portal_note,deliverable_url,delivery_due").eq("deal_id", deal.id).maybeSingle();

    let client: { name?: string; lang?: string } | null = null;
    if (deal.lead_id) { const { data } = await service.from("leads").select("name,lang").eq("id", deal.lead_id).maybeSingle(); client = data; }

    return json({
      ok: true,
      title: proj?.title || deal.title,
      production_status: proj?.stage || "desarrollo",
      portal_note: proj?.portal_note || null,
      deliverable_url: proj?.deliverable_url || null,
      delivery_due: proj?.delivery_due || null,
      client_name: client?.name || null,
      lang: client?.lang || "en",
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
