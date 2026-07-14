// Supabase Edge Function: nurture
// LIFECYCLE AUTOMATION (estilo Keap, hecho en casa): secuencia de emails a
// leads nuevos, personalizada por idioma, fuente y servicio de interés.
//
//   Paso 1 (a los ~20-60 min): bienvenida/confirmación — "recibimos tu consulta,
//           oferta en 48h" + showreel. Si vino de la calculadora, recap del rango.
//   Paso 2 (+3 días, SOLO si sigue en etapa 'nuevo'): case study relevante
//           según su interés + testimonials.
//   Paso 3 (+7 días, SOLO si sigue en 'nuevo'): último toque suave — booking.
//
// A pedido de Sebastián (2026-07-12): TODO pasa por la Bandeja de salida —
// ni siquiera el paso ① sale solo. Esta función solo ARMA los borradores;
// quien realmente envía es el bloque de abajo, cuando vos aprobás en el
// dashboard (📤 Bandeja de salida). nurture_state controla quién está adentro
// y permite pausar/activar por persona o agregar gente a mano.
//
// Frenos duros: dados de baja, emails de test, sin email, lead avanzó de etapa
// (el equipo ya lo está trabajando), pausado en nurture_state, máximo 1 email
// por paso (nurture_log), máximo 1 borrador pendiente por paso (outbox).
// El toggle 🌱 del dashboard (app_settings.nurture) apaga los pasos 2-3 PARA
// TODOS de una — nurture_state.status='paused' apaga a UNA persona sola.
//
// Deploy:  supabase functions deploy nurture --no-verify-jwt
// Cron:    SQL 0040 (cada hora, minuto 15)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// fix (auditoría 2026-07-14): sin auth, mismo riesgo que automations-run — cron pausado
// (migración 0060) pero función directamente invocable. Exige el secret compartido.
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const TEST = /@viven\.ch$|@entropia|@example\.|test/i;
const isNuevo = (st: string) => ["", "new", "nuevo", "pending"].includes((st || "").toLowerCase());
const FROMS: Record<string, { from: string; reply: string; name: string }> = {
  sofia: { from: "Sofia Treviño — VIVEN <info@viven.ch>", reply: "sofia@viven.ch", name: "Sofia" },
  sebastian: { from: "Sebastian Cepeda — VIVEN <info@viven.ch>", reply: "sebastian@viven.ch", name: "Sebastian" },
  team: { from: "VIVEN AG <info@viven.ch>", reply: "info@viven.ch", name: "VIVEN" },
};

