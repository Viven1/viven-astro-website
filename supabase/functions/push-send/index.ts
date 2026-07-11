// Supabase Edge Function: push-send
// Manda una notificación Web Push a los dispositivos del team (celular/compu).
// La llama el dashboard (usuario logueado): menciones, tasks asignadas, etc.
//
// Deploy:   supabase functions deploy push-send --no-verify-jwt
// Secrets:  supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:info@viven.ch", VAPID_PUB, VAPID_PRIV);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // solo usuarios logueados del dashboard pueden disparar pushes
    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { to, title, body, url } = await req.json();
    if (!title) return json({ error: "falta title" }, 400);

    const service = createClient(SB_URL, SB_SERVICE);
    let q = service.from("push_subscriptions").select("*");
    if (to) q = q.eq("user_email", String(to).toLowerCase());
    const { data: subs, error } = await q;
    if (error) return json({ error: error.message }, 500);

    const payload = JSON.stringify({ title, body: body || "", url: url || "/dashboard/" });
    let sent = 0, dead = 0;
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { await service.from("push_subscriptions").delete().eq("id", s.id); dead++; }
      }
    }
    return json({ ok: true, sent, removed: dead });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
