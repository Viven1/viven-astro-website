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

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const service = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
/* ============ SOLO LO QUE VINO A info@ ============
   La primera versión encolaba cualquier remitente desconocido de cualquiera de las
   dos casillas, y eso mezclaba las consultas de la dirección pública con el correo
   personal de Sebastián y de Sofia. (Él lo cazó mirando la lista: "¿seguro que esos
   emails vienen de info? me parece que mezclás Sofia con Viven y los míos".)
   Tenía razón, y el error era mío: guardaba de qué CASILLA salió el mensaje, no a
   qué DIRECCIÓN estaba dirigido — y como info@viven.ch entrega en la casilla de
   Sebastián, las dos cosas caen en el mismo lugar.
   Ahora se mira a quién iba de verdad: To, Cc y Delivered-To. Si info@ no está ahí,
   no es una consulta a la empresa y no se pregunta. */
const BUZON_PUBLICO = "info@viven.ch";
function vinoAlBuzonPublico(headers: { name: string; value: string }[]): boolean {
  const relevantes = ["to", "cc", "delivered-to", "x-original-to", "x-forwarded-to"];
  return headers.some((h) =>
    relevantes.includes(h.name.toLowerCase()) && h.value.toLowerCase().includes(BUZON_PUBLICO));
}

const REMITENTE_AUTOMATICO = /(^|[._+-])(no-?reply|noreply|notifications?|mailer|bounce|postmaster|automated|do-?not-?reply|invoice|billing|support|newsletter)([._+-]|@)/i;
function valeLaPenaPreguntar(email: string, headers: { name: string; value: string }[]): boolean {
  if (!email || !email.includes("@")) return false;
  if (email.endsWith("@viven.ch")) return false;
  if (REMITENTE_AUTOMATICO.test(email)) return false;
  if (headers.some((h) => h.name.toLowerCase() === "list-unsubscribe")) return false;
  return true;
}
/* Todos los destinatarios de un mensaje (To + Cc), en minúscula. Sirve para los
   ENVIADOS: ahí el cliente no es quien escribe, es a quien le escribimos. */
function destinatarios(headers: { name: string; value: string }[]): string[] {
  const crudo = headers.filter((h) => ["to", "cc"].includes(h.name.toLowerCase())).map((h) => h.value).join(",");
  return [...new Set((crudo.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))];
}
function parseFrom(headerVal: string): { name: string; email: string } {
  const m = headerVal.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].toLowerCase().trim() };
  return { name: "", email: headerVal.trim().toLowerCase() };
}

