// Supabase Edge Function: booking-create (PÚBLICA)
// Crea la reserva: evento en el Google Calendar de Viven con Google Meet e
// invitación automática al cliente (sendUpdates=all). Después sincroniza el CRM:
// persona → etapa "videocall" (o la crea), cancela follow-ups pendientes,
// registra la reserva en bookings y avisa al equipo por push.
//
// Deploy:   supabase functions deploy booking-create --no-verify-jwt
// Secrets:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GCAL_ID (opcional)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// 📚 Plantillas (SQL 0062): si existe email_templates(key='booking_confirmation',
// lang), su subject/body pisan el saludo+parrafo de confirmación de abajo
// (tokens {{first_name}}/{{when}}/{{duration}}). Sin fila → default de siempre.
// Lookup defensivo: tabla ausente/error = mismo camino que "sin fila".
async function getTemplate(key: string, lang: string): Promise<{ subject: string; body: string } | null> {
  try {
    const { data, error } = await service.from("email_templates").select("subject,body").eq("key", key).eq("lang", lang).maybeSingle();
    if (error || !data || !data.subject || !data.body) return null;
    return data as { subject: string; body: string };
  } catch (_e) { return null; }
}
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// slug = primera palabra del nombre, minúsculas, sin acentos ("Sofía Treviño" → sofia).
// Debe coincidir con booking-slots y con el backfill de la migración 0080.
const slugify = (name: string) => String(name || "").trim().split(/\s+/)[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

async function googleToken(refreshToken?: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken || Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status);
  return (await res.json()).access_token;
}

// Google por host: token+calendario de la propia cuenta de esa persona si tiene secret dedicado;
// si no, FALLBACK al par compartido (comportamiento actual). Idéntico a booking-slots.hostGoogle.
function hostGoogle(hostEmail: string): { refresh?: string; calId: string } {
  const SECRET: Record<string, string> = {
    "sofia@viven.ch": "GOOGLE_REFRESH_TOKEN_SOFIA",
    "sebastian@viven.ch": "GOOGLE_REFRESH_TOKEN_SEBASTIAN",
  };
  const key = SECRET[(hostEmail || "").toLowerCase()];
  const dedicated = key ? Deno.env.get(key) : undefined;
  if (dedicated) return { refresh: dedicated, calId: "primary" };
  return { refresh: Deno.env.get("GOOGLE_REFRESH_TOKEN"), calId: Deno.env.get("GCAL_ID") || "primary" };
}