async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// avisa por email al remitente de un borrador nuevo (SQL 0063/outbox-notify) —
// best-effort: si falla, el borrador ya quedó pendiente en el dashboard igual.
function notifyOutbox(id: string | number) {
  fetch(`${SB_URL}/functions/v1/outbox-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

// case study según el interés detectado en el mensaje
function caseFor(lang: string, msg: string): { url: string; label: Record<string, string> } {
  const m = (msg || "").toLowerCase();
  if (/employer|recruit|talent|arbeitgeber|empleador|hiring/.test(m)) return {
    url: { en: "/en/case-study-how-viven-helped-siemens-switzerland-amplify-their-employer-branding/", de: "/de/case-study-wie-viven-siemens-schweiz-dabei-half-sein-employer-branding-zu-staerken/", es: "/es/caso-de-exito-como-viven-ayudo-a-siemens-a-ampliar-su-marca-de-empleador/" }[lang] || "/en/case-studies/",
    label: { en: "How Siemens strengthened its employer brand with video", de: "Wie Siemens sein Employer Branding mit Video stärkte", es: "Cómo Siemens reforzó su marca empleadora con video" } };
  if (/product|produkt|explain|erklär|how.?to|saas|tech/.test(m)) return {
    url: { en: "/en/case-study-meteomatics-simplifying-complexity-with-viven-ags-video-solutions/", de: "/de/case-study-meteomatics-komplexitaet-vereinfachen-mit-den-videos-von-viven-ag/", es: "/es/caso-de-exito-meteomatics-simplificando-la-complejidad-con-las-soluciones-en-video-de-viven-ag/" }[lang] || "/en/case-studies/",
    label: { en: "How Meteomatics turned a complex product into clear video", de: "Wie Meteomatics ein komplexes Produkt verständlich machte", es: "Cómo Meteomatics volvió claro un producto complejo" } };
  return {
    url: { en: "/en/case-study-sv-group-bringing-it-operations-and-hospitality-together/", de: "/de/case-study-sv-group-it-betrieb-und-gastfreundschaft-perfekt-vereint/", es: "/es/caso-de-exito-sv-group-it-operaciones-y-hospitalidad-perfectamente-integrados/" }[lang] || "/en/case-studies/",
    label: { en: "How SV Group brought IT and hospitality together on film", de: "Wie SV Group IT und Gastfreundschaft im Film vereinte", es: "Cómo SV Group unió IT y hospitalidad en un film" } };
}

const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
function wrap(inner: string, unsub: string, lang: string, signer: string): string {
  const bye = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" }[lang] || "Unsubscribe";
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${inner}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${esc(signer)}, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zeughausstrasse 31, 8004 Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${bye}</a></p>
</div></body>`;
}
const P = (t: string) => `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#222">${t}</p>`;
const BTN = (url: string, label: string) => `<p style="margin:20px 0"><a href="${url}" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 22px;border-radius:100px;display:inline-block">${label}</a></p>`;

// 📚 Plantillas (SQL 0062): si existe email_templates(key='nurture_step1',
// lang), su subject/body pisan ENTERO el mail de bienvenida (paso 1) — tokens
// {{first_name}}/{{calc_range}}. Pasos 2/3 quedan listados en el editor del
// dashboard pero sin wiring server-side todavía (ver TODO al final del archivo).
// Lookup defensivo: tabla ausente/error = mismo camino que "sin fila".
async function getTemplate(key: string, lang: string): Promise<{ subject: string; body: string } | null> {
  try {
    const { data, error } = await service.from("email_templates").select("subject,body").eq("key", key).eq("lang", lang).maybeSingle();
    if (error || !data || !data.subject || !data.body) return null;
    return data as { subject: string; body: string };
  } catch (_e) { return null; }
}

async function mailFor(step: number, lead: Record<string, unknown>): Promise<{ subject: string; html: string }> {
  const lang = ["en", "de", "es"].includes(String(lead.lang)) ? String(lead.lang) : "en";
  const first = esc(String(lead.first_name || String(lead.name || "").split(" ")[0] || "").trim());
  const hi = { en: `Hi${first ? " " + first : ""},`, de: `Hallo${first ? " " + first : ""}`, es: `Hola${first ? " " + first : ""}:` }[lang]!;
  const msg = String(lead.message || "");
  const calc = msg.includes("🧮 CALCULADORA") ? (msg.match(/CHF[\s\d'.,–-]+CHF[\s\d'.,]+|CHF[\s\d'.,]+[–-][\s]*CHF[\s\d'.,]+/) || [""])[0] : "";
  const cs = caseFor(lang, msg);

  if (step === 1) {
    const tmpl = await getTemplate("nurture_step1", lang);
    if (tmpl) {
      const tok = (s: string) => s.replaceAll("{{first_name}}", first).replaceAll("{{calc_range}}", calc || "");
      const bodyHtml = P(hi) + tok(tmpl.body).trim().split(/\n{2,}/).map((p) => P(esc(p).replace(/\n/g, "<br>"))).join("");
      return { subject: tok(tmpl.subject), html: bodyHtml };
    }
    const sub = { en: "We got your request — concept & quote within 48h", de: "Anfrage erhalten — Konzept & Offerte innert 48h", es: "Recibimos tu consulta — concepto y presupuesto en 48h" }[lang]!;
    const inner = P(hi) +
      P({ en: "Thanks for reaching out to Viven. A real human (one of us two) is already looking at your request — you'll get three concept directions, timing and a clear fixed quote within 48 hours on business days.",
          de: "Danke für Ihre Anfrage bei Viven. Ein echter Mensch (einer von uns beiden) schaut sie sich bereits an — Sie erhalten innert 48 Stunden (werktags) drei Konzeptrichtungen, Timing und eine klare Fixofferte.",
          es: "Gracias por escribirle a Viven. Un humano de verdad (uno de nosotros dos) ya está mirando tu consulta — en 48 horas hábiles vas a tener tres direcciones de concepto, tiempos y un presupuesto fijo claro." }[lang]!) +
      (calc ? P({ en: `Your calculator estimate (${esc(calc)}) came through with your selections — we'll refine it into an exact quote.`,
                  de: `Ihre Rechner-Schätzung (${esc(calc)}) ist mit Ihren Angaben angekommen — wir verfeinern sie zu einer exakten Offerte.`,
                  es: `Tu estimación de la calculadora (${esc(calc)}) llegó con tu configuración — la vamos a afinar a un presupuesto exacto.` }[lang]!) : "") +
      P({ en: "Meanwhile, 90 seconds of what we do:", de: "In der Zwischenzeit: 90 Sekunden, was wir tun:", es: "Mientras tanto, 90 segundos de lo que hacemos:" }[lang]!) +
      BTN("https://vimeo.com/1057568537", { en: "▶ Watch our showreel", de: "▶ Showreel ansehen", es: "▶ Ver nuestro showreel" }[lang]!) +
      P({ en: `In a hurry? <a href="https://www.viven.ch/book/" style="color:#5b7cfa">Grab a free 15-min slot</a> and let's talk it through.`,
          de: `Eilig? <a href="https://www.viven.ch/book/" style="color:#5b7cfa">Buchen Sie einen gratis 15-Min-Slot</a> und wir besprechen es direkt.`,
          es: `¿Apuro? <a href="https://www.viven.ch/book/" style="color:#5b7cfa">Reservá 15 minutos gratis</a> y lo hablamos directo.` }[lang]!);
    return { subject: sub, html: inner };
  }
  if (step === 2) {
    const sub = { en: "How brands like Siemens use video (2-min read)", de: "Wie Marken wie Siemens Video einsetzen (2 Min.)", es: "Cómo marcas como Siemens usan el video (2 min)" }[lang]!;
    const inner = P(hi) +
      P({ en: "While your project idea is fresh: here's a story close to what you're planning — goal, approach and what it changed.",
          de: "Solange Ihre Projektidee frisch ist: eine Geschichte nah an dem, was Sie planen — Ziel, Vorgehen und was sie bewirkt hat.",
          es: "Mientras tu idea sigue fresca: una historia parecida a lo que estás planeando — objetivo, enfoque y qué cambió." }[lang]!) +
      BTN("https://www.viven.ch" + cs.url, "→ " + cs.label[lang]!) +
      P({ en: `And if you want the receipts: <a href="https://www.viven.ch/en/testimonials/" style="color:#5b7cfa">every single Google review is 5 stars</a>.`,
          de: `Und wer Beweise will: <a href="https://www.viven.ch/de/testimonials/" style="color:#5b7cfa">jede einzelne Google-Bewertung hat 5 Sterne</a>.`,
          es: `Y si querés pruebas: <a href="https://www.viven.ch/es/testimonios/" style="color:#5b7cfa">todas nuestras reseñas de Google son de 5 estrellas</a>.` }[lang]!);
    return { subject: sub, html: inner };
  }
  const sub = { en: "Should we keep your video project warm?", de: "Sollen wir Ihr Videoprojekt warmhalten?", es: "¿Mantenemos tu proyecto de video en el radar?" }[lang]!;
  const inner = P(hi) +
    P({ en: "No pressure — projects have their own timing. If it's still on your mind, two easy ways forward:",
        de: "Kein Druck — Projekte haben ihr eigenes Timing. Falls es noch aktuell ist, zwei einfache Wege:",
        es: "Sin presión — los proyectos tienen su propio timing. Si sigue en tu cabeza, dos caminos fáciles:" }[lang]!) +
    BTN("https://www.viven.ch/book/", { en: "📅 Book a free 15-min call", de: "📅 Gratis 15-Min-Call buchen", es: "📅 Reservar llamada gratis de 15 min" }[lang]!) +
    P({ en: `Or get an instant number: <a href="https://www.viven.ch/en/video-cost-calculator/" style="color:#5b7cfa">calculate your video cost in 60 seconds</a>. If now isn't the moment, just ignore this — we won't keep nudging.`,
        de: `Oder sofort eine Zahl: <a href="https://www.viven.ch/de/videoproduktion-kosten-rechner/" style="color:#5b7cfa">Videokosten in 60 Sekunden berechnen</a>. Falls es gerade nicht passt, einfach ignorieren — wir haken nicht weiter nach.`,
        es: `O un número al instante: <a href="https://www.viven.ch/es/calculadora-costos-video/" style="color:#5b7cfa">calculá el costo de tu video en 60 segundos</a>. Si no es el momento, ignorá este mail — no vamos a insistir.` }[lang]!);
  return { subject: sub, html: inner };
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    // toggle global de los pasos 2-3 (app_settings.nurture = {"enabled": bool}); paso 1 siempre elegible
    let steps23 = true;
    try {
      const { data: st } = await service.from("app_settings").select("value").eq("key", "nurture").maybeSingle();
      if (st && st.value && st.value.enabled === false) steps23 = false;
    } catch (_) { /* tabla pendiente (SQL 0040) */ }

    // candidatos: leads nuevos (últimos 21 días) + cualquiera ya inscripto a mano (nurture_state manual)
    let leadsQ = await service.from("leads").select("id,name,first_name,email,lang,status,message,created_at,unsubscribed").not("email", "is", null).gte("created_at", new Date(Date.now() - 21 * 864e5).toISOString());
    if (leadsQ.error && /column/.test(leadsQ.error.message || "")) leadsQ = await service.from("leads").select("id,name,first_name,email,lang,status,message,created_at").not("email", "is", null).gte("created_at", new Date(Date.now() - 21 * 864e5).toISOString());
    if (leadsQ.error) return json({ error: leadsQ.error.message }, 500);
    const recent = leadsQ.data ?? [];

    const { data: stateRows } = await service.from("nurture_state").select("*");
    const state = new Map((stateRows ?? []).map((s: Record<string, unknown>) => [String(s.lead_id), s]));

    // auto-inscribe a la lista visible a todo lead reciente que todavía no tenga fila
    // (no cambia si/cuándo se le manda — solo lo hace visible + pausable en el dashboard)
    let enrolled = 0;
    for (const r of recent) {
      if (state.has(String(r.id))) continue;
      const { data: ins } = await service.from("nurture_state").insert({ lead_id: r.id, status: "active", source: "auto", enrolled_at: r.created_at }).select().maybeSingle();
      if (ins) { state.set(String(r.id), ins); enrolled++; }
    }

    // manuales de leads viejos (fuera de la ventana de 21 días) también entran al loop
    const manualOldIds = [...state.values()].filter((s: Record<string, unknown>) => s.status === "active" && !recent.some((r) => String(r.id) === String(s.lead_id))).map((s: Record<string, unknown>) => s.lead_id);
    let extra: Record<string, unknown>[] = [];
    if (manualOldIds.length) {
      const { data: ex } = await service.from("leads").select("id,name,first_name,email,lang,status,message,created_at,unsubscribed").in("id", manualOldIds);
      extra = ex ?? [];
    }
    const candidates = [...recent, ...extra];

    const { data: logs } = await service.from("nurture_log").select("lead_id,step");
    const sent = new Set((logs ?? []).map((l: { lead_id: number; step: number }) => l.lead_id + ":" + l.step));
    const { data: draftedRows } = await service.from("outbox").select("lead_id,step").eq("kind", "nurture");
    const hasDraft = new Set((draftedRows ?? []).map((o: { lead_id: number; step: number }) => o.lead_id + ":" + o.step));

    const now = Date.now();
    const out = { s1: 0, s2: 0, s3: 0, skipped: 0, enrolled, sent: 0, failed: 0 };
    for (const r of candidates) {
      if (!r.email || TEST.test(String(r.email)) || (r as { unsubscribed?: boolean }).unsubscribed) { out.skipped++; continue; }
      const st = state.get(String(r.id));
      if (!st || st.status === "paused") { out.skipped++; continue; }
      const enrolledAt = st.enrolled_at ? new Date(String(st.enrolled_at)).getTime() : new Date(r.created_at).getTime();
      const age = now - enrolledAt;
      let step = 0;
      if (age > 20 * 60e3 && age < 2 * 864e5 && !sent.has(r.id + ":1") && !hasDraft.has(r.id + ":1")) step = 1;
      else if (steps23 && age > 3 * 864e5 && age < 10 * 864e5 && isNuevo(r.status) && sent.has(r.id + ":1") && !sent.has(r.id + ":2") && !hasDraft.has(r.id + ":2")) step = 2;
      else if (steps23 && age > 7 * 864e5 && age < 21 * 864e5 && isNuevo(r.status) && sent.has(r.id + ":2") && !sent.has(r.id + ":3") && !hasDraft.has(r.id + ":3")) step = 3;
      if (!step) continue;
      if (body.dry_run) { out["s" + step as "s1"]++; continue; }
      const { subject, html } = await mailFor(step, r as Record<string, unknown>);
      // se arma el borrador — nada sale sin aprobación en 📤 Bandeja de salida
      const { data: obIns } = await service.from("outbox").insert({ lead_id: r.id, kind: "nurture", step, sender: "sofia", subject, body: html, status: "pending" }).select("id").maybeSingle();
      if (obIns?.id) notifyOutbox(obIns.id);
      out["s" + step as "s1"]++;
    }

    // ============ envía lo que ya fue aprobado en la Bandeja ============
    const { data: appr } = await service.from("outbox").select("*").eq("status", "approved").eq("kind", "nurture").limit(50);
    for (const ob of appr ?? []) {
      const { data: lead } = await service.from("leads").select("id,email,name,first_name,lang,unsubscribed").eq("id", ob.lead_id).maybeSingle();
      if (!lead || !lead.email || (lead as { unsubscribed?: boolean }).unsubscribed || TEST.test(String(lead.email))) {
        await service.from("outbox").update({ status: "discarded" }).eq("id", ob.id); continue;
      }
      const F = FROMS[ob.sender as string] || FROMS.sofia;
      const unsub = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
      const html = wrap(ob.body as string, unsub, String(lead.lang || "en"), F.name);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
        body: JSON.stringify({ from: F.from, reply_to: F.reply, to: [lead.email], subject: ob.subject, html }),
      });
      if (res.ok) {
        await service.from("outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ob.id);
        if (ob.step) await service.from("nurture_log").insert({ lead_id: ob.lead_id, step: ob.step }).then(() => {}, () => {});
        await service.from("email_log").insert({ lead_id: String(ob.lead_id), to_addr: lead.email, subject: ob.subject, body: html, sender_label: F.name, source: "nurture" }).then(() => {}, () => {});
        out.sent++;
      } else { await service.from("outbox").update({ status: "failed" }).eq("id", ob.id); out.failed++; console.error("RESEND_FAIL", lead.email, ob.step, res.status); }
      await new Promise((ok) => setTimeout(ok, 150));
    }

    return json({ ok: true, ...out, steps23 });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
