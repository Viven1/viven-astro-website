// Supabase Edge Function: push-send
// Manda una notificación push a los dispositivos del team (celular/compu):
// Web Push (VAPID) para la PWA en browser, y APNs para la app iOS nativa
// (WKWebView wrapper) — un mismo `to`/título/cuerpo sale por los dos caminos
// según qué tenga registrado cada usuario (push_subscriptions / device_tokens).
//
// Deploy:   supabase functions deploy push-send --no-verify-jwt
// Secrets:  supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=...
//           supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXX.p8)" APNS_KEY_ID=... APNS_TEAM_ID=... APNS_BUNDLE_ID=ch.viven.crm
//           APNS_ENV=development mientras la app corre sin TestFlight — pasar a production al distribuir por TestFlight/App Store.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { SignJWT, importPKCS8 } from "npm:jose@5";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY")!;

webpush.setVapidDetails("mailto:info@viven.ch", VAPID_PUB, VAPID_PRIV);

// APNs es opcional (best-effort) — si no están seteados los secrets todavía,
// simplemente no se manda por ese camino y Web Push sigue andando igual.
const APNS_KEY_P8 = Deno.env.get("APNS_KEY_P8");
const APNS_KEY_ID = Deno.env.get("APNS_KEY_ID");
const APNS_TEAM_ID = Deno.env.get("APNS_TEAM_ID");
const APNS_BUNDLE_ID = Deno.env.get("APNS_BUNDLE_ID") || "ch.viven.crm";
const APNS_ENV = Deno.env.get("APNS_ENV") || "development";
const apnsConfigured = !!(APNS_KEY_P8 && APNS_KEY_ID && APNS_TEAM_ID);

// Apple limita cuántas veces por hora se puede firmar un provider token nuevo
// (error "TooManyProviderTokenUpdates") — un JWT es válido ~1h, así que se
// firma UNA vez por invocación y se reusa para todos los device tokens del
// batch, nunca uno por dispositivo (bug real: 2026-07-31, mandaba 1 push a 3
// dispositivos y Apple rechazaba el 2do/3er JWT firmado en la misma corrida).
let cachedJwt: string | null = null;
async function apnsJWT(): Promise<string> {
  if (cachedJwt) return cachedJwt;
  const key = await importPKCS8(APNS_KEY_P8!.replace(/\\n/g, "\n"), "ES256");
  cachedJwt = await new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: APNS_KEY_ID! }).setIssuedAt().setIssuer(APNS_TEAM_ID!).sign(key);
  return cachedJwt;
}

const PROD = "api.push.apple.com", SANDBOX = "api.sandbox.push.apple.com";

async function enviarA(host: string, deviceToken: string, title: string, body: string, url: string): Promise<{ ok: boolean; deadReason?: string }> {
  const jwt = await apnsJWT();
  const res = await fetch(`https://${host}/3/device/${deviceToken}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-topic": APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
    },
    body: JSON.stringify({ aps: { alert: { title, body }, sound: "default" }, url }),
  });
  if (res.ok) return { ok: true };
  const errBody = await res.json().catch(() => ({}));
  return { ok: false, deadReason: (errBody as { reason?: string }).reason };
}

/* Un device token pertenece a UN entorno: el de TestFlight/App Store es de
 * producción, el que da un build corrido desde Xcode es de sandbox. Mandado al
 * entorno equivocado, Apple contesta BadDeviceToken y —peor— el token se
 * borraba de la base como si el dispositivo ya no existiera.
 *
 * Eso fue exactamente el bug del 14 ago 2026: el iPhone de Sebastián, con la
 * app de TestFlight, registraba su token, la primera notificación lo mandaba a
 * sandbox, Apple lo rechazaba y el token desaparecía. No llegaba ninguna push
 * y no quedaba rastro de por qué.
 *
 * Ahora, si el entorno configurado lo rechaza, se prueba el otro antes de dar
 * el token por muerto. Así conviven el teléfono con TestFlight y un build de
 * Xcode sin que ninguno de los dos rompa al otro. */
async function sendAPNs(deviceToken: string, title: string, body: string, url: string): Promise<{ ok: boolean; deadReason?: string }> {
  const primero = APNS_ENV === "production" ? PROD : SANDBOX;
  const segundo = primero === PROD ? SANDBOX : PROD;
  const r = await enviarA(primero, deviceToken, title, body, url);
  if (r.ok || r.deadReason !== "BadDeviceToken") return r;
  const r2 = await enviarA(segundo, deviceToken, title, body, url);
  if (r2.ok) console.log("APNS_OTRO_ENTORNO", segundo);   // el token era del otro entorno: no estaba muerto
  return r2;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // usuarios logueados del dashboard (celular/compu propios) O funciones
    // internas del server (automations-run/followup-send avisando de un
    // borrador nuevo) — mismo patrón de bypass que outbox-notify.
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${SB_SERVICE}`) {
      const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await supa.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
    }

    const { to, title, body, url, apnsOnly, debug } = await req.json();
    if (!title) return json({ error: "falta title" }, 400);

    const service = createClient(SB_URL, SB_SERVICE);
    const finalUrl = url || "/dashboard/";
    const payload = JSON.stringify({ title, body: body || "", url: finalUrl });
    let sent = 0, dead = 0, webPushSent = 0, apnsSent = 0;
    const apnsErrors: string[] = [];

    if (!apnsOnly) {
      let q = service.from("push_subscriptions").select("*");
      if (to) q = q.eq("user_email", String(to).toLowerCase());
      const { data: subs, error } = await q;
      if (error) return json({ error: error.message }, 500);
      for (const s of subs ?? []) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++; webPushSent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) { await service.from("push_subscriptions").delete().eq("id", s.id); dead++; }
        }
      }
    }

    if (apnsConfigured) {
      let dq = service.from("device_tokens").select("*").eq("platform", "ios");
      if (to) dq = dq.eq("user_email", String(to).toLowerCase());
      const { data: devices } = await dq;
      for (const d of devices ?? []) {
        try {
          const r = await sendAPNs(d.device_token, title, body || "", finalUrl);
          if (r.ok) { sent++; apnsSent++; }
          else {
            apnsErrors.push(r.deadReason || "unknown");
            if (r.deadReason === "BadDeviceToken" || r.deadReason === "Unregistered") { await service.from("device_tokens").delete().eq("id", d.id); dead++; }
          }
        } catch (e) { apnsErrors.push(String(e)); console.error("APNS_ERROR", String(e)); }
      }
    } else if (debug) {
      apnsErrors.push("apns not configured");
    }

    return json(debug ? { ok: true, sent, removed: dead, webPushSent, apnsSent, apnsConfigured, apnsErrors } : { ok: true, sent, removed: dead });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
