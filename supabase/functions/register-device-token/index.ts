// Supabase Edge Function: register-device-token
// La app iOS nativa (WKWebView wrapper) registra su device token de APNs acá
// para que push-send pueda mandarle notificaciones push reales (draft nuevo
// para aprobar, tarea asignada, etc.) — separado de push_subscriptions
// (Web Push/VAPID de la PWA en browser).
//
// La llama el JS del dashboard (mismo JWT del usuario logueado), no Swift
// directo — Swift solo tiene el device token, no la sesión de Supabase; se lo
// pasa al webview vía evaluateJavaScript() y el dashboard hace el invoke.
//
// Deploy: supabase functions deploy register-device-token --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supa.auth.getUser();
    if (!user?.email) return json({ error: "unauthorized" }, 401);

    const { device_token, platform = "ios" } = await req.json();
    if (!device_token || typeof device_token !== "string") return json({ error: "falta device_token" }, 400);

    const service = createClient(SB_URL, SB_SERVICE);
    const { error } = await service.from("device_tokens").upsert(
      { user_email: user.email.toLowerCase(), platform, device_token, updated_at: new Date().toISOString() },
      { onConflict: "device_token" },
    );
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
