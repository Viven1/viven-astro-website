// Supabase Edge Function: resend-events
// Webhook para los eventos de Resend (email.opened / email.clicked). Maneja
// varias fuentes según el tag del email:
//   • offer_id  → "la vio" de las OFERTAS (van por email, sin link público):
//                 cada apertura estampa offers.last_open_at.
//   • nl_id     → tracking del NEWSLETTER por destinatario: apertura → estampa
//                 newsletter_sends.opened_at; click → clicked_at (solo si null).
//                 Con eso el dashboard muestra % abrió / % click por campaña.
//   • issue_id  → lo mismo para la edición mensual automática (SQL 0114).
//   • magnet_id → el mail con el PDF del lead magnet (SQL 0132): estampa
//                 magnet_sends.opened_at / clicked_at.
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

    const TIPOS = ["email.opened", "email.clicked", "email.bounced", "email.complained"];
    if (!TIPOS.includes(evt?.type)) return new Response("ignored");
    const tags = evt?.data?.tags || {};
    // Resend entrega tags como objeto {offer_id: "123"} o como lista [{name,value}] según versión
    const tagVal = (k: string) => tags[k] || (Array.isArray(tags) ? (tags.find((t: any) => t.name === k) || {}).value : null);
    const offerId = tagVal("offer_id");
    const nlId = tagVal("nl_id");
    const issueId = tagVal("issue_id");   // edición mensual automática (SQL 0114)
    const welcomeId = tagVal("welcome_id");   // email de bienvenida del newsletter (SQL 0130)
    const magnetId = tagVal("magnet_id");     // el mail que lleva el PDF del lead magnet (SQL 0132)
    if (!offerId && !nlId && !issueId && !welcomeId && !magnetId) return new Response("no known tag");

    const admin = createClient(SB_URL, SERVICE);
    const at = evt?.created_at || new Date().toISOString();
    const toRaw0 = evt?.data?.to ?? evt?.data?.email;
    const recip0 = String(Array.isArray(toRaw0) ? (toRaw0[0] || "") : (toRaw0 || "")).toLowerCase().trim();

    /* Rebote o queja: la fila del envío queda marcada, y si es definitivo (rebote
       permanente o queja de spam) la persona sale de la lista. Seguir mandándole a
       una casilla que rebota o a alguien que nos marcó como spam empeora la entrega
       de TODOS los demás. (2 sep 2026: la edición 2026-09 tuvo 1 rebote.) */
    if (evt.type === "email.bounced" || evt.type === "email.complained") {
      const permanente = evt.type === "email.complained" || String(evt?.data?.bounce?.type || "").toLowerCase() === "permanent";
      const estado = evt.type === "email.complained" ? "complained" : "bounced";
      if (recip0 && (nlId || issueId)) {
        let q = admin.from("newsletter_sends").update({ status: estado }).eq("email", recip0);
        q = nlId ? q.eq("newsletter_id", nlId) : q.eq("issue_id", issueId);
        const { error } = await q; if (error) console.error("NL_BOUNCE_UPDATE_ERROR", error.message);
      }
      if (recip0 && permanente) {
        const { error } = await admin.from("leads").update({ unsubscribed: true }).ilike("email", recip0);
        if (error) console.error("LEAD_UNSUB_ERROR", error.message);
        console.log("NL_BAJA_AUTOMATICA", estado, recip0, evt?.data?.bounce?.subType || "");
      }
      return new Response("ok");
    }

    /* Click: además del "clickeó" (abajo), se guarda QUÉ link tocó cada persona.
       Sebastián, 2 sep 2026: "mostrá qué botones tocaron". */
    if (evt.type === "email.clicked" && (nlId || issueId) && recip0) {
      const link = String(evt?.data?.click?.link || "");
      if (link) {
        const { data: fila } = await admin.from("newsletter_sends").select("lead_id").eq("email", recip0).eq(nlId ? "newsletter_id" : "issue_id", nlId || issueId).maybeSingle();
        const { error } = await admin.from("newsletter_clicks").insert({
          newsletter_id: nlId || null, issue_id: issueId || null, email: recip0, lead_id: fila?.lead_id ?? null,
          link, at: evt?.data?.click?.timestamp || at, user_agent: String(evt?.data?.click?.userAgent || "").slice(0, 300),
        });
        if (error) console.error("NL_CLICK_INSERT_ERROR", error.message);
      }
    }

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
    // lead magnet: mismo patrón que la bienvenida — el id viaja en el tag y solo
    // se estampa la primera vez. Sin esto no hay forma de saber si el mail del
    // PDF se abre o si la gente se queda con la descarga y nada más.
    if (magnetId) {
      const col = evt.type === "email.clicked" ? "clicked_at" : "opened_at";
      const { error } = await admin.from("magnet_sends")
        .update({ [col]: at }).eq("id", magnetId).is(col, null);
      if (error) console.error("MAGNET_UPDATE_ERROR", error.message);
    }
    return new Response("ok");
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response("error", { status: 500 });
  }
});
