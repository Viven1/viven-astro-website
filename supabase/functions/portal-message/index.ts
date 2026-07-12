// Supabase Edge Function: portal-message (PÚBLICA)
// El cliente deja un comentario/feedback desde el portal. Valida el token,
// lo guarda como nota del contacto (aparece en el dashboard como cualquier
// otra nota) y avisa al equipo por push — nunca se pierde en un email suelto.
//
// Deploy: supabase functions deploy portal-message --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function pushAll(title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  const { data: subs } = await service.from("push_subscriptions").select("*");
  const payload = JSON.stringify({ title, body, url });
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await service.from("push_subscriptions").delete().eq("id", s.id); }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { id, t, message } = await req.json();
    if (!id || !t || !String(message || "").trim()) return json({ error: "missing_params" }, 400);
    const { data: deal, error } = await service.from("deals").select("id,title,portal_token,lead_id").eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!deal || !deal.portal_token || deal.portal_token !== t) return json({ error: "not_found" }, 404);

    let clientName = "Cliente";
    if (deal.lead_id) { const { data } = await service.from("leads").select("name,email").eq("id", deal.lead_id).maybeSingle(); if (data) clientName = data.name || data.email || clientName; }

    await service.from("lead_notes").insert({
      lead_id: deal.lead_id ? String(deal.lead_id) : null,
      author: clientName + " (portal)",
      body: String(message).trim().slice(0, 2000),
    });
    await pushAll("💬 Mensaje del cliente en el portal", clientName + " — " + (deal.title || "proyecto"), deal.lead_id ? `/dashboard/?lead=${deal.lead_id}` : "/dashboard/");
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
