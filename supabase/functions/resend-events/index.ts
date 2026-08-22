// Supabase Edge Function: resend-events
// Webhook para los eventos de Resend (email.opened / email.clicked). Maneja
// varias fuentes según el tag del email:
//   • offer_id  → "la vio" de las OFERTAS (van por email, sin link público):
//                 cada apertura estampa offers.last_open_at.
//   • nl_id     → tracking del NEWSLETTER por destinatario: apertura → estampa
//                 newsletter_sends.opened_at; click → clicked_at (solo si null).
//                 Con eso el dashboard muestra % abrió / % click por campaña.
//   • issue_id  → lo mismo para la edición mensual automática (SQL 0114).
//   • welcome_id → el email de bienvenida del newsletter (SQL 0130): estampa
//                 newsletter_welcomes.opened_at / clicked_at. Es el único
//                 número que dice si esa bienvenida sirve para algo.
//
// Deploy:  supabase functions deploy resend-events --no-verify-jwt
// Config en Resend (dashboard, lo hace Sebastián):
//   1. Webhooks → Add endpoint → https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/resend-events
//      con los eventos "email.opened" y "email.clicked".
//   2. Guardar el signing secret como: supabase secrets set RESEND_WEBHOOK_SECRET=whsec_xxx
//      (si el secret no está seteado, se aceptan los eventos sin verificar — señal de
//      bajo riesgo, pero mejor setearlo).
//   3. En el dominio viven.ch de Resend: activar "Open tracking" Y "Click tracking"
//      (sin ambos activados, opened_at/clicked_at NUNCA se llenan aunque el webhook llegue).

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
    const tagVal = (k: string) => tags[k] || (Array.isArray(tags) ? (tags.find((t: any) => t.name === k) || {}).value : null);
    const offerId = tagVal("offer_id");
    const nlId = tagVal("nl_id");
    const issueId = tagVal("issue_id");   // edición mensual automática (SQL 0114)
    const welcomeId = tagVal("welcome_id");   // email de bienvenida del newsletter (SQL 0130)
    if (!offerId && !nlId && !issueId && !welcomeId) return new Response("no known tag");

    const admin = createClient(SB_URL, SERVICE);
    const at = evt?.created_at || new Date().toISOString();

    if (offerId) {
      const { error } = await admin.from("offers").update({ last_open_at: at }).eq("id", offerId);
      if (error) console.error("UPDATE_ERROR", error.message);
    }

    if (nlId || issueId) {
      // el destinatario viene como data.to (array) o data.email según el shape del evento
      const toRaw = evt?.data?.to ?? evt?.data?.email;
      const recip = String(Array.isArray(toRaw) ? (toRaw[0] || "") : (toRaw || "")).toLowerCase().trim();
      if (recip) {
        const col = evt.type === "email.clicked" ? "clicked_at" : "opened_at";
        // solo estampar si está null (primera apertura/click) — campañas por
        // newsletter_id, ediciones mensuales por issue_id (SQL 0114)
        let q = admin.from("newsletter_sends").update({ [col]: at }).eq("email", recip).is(col, null);
        q = nlId ? q.eq("newsletter_id", nlId) : q.eq("issue_id", issueId);
        const { error } = await q;
        if (error) console.error("NL_UPDATE_ERROR", error.message);
      }
    }

    // bienvenida del newsletter: el id de la fila viaja en el tag, así que no
    // hace falta buscar por email. Solo la primera apertura/click (is null),
    // igual que arriba — el número que importa es cuánta gente lo abre, no
    // cuántas veces lo abre la misma persona.
    if (welcomeId) {
      const col = evt.type === "email.clicked" ? "clicked_at" : "opened_at";
      const { error } = await admin.from("newsletter_welcomes")
        .update({ [col]: at }).eq("id", welcomeId).is(col, null);
      if (error) console.error("WELCOME_UPDATE_ERROR", error.message);
    }
    return new Response("ok");
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response("error", { status: 500 });
  }
});
