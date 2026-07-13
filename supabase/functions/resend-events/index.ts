// Supabase Edge Function: resend-events
// Webhook para los eventos de Resend (email.opened) — el "vista" de las OFERTAS que
// pidió Sebastián: como las ofertas van por email (sin link público), "la vio" = abrió
// el email. send-offer taggea cada envío con offer_id; acá cada apertura estampa
// offers.last_open_at y el dashboard muestra "👁 abrió el email hace 2 h".
//
// Deploy:  supabase functions deploy resend-events --no-verify-jwt
// Config en Resend (dashboard, lo hace Sebastián):
//   1. Webhooks → Add endpoint → https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/resend-events
//      con el evento "email.opened" (con "email.clicked" también, si se quiere).
//   2. Guardar el signing secret como: supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxx
//      (si el secret no está seteado, se aceptan los eventos sin verificar — señal de
//      bajo riesgo, pero mejor setearlo).
//   3. En el dominio viven.ch de Resend: activar "Open tracking".

import { createClient } from "jsr:@supabase/supabase-js@2";
import { Webhook } from "npm:svix@1.24.0";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WH_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET") || "";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const raw = await req.text();
    let evt: any;
    if (WH_SECRET) {
      // verificación Svix (lo que usa Resend): sin firma válida, afuera
      try {
        const wh = new Webhook(WH_SECRET);
        evt = wh.verify(raw, {
          "svix-id": req.headers.get("svix-id") || "",
          "svix-timestamp": req.headers.get("svix-timestamp") || "",
          "svix-signature": req.headers.get("svix-signature") || "",
        });
      } catch (e) {
        console.error("BAD_SIGNATURE", String(e));
        return new Response("bad signature", { status: 401 });
      }
    } else {
      evt = JSON.parse(raw);
    }

    if (evt?.type !== "email.opened" && evt?.type !== "email.clicked") return new Response("ignored");
    const tags = evt?.data?.tags || {};
    // Resend entrega tags como objeto {offer_id: "123"} o como lista [{name,value}] según versión
    const offerId = tags.offer_id || (Array.isArray(tags) ? (tags.find((t: any) => t.name === "offer_id") || {}).value : null);
    if (!offerId) return new Response("no offer tag");

    const admin = createClient(SB_URL, SERVICE);
    const at = evt?.created_at || new Date().toISOString();
    const { error } = await admin.from("offers").update({ last_open_at: at }).eq("id", offerId);
    if (error) console.error("UPDATE_ERROR", error.message);
    return new Response("ok");
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response("error", { status: 500 });
  }
});
