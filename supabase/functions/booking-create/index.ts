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
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function googleToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status);
  return (await res.json()).access_token;
}

const SITE = "https://viven-astro-website.viven-ag.workers.dev"; // TODO al ir live: https://www.viven.ch
const BRIEF_URL = SITE + "/brief/";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { name = "", email = "", phone = "", message = "", start = "", dur = 15, lang = "en" } = await req.json();
    if (!name.trim() || !/.+@.+\..+/.test(email) || !start) return json({ error: "missing_fields" }, 400);
    const startMs = Date.parse(start);
    if (!startMs || startMs < Date.now() + 3.5 * 3600e3 || startMs > Date.now() + 31 * 864e5) return json({ error: "invalid_time" }, 400);
    const duration = dur === 30 ? 30 : 15;
    const endMs = startMs + duration * 60e3;

    const token = await googleToken();
    const calId = Deno.env.get("GCAL_ID") || "primary";

    // 1) revalidar que el slot siga libre (carrera entre dos clientes)
    const fb = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: new Date(startMs).toISOString(), timeMax: new Date(endMs).toISOString(), items: [{ id: calId }] }),
    });
    const busy = (await fb.json()).calendars?.[calId]?.busy ?? [];
    if (busy.length) return json({ error: "slot_taken" }, 409);

    // 2) crear el evento con Meet + invitación al cliente (Google manda el email con calendario)
    const T = {
      en: { title: "Viven — Intro call with", desc: "Looking forward to talking about your video project!\n\nTo make the most of the call, you can fill in the short project brief beforehand:\n" + BRIEF_URL },
      de: { title: "Viven — Kennenlern-Call mit", desc: "Wir freuen uns auf das Gespräch über Ihr Videoprojekt!\n\nDamit wir das Maximum aus dem Call holen, füllen Sie vorab gern das kurze Projekt-Briefing aus:\n" + BRIEF_URL },
      es: { title: "Viven — Llamada con", desc: "¡Ganas de hablar de tu proyecto de video!\n\nPara aprovechar la llamada al máximo, podés completar antes el brief corto del proyecto:\n" + BRIEF_URL },
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
      const done = ["won", "ganado", "lost", "perdido"].includes(String(found.status || "").toLowerCase());
      if (!done) {
        await service.from("leads").update({ status: "videocall", videocall_at: nowIso, last_stage_at: nowIso }).eq("id", found.id)
          .then((r) => r.error && service.from("leads").update({ status: "videocall" }).eq("id", found.id));
        await service.from("lead_followups").update({ status: "canceled" }).eq("lead_id", found.id).in("status", ["draft", "approved"]);
      }
    } else {
      const { data: created } = await service.from("leads")
        .insert({ name, first_name: name.split(/\s+/)[0], email, phone: phone || null, message: message || null, status: "videocall", channel: "booking", lang, videocall_at: nowIso, last_stage_at: nowIso })
        .select().maybeSingle();
      leadId = created?.id ?? null;
    }
    // nota en el historial + registro del booking (best-effort)
    if (leadId) await service.from("lead_notes").insert({ lead_id: String(leadId), author: "Booking", body: `📅 Call agendada por el cliente: ${new Date(startMs).toLocaleString("de-CH", { timeZone: "Europe/Zurich" })} (${duration} min)` + (meet ? `\n${meet}` : "") }).then(() => {}, () => {});
    await service.from("bookings").insert({ name, email, phone: phone || null, message: message || null, start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString(), duration_m: duration, lang, lead_id: leadId, gcal_event: event.id || null, meet_url: meet }).then(() => {}, () => {});

    // 4) avisar al equipo (push a todos los dispositivos suscritos)
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

    return json({ ok: true, meet_url: meet, start: new Date(startMs).toISOString(), duration, brief_url: BRIEF_URL });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