const SITE = "https://www.viven.ch"; // LIVE ✓
const BRIEF_URL = SITE + "/brief/";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { name = "", email = "", phone = "", message = "", start = "", dur = 15, lang = "en", host: hostSpec = "" } = await req.json();
    if (!name.trim() || !/.+@.+\..+/.test(email) || !start) return json({ error: "missing_fields" }, 400);
    // settings del dashboard (booking_settings, SQL 0024) — con defaults si no existe
    let cfg: Record<string, unknown> = { active: true, notice_hours: 4, horizon_days: 28, buffer_min: 0, durations: [15, 30], msg_en: null, msg_de: null, msg_es: null };
    try { const { data: bs } = await service.from("booking_settings").select("*").eq("id", 1).maybeSingle(); if (bs) cfg = { ...cfg, ...bs }; } catch (_e) { /* defaults */ }
    // Host opcional (slug/email) mandado por el front (/book/[persona] o el selector de /book/):
    // su fila de booking_settings pisa la default para las validaciones de validez/duración,
    // y su email queda como host_email de la reserva. Host no resoluble → default id=1 (compat).
    let paramHostEmail: string | null = null;
    if (hostSpec) {
      try {
        const { data: profs } = await service.from("team_profiles").select("email,name,role,slug");
        const low = String(hostSpec).toLowerCase();
        const tp = (profs || []).find((p) => String(hostSpec).includes("@") ? String(p.email || "").toLowerCase() === low : (p.slug || slugify(p.name)) === low);
        if (tp) {
          paramHostEmail = String(tp.email || "").toLowerCase();
          const { data: hbs } = await service.from("booking_settings").select("*").eq("email", paramHostEmail).maybeSingle();
          if (hbs) cfg = { ...cfg, ...hbs };
        }
      } catch (_e) { /* host no resoluble → default id=1 */ }
    }
    if (!cfg.active) return json({ error: "booking_off" }, 403);
    const startMs = Date.parse(start);
    const noticeMs = (Number(cfg.notice_hours) - 0.5) * 3600e3;   // margen de medio slot
    if (!startMs || startMs < Date.now() + noticeMs || startMs > Date.now() + (Number(cfg.horizon_days) + 3) * 864e5) return json({ error: "invalid_time" }, 400);
    const duration = (cfg.durations as number[]).includes(Number(dur)) ? Number(dur) : (cfg.durations as number[])[0];
    const endMs = startMs + duration * 60e3;

    // lead existente (si hay) ANTES de crear el evento → el link al brief va ligado
    const { data: preLead } = await service.from("leads").select("id,owner").ilike("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const briefUrl = BRIEF_URL + "?lang=" + encodeURIComponent(lang) + (preLead?.id ? "&lead=" + preLead.id : "");

    // Anfitrión correcto (SQL 0073): dueño del lead → email de la fila de settings → default.
    // La identidad visible (nombre/rol/tel/firma) sale de team_profiles de esa persona.
    // El evento va al calendario DE ESA PERSONA si tiene su propio Google conectado (secret
    // GOOGLE_REFRESH_TOKEN_<host>); si no, al calendario compartido de siempre (fallback).
    const hostEmail: string = String(paramHostEmail || preLead?.owner || (cfg as { email?: string }).email || "sebastian@viven.ch").toLowerCase();
    const host = { email: hostEmail, name: String(cfg.host_name || "Sebastian Cepeda"), role: String(cfg.host_role || "Founder — Viven AG, Zürich"), phone: "", signature: "" };
    try {
      const { data: tp } = await service.from("team_profiles").select("name,role,phone,signature_text").eq("email", hostEmail).maybeSingle();
      if (tp) {
        if (tp.name) host.name = tp.name;
        if (tp.role) host.role = tp.role;
        if (tp.phone) host.phone = tp.phone;
        if (tp.signature_text) host.signature = tp.signature_text;
      }
    } catch (_e) { /* sin team_profiles → default de settings */ }
    const hostFirst = host.name.split(/\s+/)[0];

    // token + calendario DEL HOST (su cuenta si tiene secret dedicado; si no, el compartido)
    const { refresh: hostRefresh, calId } = hostGoogle(hostEmail);
    const token = await googleToken(hostRefresh);

    // 1) revalidar que el slot siga libre (carrera entre dos clientes)
    const fb = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: new Date(startMs - (Number(cfg.buffer_min) || 0) * 60e3).toISOString(), timeMax: new Date(endMs + (Number(cfg.buffer_min) || 0) * 60e3).toISOString(), items: [{ id: calId }] }),
    });
    const busy = (await fb.json()).calendars?.[calId]?.busy ?? [];
    if (busy.length) return json({ error: "slot_taken" }, 409);

    // 2) crear el evento con Meet + invitación al cliente (Google manda el email con calendario)
    const hostLabel = { en: "Your host", de: "Ihr Gastgeber", es: "Tu anfitrión" }[["en", "de", "es"].includes(lang) ? lang : "en"]!;
    const hostLine = `${hostLabel}: ${host.name}${host.role ? " — " + host.role : ""}`;
    const T = {
      en: { title: "Viven — Intro call with", desc: hostLine + "\n\nLooking forward to talking about your video project!\n\nTo make the most of the call, you can fill in the short project brief beforehand:\n" + briefUrl },
      de: { title: "Viven — Kennenlern-Call mit", desc: hostLine + "\n\nWir freuen uns auf das Gespräch über Ihr Videoprojekt!\n\nDamit wir das Maximum aus dem Call holen, füllen Sie vorab gern das kurze Projekt-Briefing aus:\n" + briefUrl },
      es: { title: "Viven — Llamada con", desc: hostLine + "\n\n¡Ganas de hablar de tu proyecto de video!\n\nPara aprovechar la llamada al máximo, podés completar antes el brief corto del proyecto:\n" + briefUrl },
    }[["en", "de", "es"].includes(lang) ? lang : "en"]!;
    const ev = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `${T.title} ${name}`,
        description: T.desc + (message ? `\n\n---\nMensaje del cliente:\n${message}` : "") + (phone ? `\nTel: ${phone}` : ""),
        start: { dateTime: new Date(startMs).toISOString() },
        end: { dateTime: new Date(endMs).toISOString() },
        attendees: [{ email, displayName: name }],
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: { useDefault: true },
      }),
    });
    if (!ev.ok) { const t = await ev.text(); console.error("GCAL_ERROR", ev.status, t); return json({ error: "gcal " + ev.status + " " + t.slice(0, 200) }, 502); }
    const event = await ev.json();
    const meet = event.hangoutLink || event.conferenceData?.entryPoints?.find((p: { entryPointType: string }) => p.entryPointType === "video")?.uri || null;

    // 3) CRM sync: persona → videocall (crear si no existe)
    let leadId: string | null = null;
    const { data: found } = await service.from("leads").select("id,status").ilike("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const nowIso = new Date().toISOString();
    if (found) {
      leadId = found.id;
      // MODELO DEALS (SQL 0022): persona ≠ deal. Deal ABIERTO → pasa a videocall.
      // Todos cerrados (ganado/perdido) o sin deals → se crea un DEAL NUEVO en videocall
      // (el ganado viejo queda intacto en el board, y los follow-ups corren para el nuevo).
      let dealsHandled = false;
      try {
        const { data: allDeals } = await service.from("deals").select("id,stage,created_at").eq("lead_id", found.id).eq("archived", false).order("created_at", { ascending: false });
        if (Array.isArray(allDeals)) {
          const open = allDeals.find((d) => !["ganado", "perdido", "won", "lost"].includes(String(d.stage || "").toLowerCase()));
          const wasLost = !open && allDeals.some((d) => ["perdido", "lost"].includes(String(d.stage || "").toLowerCase()));
          if (open) {
            await service.from("deals").update({ stage: "videocall", videocall_at: nowIso, last_stage_at: nowIso }).eq("id", open.id);
          } else {
            await service.from("deals").insert({ lead_id: found.id, title: "Nuevo proyecto — " + name, stage: "videocall", videocall_at: nowIso, last_stage_at: nowIso });
            await service.from("lead_notes").insert({ lead_id: String(found.id), author: "Booking", body: (wasLost ? "🔄 Reactivación: agendó una call por su cuenta — " : "🤝 Cliente existente agendó una call — ") + "deal NUEVO creado en Video call." }).then(() => {}, () => {});
          }
          // espejo: la persona refleja su deal más reciente (ahora: videocall)
          await service.from("leads").update({ status: "videocall", videocall_at: found.videocall_at || nowIso, last_stage_at: nowIso }).eq("id", found.id)
            .then((r) => r.error && service.from("leads").update({ status: "videocall" }).eq("id", found.id));
          dealsHandled = true;
        }
      } catch (_e) { /* sin tabla deals → legado */ }
      if (!dealsHandled) {
        const st = String(found.status || "").toLowerCase();
        if (!["won", "ganado"].includes(st)) {
          const reactivated = ["lost", "perdido"].includes(st);
          await service.from("leads").update({ status: "videocall", videocall_at: nowIso, last_stage_at: nowIso, ...(reactivated ? { lost_reason: null } : {}) }).eq("id", found.id)
            .then((r) => r.error && service.from("leads").update({ status: "videocall" }).eq("id", found.id));
          if (reactivated) await service.from("lead_notes").insert({ lead_id: String(found.id), author: "Booking", body: "🔄 Lead PERDIDO reactivado: agendó una call por su cuenta." }).then(() => {}, () => {});
        }
      }
      await service.from("lead_followups").update({ status: "canceled" }).eq("lead_id", found.id).in("status", ["draft", "approved"]);
    } else {
      const { data: created } = await service.from("leads")
        .insert({ name, first_name: name.split(/\s+/)[0], email, phone: phone || null, message: message || null, status: "videocall", channel: "booking", lang, videocall_at: nowIso, last_stage_at: nowIso })
        .select().maybeSingle();
      leadId = created?.id ?? null;
      if (leadId) await service.from("deals").insert({ lead_id: leadId, title: name, stage: "videocall", videocall_at: nowIso, last_stage_at: nowIso }).then(() => {}, () => {});
    }
    // nota en el historial + registro del booking (best-effort)
    if (leadId) await service.from("lead_notes").insert({ lead_id: String(leadId), author: "Booking", body: `📅 Call agendada por el cliente: ${new Date(startMs).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })} (${duration} min)` + (meet ? `\n${meet}` : "") }).then(() => {}, () => {});
    await service.from("bookings").insert({ name, email, phone: phone || null, message: message || null, start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString(), duration_m: duration, lang, lead_id: leadId, gcal_event: event.id || null, meet_url: meet, host_email: hostEmail }).then(() => {}, () => {});

    // 4) email de confirmación PROPIO vía Resend — la invitación de Google Calendar
    // a veces no genera email (auto-add silencioso); el cliente SIEMPRE recibe el nuestro.
    try {
      const RESEND = Deno.env.get("RESEND_API_KEY");
      if (RESEND && meet) {
        const when = new Date(startMs).toLocaleString(
          lang === "de" ? "de-CH" : lang === "es" ? "es-ES" : "en-GB",
          { timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        const E = {
          en: { sub: `Your call with Viven is booked — ${when}`, hi: `Hi ${esc(name.split(/\s+/)[0])},`, p: `Your ${duration}-minute call with ${esc(hostFirst)} is confirmed for <b>${when}</b> (Zurich time). The Google Calendar invite is on its way too.`, join: "→ Join with Google Meet", brief: "Fill in the 2-min brief", bp: "One more thing: the short project brief helps us come prepared.", see: "See you soon," },
          de: { sub: `Ihr Call mit Viven ist gebucht — ${when}`, hi: `Hallo ${esc(name.split(/\s+/)[0])},`, p: `Ihr ${duration}-Minuten-Call mit ${esc(hostFirst)} ist bestätigt: <b>${when}</b> (Zürich). Die Google-Kalender-Einladung ist ebenfalls unterwegs.`, join: "→ Mit Google Meet beitreten", brief: "2-Min-Briefing ausfüllen", bp: "Noch etwas: Mit dem kurzen Projekt-Briefing kommen wir bestens vorbereitet.", see: "Bis bald," },
          es: { sub: `Tu llamada con Viven está reservada — ${when}`, hi: `Hola ${esc(name.split(/\s+/)[0])},`, p: `Tu llamada de ${duration} minutos con ${esc(hostFirst)} está confirmada: <b>${when}</b> (hora de Zúrich). La invitación de Google Calendar también va en camino.`, join: "→ Entrar con Google Meet", brief: "Completar el brief de 2 min", bp: "Una cosa más: el brief corto nos ayuda a llegar preparados.", see: "¡Nos vemos pronto!" },
        }[["en", "de", "es"].includes(lang) ? lang : "en"]!;
        // firma personal del host correcto (team_profiles → default de settings)
        const signoffHtml = host.signature
          ? esc(host.signature).replace(/\n/g, "<br>")
          : `${esc(host.name)}${host.role ? "<br>" + esc(host.role) : ""}${host.phone ? "<br>" + esc(host.phone) : ""}`;
        const replyTo = /@viven\.ch$/i.test(hostEmail) ? hostEmail : "sebastian@viven.ch";
        // template opcional pisa asunto + párrafo de confirmación; saludo/botones/firma siguen fijos
        const tmpl = await getTemplate("booking_confirmation", lang);
        const first = esc(name.split(/\s+/)[0]);
        const tok = (s: string) => s.replaceAll("{{first_name}}", first).replaceAll("{{when}}", when).replaceAll("{{duration}}", String(duration));
        const subject = tmpl ? tok(tmpl.subject) : E.sub;
        const pHtml = tmpl ? tok(tmpl.body).trim().split(/\n{2,}/).map((p) => `<p style="font-size:15px;line-height:1.7;margin:0 0 6px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("") : `<p style="font-size:15px;line-height:1.7;margin:0 0 6px">${E.p}</p>`;
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2230">
          <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:22px 28px">
            <span style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ddf98f">viven</span>
            <span style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#9aa6bd;margin-left:10px">Film Production</span>
          </div>
          <div style="border:1px solid #e8eaef;border-top:0;border-radius:0 0 14px 14px;padding:26px 28px">
            <p style="font-size:15px;line-height:1.7;margin:0 0 8px">${E.hi}</p>
            ${pHtml}
            <div style="text-align:center;margin:24px 0 8px"><a href="${meet}" style="background:#ddf98f;color:#1c2508;font-weight:700;font-size:14px;text-decoration:none;border-radius:100px;padding:13px 26px;display:inline-block">${E.join}</a></div>
            <p style="font-size:13.5px;line-height:1.7;color:#5b6472;margin:18px 0 6px">${E.bp}</p>
            <div style="text-align:center;margin:8px 0 4px"><a href="${briefUrl}" style="border:1px solid #d5d9e2;color:#1a2230;font-weight:600;font-size:13px;text-decoration:none;border-radius:100px;padding:10px 20px;display:inline-block">${E.brief}</a></div>
            <p style="font-size:14px;line-height:1.7;margin:20px 0 2px;color:#1a2230">${E.see}</p>
            <p style="font-size:14px;line-height:1.6;margin:0;color:#1a2230">${signoffHtml}</p>
            <p style="font-size:11px;color:#8a94a8;text-align:center;margin:22px 0 0;border-top:1px solid #e8eaef;padding-top:14px"><b style="color:#1a2230">VIVEN AG</b> · Film Production · Zeughausstrasse 31, 8004 Zürich<br>viven.ch · ★★★★★ 5.0 on Google (47 reviews)</p>
          </div></div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: `${host.name} — VIVEN AG <info@viven.ch>`, to: [email], reply_to: replyTo, subject, html }),
        });
        if (leadId) await service.from("email_log").insert({ lead_id: String(leadId), to_addr: email, subject, body: html, sender_label: hostFirst, source: "booking-create" }).then(() => {}, () => {});
      }
    } catch (_e) { /* email de confirmación best-effort — el evento ya existe */ }

    // 5) avisar al equipo (push a todos los dispositivos suscritos)
    try {
      const { data: subs } = await service.from("push_subscriptions").select("id").limit(1);
      if (subs?.length) {
        await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/push-send", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
          body: JSON.stringify({ to: "all", title: "📅 Nueva call agendada", body: `${name} — ${new Date(startMs).toLocaleString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} (${duration} min)`, url: leadId ? "/dashboard/?lead=" + leadId : "/dashboard/" }),
        });
      }
    } catch (_e) { /* push opcional */ }

    const customMsg = ({ en: cfg.msg_en, de: cfg.msg_de, es: cfg.msg_es } as Record<string, unknown>)[lang] || null;
    return json({ ok: true, meet_url: meet, start: new Date(startMs).toISOString(), duration, brief_url: briefUrl, msg: customMsg });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
