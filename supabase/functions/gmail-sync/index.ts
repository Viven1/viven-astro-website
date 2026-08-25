// Supabase Edge Function: gmail-sync
// Poll cada 5 min (cron 0045) de las 3 casillas reales (sebastian@, sofia@,
// info@viven.ch) — trae mensajes nuevos del INBOX que vinieron de un email
// que YA conocemos como lead, y los guarda en email_log (direction:'in') para
// que el hilo del contacto muestre también lo que el cliente contesta.
// Mensajes de gente que no es un lead conocido se ignoran (no son "clientes").
//
// Deploy: supabase functions deploy gmail-sync --no-verify-jwt
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (ya existen, mismo OAuth
//          client que Calendar/GSC/Ads), + GMAIL_REFRESH_TOKEN_SEBASTIAN,
//          GMAIL_REFRESH_TOKEN_SOFIA, GMAIL_REFRESH_TOKEN_INFO (nuevos —
//          ver instrucciones de autorización aparte).

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
// fix (auditoría 2026-07-14): invocable sin auth cada 5 min por cualquiera — quema
// cuota de la API de Gmail y puede forzar rate-limiting de Google sobre las cuentas
// reales conectadas. Cron-only, exige el secret compartido.
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const MAILBOXES = [
  { key: "sebastian", email: "sebastian@viven.ch", refreshSecret: "GMAIL_REFRESH_TOKEN_SEBASTIAN" },
  { key: "sofia", email: "sofia@viven.ch", refreshSecret: "GMAIL_REFRESH_TOKEN_SOFIA" },
  // info@viven.ch es un ALIAS (confirmado por Sebastián 2026-07-27), no una
  // casilla real — sus emails entran por el sync de sebastian/sofia. Sin token
  // propio a propósito; no listarlo evita un "sin_secret" permanente que
  // ensuciaba el monitoreo de crons.
];

async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("token_refresh_failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// deno-lint-ignore no-explicit-any
function findPart(p: any, mime: string): any {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return p;
  for (const part of p.parts || []) {
    const f = findPart(part, mime);
    if (f) return f;
  }
  return null;
}
// deno-lint-ignore no-explicit-any
function decodeBody(payload: any): string {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  const raw = plain || html;
  if (!raw?.body?.data) return "";
  const b64 = raw.body.data.replace(/-/g, "+").replace(/_/g, "/");
  let text = "";
  try { text = decodeURIComponent(escape(atob(b64))); } catch (_e) { text = atob(b64); }
  if (raw === html) text = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 20000);
}
/* ============ QUÉ NO VALE LA PENA PREGUNTAR ============
   Los remitentes desconocidos ya no se tiran: se encolan para que Sebastián decida
   si son clientes (SQL 0144). Pero encolar TODO convierte la lista en ruido y el
   ruido se aprende a ignorar, así que estas cosas ni siquiera preguntan:
     · direcciones que nadie lee ni contesta (noreply, notifications, mailer…)
     · lo que sale de nuestro propio dominio, incluido leads@viven.ch, que es el
       aviso de los formularios — esa gente ya entra al CRM por el formulario
     · cualquier cosa con List-Unsubscribe: todo newsletter legal lleva ese
       encabezado y ninguna persona escribiendo a mano lo tiene. Es la señal más
       limpia que hay para separar un correo masivo de una consulta real.
   Medido el 25 ago sobre 60 días de info@: de 201 hilos, aproximadamente la mitad
   era proveedores, outreach frío y avisos automáticos. */
const REMITENTE_AUTOMATICO = /(^|[._+-])(no-?reply|noreply|notifications?|mailer|bounce|postmaster|automated|do-?not-?reply|invoice|billing|support|newsletter)([._+-]|@)/i;
function valeLaPenaPreguntar(email: string, headers: { name: string; value: string }[]): boolean {
  if (!email || !email.includes("@")) return false;
  if (email.endsWith("@viven.ch")) return false;
  if (REMITENTE_AUTOMATICO.test(email)) return false;
  if (headers.some((h) => h.name.toLowerCase() === "list-unsubscribe")) return false;
  return true;
}
function parseFrom(headerVal: string): { name: string; email: string } {
  const m = headerVal.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].toLowerCase().trim() };
  return { name: "", email: headerVal.trim().toLowerCase() };
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const out: Record<string, unknown> = {};
    /* Ventana hacia atrás para llenar la cola de una vez con lo que ya llegó:
       {"backfill_days": 14}. Sin esto, la cola arranca vacía y se va poblando de a
       poco, y lo que entró la semana pasada nunca aparece. El cursor NO se toca en
       modo backfill: no queremos que una recuperación se coma el próximo ciclo. */
    const cuerpoReq = await req.json().catch(() => ({}));
    const backfillDias = Math.max(0, Math.min(90, +cuerpoReq.backfill_days || 0));
    const maxPorCasilla = backfillDias ? 200 : 30;
    const { data: leads } = await service.from("leads").select("id,email").not("email", "is", null);
    const leadByEmail = new Map<string, string>();
    (leads ?? []).forEach((l: { id: string; email: string }) => { if (l.email) leadByEmail.set(l.email.toLowerCase().trim(), String(l.id)); });

    for (const mb of MAILBOXES) {
      const refreshToken = Deno.env.get(mb.refreshSecret);
      if (!refreshToken) { out[mb.key] = "sin_secret_" + mb.refreshSecret; continue; }
      try {
        // el cursor para la PRÓXIMA corrida se calcula con la hora de ANTES de
        // arrancar a listar/leer mensajes (no la de después) — si tomáramos la
        // hora de después, un mensaje que llega a mitad de esta corrida (ya
        // pasó el listado de Gmail pero la corrida sigue laburando) quedaría
        // afuera de este batch Y del próximo (el cursor ya lo dejaría atrás)
        const runStartedAt = new Date();
        const token = await accessToken(refreshToken);
        const { data: st } = await service.from("gmail_sync_state").select("*").eq("mailbox", mb.key).maybeSingle();
        const sinceTs = backfillDias
          ? Math.floor((Date.now() - backfillDias * 24 * 3600e3) / 1000)
          : (st?.last_synced_at ? Math.floor(new Date(st.last_synced_at).getTime() / 1000) : Math.floor((Date.now() - 24 * 3600e3) / 1000));
        const q = encodeURIComponent(`in:inbox after:${sinceTs}`);
        const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=${maxPorCasilla}`, { headers: { Authorization: "Bearer " + token } });
        const listJ = await listRes.json();
        if (!listRes.ok) { out[mb.key] = "list_error: " + JSON.stringify(listJ).slice(0, 200); continue; }
        let matched = 0, seen = 0, encolados = 0;
        for (const m of listJ.messages ?? []) {
          seen++;
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: "Bearer " + token } });
          const msg = await msgRes.json();
          if (!msgRes.ok) continue;
          const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[];
          const fromH = headers.find((h) => h.name === "From")?.value || "";
          const subjH = headers.find((h) => h.name === "Subject")?.value || "";
          const { name, email } = parseFrom(fromH);
          const leadId = leadByEmail.get(email);
          if (!leadId) {
            /* Antes acá había un `continue` y el email se perdía. Ahora se encola
               para que Sebastián decida: crear la persona o descartarla. El insert
               choca contra el unique de gmail_id si ya estaba —eso es justamente lo
               que queremos— y contra los ya decididos no vuelve a preguntar. */
            if (!valeLaPenaPreguntar(email, headers)) continue;
            const { data: yaDecidido } = await service.from("email_pendientes")
              .select("id").eq("status", "ignorado").ilike("from_email", email).limit(1).maybeSingle();
            if (yaDecidido) continue;   // ya dijo que no es cliente: no se vuelve a preguntar
            const cuerpo = decodeBody(msg.payload) || msg.snippet || "";
            const fechaH = headers.find((h) => h.name === "Date")?.value;
            await service.from("email_pendientes").insert({
              gmail_id: m.id, mailbox: mb.key, from_email: email, from_name: name || null,
              subject: subjH, body: cuerpo,
              received_at: fechaH ? new Date(fechaH).toISOString() : new Date().toISOString(),
            }).then(() => { encolados++; }, () => {});   // duplicado = ya estaba, no es error
            continue;
          }
          const { data: exists } = await service.from("email_log").select("id").eq("source", "gmail-" + mb.key).eq("gmail_id", m.id).maybeSingle();
          if (exists) continue;
          const body = decodeBody(msg.payload) || msg.snippet || "";
          await service.from("email_log").insert({
            lead_id: leadId, to_addr: mb.email, subject: subjH, body,
            sender_label: name || email, source: "gmail-" + mb.key, direction: "in", gmail_id: m.id,
          });
          await service.from("leads").update({ last_reply_at: new Date().toISOString() }).eq("id", leadId).then(() => {}, () => {});
          matched++;
        }
        // en backfill el cursor no se mueve: si no, la recuperación se comería el próximo ciclo
        if (!backfillDias) await service.from("gmail_sync_state").upsert({ mailbox: mb.key, last_synced_at: runStartedAt.toISOString() });
        out[mb.key] = { seen, matched, encolados };
      } catch (e) {
        out[mb.key] = "error: " + String(e);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