Deno.serve(async (req) => {
  /* El preflight se contesta ANTES del chequeo de auth: un OPTIONS no lleva el
     Authorization y devolvía 403, así que cualquier llamada desde el navegador moría
     antes de empezar. Hasta hoy no molestaba porque solo la llamaba el cron (que no
     hace preflight), pero el botón de rescate de la ficha sí la llama desde ahí. */
  /* La lista TIENE que incluir x-client-info y apikey: son los que manda el cliente de
   supabase-js en cada invoke(). Con solo "authorization, content-type" el navegador
   bloquea el POST y en pantalla se lee "Failed to send a request to the Edge Function",
   que no menciona CORS por ningún lado. Pasó el 26 ago 2026 con las facturas de bexio. */
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  /* Y vale el JWT del dashboard además del cron_secret: rescatar los emails de una
     persona es una acción de la pantalla, no del cron. */
  const auth = req.headers.get("Authorization") ?? "";
  let permitido = !CRON_SECRET || auth === `Bearer ${CRON_SECRET}`;
  if (!permitido) {
    try {
      const sb = createClient(SB_URL, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await sb.auth.getUser();
      permitido = !!user;
    } catch (e) {
      /* SB_URL no estaba declarado en este archivo, así que esta línea tiraba un
         ReferenceError… que este mismo catch se tragaba y convertía en permitido=false.
         Resultado: el botón "⟳ Buscar emails" de la ficha devolvía 403 SIEMPRE, en
         silencio. El cron seguía andando porque entra por el cron_secret y nunca llega
         hasta acá — por eso nadie lo notó.
         El catch se queda (una sesión vencida tiene que dar 403, no 500), pero ahora
         deja rastro: un fallo acá vuelve a ser invisible si no se loguea. */
      console.error("GMAIL_SYNC_AUTH_FALLO", String(e));
      permitido = false;
    }
  }
  if (!permitido) return new Response("forbidden", { status: 403, headers: cors });
  try {
    const out: Record<string, unknown> = {};
    /* Ventana hacia atrás para llenar la cola de una vez con lo que ya llegó:
       {"backfill_days": 14}. Sin esto, la cola arranca vacía y se va poblando de a
       poco, y lo que entró la semana pasada nunca aparece. El cursor NO se toca en
       modo backfill: no queremos que una recuperación se coma el próximo ciclo. */
    const cuerpoReq = await req.json().catch(() => ({}));
    const backfillDias = Math.max(0, Math.min(90, +cuerpoReq.backfill_days || 0));
    const maxPorCasilla = backfillDias ? 200 : 30;
    /* ================= MODO RESCATE: todos los emails de UNA persona =================
       El sync normal solo mira desde el último cursor, así que hay tres formas de que
       un email nunca llegue a la ficha, y las tres pasan seguido:
         · llegó ANTES de que la persona existiera en el CRM (el caso típico: escribe
           a info@, la aprobás dos días después, y sus emails viejos ya pasaron),
         · entraron más de 30 en una misma corrida y el cursor avanzó igual,
         · el sync estuvo caído un rato.
       Con {lead_id} o {email} se busca en Gmail por esa dirección SIN límite de fecha
       y se trae todo lo que falte, entrante y saliente. Sebastián, 25 ago: "mirá que
       todos los emails siempre entren a la persona, si no no sirve de nada eso".
       Es idempotente: lo que ya está se saltea por gmail_id. */
    const json = (b: unknown, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { ...cors, "Content-Type": "application/json" } });

    /* Rescate en tanda: el mismo modo pero para varios contactos de una. Sirve para
       tapar el agujero histórico de una vez —los emails que quedaron afuera antes de
       que existiera este modo— sin tener que entrar contacto por contacto.
       Se salta la cartera de bexio: son clientes de facturas viejas, no gente con la
       que haya una conversación por email que rescatar. */
    if (cuerpoReq.rescatar_todos) {
      const limite = Math.max(1, Math.min(60, +cuerpoReq.limite || 20));
      const desde = Math.max(0, +cuerpoReq.desde || 0);
      const { data: gente } = await service.from("leads").select("id,email,channel")
        .not("email", "is", null).order("id").range(desde, desde + limite - 1);
      const cands = (gente ?? []).filter((l: { email?: string; channel?: string }) =>
        l.email && !/bexio/i.test(l.channel ?? ""));
      const resumen: { lead: string; traidos: number }[] = [];
      for (const l of cands) {
        const r = await fetch(new URL(req.url).toString(), {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: req.headers.get("Authorization") ?? "" },
          body: JSON.stringify({ lead_id: l.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.traidos) resumen.push({ lead: String(l.id), traidos: j.traidos });
      }
      return json({ ok: true, modo: "rescate_tanda", mirados: cands.length, desde,
        siguiente: desde + limite, con_novedades: resumen });
    }

    if (cuerpoReq.lead_id || cuerpoReq.email) {
      let quien = String(cuerpoReq.email || "").toLowerCase().trim();
      let leadId = cuerpoReq.lead_id ? String(cuerpoReq.lead_id) : null;
      if (!quien && leadId) {
        const { data: l } = await service.from("leads").select("email").eq("id", leadId).maybeSingle();
        quien = String(l?.email || "").toLowerCase().trim();
      }
      if (!quien) return json({ error: "esa persona no tiene email" }, 400);
      if (!leadId) {
        const { data: l } = await service.from("leads").select("id").ilike("email", quien).maybeSingle();
        leadId = l?.id ? String(l.id) : null;
      }
      if (!leadId) return json({ error: "no encontré a esa persona en el CRM" }, 404);
      let traidos = 0, revisados = 0;
      for (const mb of MAILBOXES) {
        const rt = Deno.env.get(mb.refreshSecret); if (!rt) continue;
        try {
          const tok = await accessToken(rt);
          const q = encodeURIComponent(`{from:${quien} to:${quien} cc:${quien}}`);
          let page = "";
          for (let vuelta = 0; vuelta < 6; vuelta++) {   // hasta 600 mensajes por casilla
            const lr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100${page ? "&pageToken=" + page : ""}`, { headers: { Authorization: "Bearer " + tok } });
            const lj = await lr.json();
            if (!lr.ok) break;
            for (const m of lj.messages ?? []) {
              revisados++;
              const { data: ya } = await service.from("email_log").select("id").eq("gmail_id", m.id).maybeSingle();
              if (ya) continue;
              const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: "Bearer " + tok } });
              const msg = await mr.json(); if (!mr.ok) continue;
              const hs = (msg.payload?.headers ?? []) as { name: string; value: string }[];
              const { name, email } = parseFrom(hs.find((h) => h.name === "From")?.value || "");
              const subj = hs.find((h) => h.name === "Subject")?.value || "";
              const fecha = hs.find((h) => h.name === "Date")?.value;
              // si lo escribió la persona es entrante; si lo escribimos nosotros, saliente
              const entrante = email === quien;
              await service.from("email_log").insert({
                lead_id: leadId, to_addr: entrante ? mb.email : quien, subject: subj,
                body: decodeBody(msg.payload) || msg.snippet || "",
                sender_label: entrante ? (name || email) : mb.email,
                source: "gmail-" + mb.key, direction: entrante ? "in" : "out", gmail_id: m.id,
                created_at: fecha ? new Date(fecha).toISOString() : new Date().toISOString(),
              }).then(() => { traidos++; }, () => {});
            }
            page = lj.nextPageToken || "";
            if (!page) break;
          }
        } catch (e) { /* una casilla que falla no tumba la otra */ }
      }
      return json({ ok: true, modo: "rescate", email: quien, lead_id: leadId, revisados, traidos });
    }

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
        /* Si Gmail devuelve más de los que entran en un batch, el cursor NO se mueve:
           en la próxima corrida se vuelve a mirar desde el mismo punto y se termina el
           resto. Antes el cursor avanzaba igual, así que un pico de más de 30 emails
           en cinco minutos perdía los que sobraban PARA SIEMPRE — sin error, sin
           aviso, y sin forma de notarlo salvo que faltara justo el que buscabas. */
        const quedaronAfuera = !!listJ.nextPageToken;
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
          /* Nunca guardar como "escribió el cliente" un email escrito por nosotros.
             Sin esto, un mensaje interno de Sebastián a Sofia entraba al historial de
             un lead como si lo hubiera mandado el cliente — y el popup de follow-up
             se lo mostraba con el cartel "LO ÚLTIMO QUE ESCRIBIÓ", firma incluida.
             (Captura de Sebastián, 25 ago.) Las de prueba, igual: son suyas. */
          const CORREOS_PRUEBA = ["cepeda.sebastian@gmail.com"];
          if (email.endsWith("@viven.ch") || CORREOS_PRUEBA.includes(email)) continue;
          const leadId = leadByEmail.get(email);
          if (!leadId) {
            /* Antes acá había un `continue` y el email se perdía. Ahora se encola
               para que Sebastián decida: crear la persona o descartarla. El insert
               choca contra el unique de gmail_id si ya estaba —eso es justamente lo
               que queremos— y contra los ya decididos no vuelve a preguntar. */
            if (!vinoAlBuzonPublico(headers)) continue;   // correo personal: no es del CRM
            if (!valeLaPenaPreguntar(email, headers)) continue;
            const { data: yaDecidido } = await service.from("email_pendientes")
              .select("id").eq("status", "ignorado").ilike("from_email", email).limit(1).maybeSingle();
            if (yaDecidido) continue;   // ya dijo que no es cliente: no se vuelve a preguntar
            const cuerpo = decodeBody(msg.payload) || msg.snippet || "";
            const fechaH = headers.find((h) => h.name === "Date")?.value;
            await service.from("email_pendientes").insert({
              gmail_id: m.id, mailbox: mb.key, para: BUZON_PUBLICO, from_email: email, from_name: name || null,
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
        /* ================= LO QUE MANDAMOS NOSOTROS =================
           El sync leía solo la bandeja de ENTRADA, así que la ficha de un contacto
           mostraba media conversación: lo que él escribió, nunca lo que le
           contestamos. Sebastián, 25 ago: "a Jason Kendirian le mandé una oferta por
           Gmail y no se ve en el contacto". Efectivamente — en su ficha estaban los
           dos emails de Jason y ninguno de los dos que le mandó Sebastián.
           Acá el cliente no es quien escribe sino a quién le escribimos, así que se
           busca por los destinatarios (To + Cc). Y NO se encola nada: alguien a quien
           le escribimos y no está en el CRM no es una consulta entrante — es un email
           nuestro, y preguntarlo llenaría la cola de gente que ya conocemos. */
        let enviados = 0;
        try {
          const qs = encodeURIComponent(`in:sent after:${sinceTs}`);
          const lsRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${qs}&maxResults=${maxPorCasilla}`, { headers: { Authorization: "Bearer " + token } });
          const lsJ = await lsRes.json();
          for (const m of (lsRes.ok ? lsJ.messages ?? [] : [])) {
            const { data: ya } = await service.from("email_log").select("id").eq("gmail_id", m.id).maybeSingle();
            if (ya) continue;
            const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: "Bearer " + token } });
            const msg = await msgRes.json();
            if (!msgRes.ok) continue;
            const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[];
            const subjH = headers.find((h) => h.name === "Subject")?.value || "";
            // el primer destinatario que SÍ es un contacto del CRM
            const destino = destinatarios(headers).find((e) => !e.endsWith("@viven.ch") && leadByEmail.has(e));
            if (!destino) continue;
            const cuerpo = decodeBody(msg.payload) || msg.snippet || "";
            const fechaH = headers.find((h) => h.name === "Date")?.value;
            await service.from("email_log").insert({
              lead_id: leadByEmail.get(destino), to_addr: destino, subject: subjH, body: cuerpo,
              sender_label: mb.email, source: "gmail-" + mb.key, direction: "out", gmail_id: m.id,
              created_at: fechaH ? new Date(fechaH).toISOString() : new Date().toISOString(),
            }).then(() => { enviados++; }, () => {});
          }
        } catch (e) { /* si falla el pase de enviados, el de entrada ya hizo lo suyo */ }

        // en backfill el cursor no se mueve: si no, la recuperación se comería el próximo ciclo
        if (!backfillDias && !quedaronAfuera) await service.from("gmail_sync_state").upsert({ mailbox: mb.key, last_synced_at: runStartedAt.toISOString() });
        out[mb.key] = { seen, matched, encolados, enviados, quedaron_afuera: quedaronAfuera };
      } catch (e) {
        out[mb.key] = "error: " + String(e);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...out }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
