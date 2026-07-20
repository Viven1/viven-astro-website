// Supabase Edge Function: automations-run
// MOTOR de las automatizaciones del dashboard (tab ⚙️): inscribe leads que
// matchean el trigger de cada automatización activa y ejecuta los pasos de su
// camino (A o B según el split). Cron cada 20 min (SQL 0041).
//
// Triggers:  lead_new {source?, lang?, channel?, category?} · stage {stage} · inactivity {days}
// Pasos:     email {from, subject, body} · content_step {from, subject{lang}, blocks[]} ·
//            wait {days} · task {title} · push {title} · status {value}
// Tokens en subject/body: {{first_name}} {{name}} {{company}}
// Frenos: unsubscribed, emails de test, un run por lead y automatización (unique).
//
// content_step (SQL 0088, reemplaza a la function content-followup): igual
// que 'email' pero el cuerpo se arma con bloques ricos (párrafo/grilla de
// videos/link card) según el idioma del lead, y sale por outbox con
// kind:'content_followup' — mismo pipeline que ya sabe renderizar HTML sin
// escapar (outbox-notify/outbox-action).
//
// Deploy: supabase functions deploy automations-run --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// fix (auditoría 2026-07-14): sin auth. El cron de esta función está pausado (migración
// 0060) pero la función en sí sigue invocable directo por cualquiera — un atacante podía
// forzar el motor completo de automations fuera de horario, incluyendo el envío real de
// borradores ya aprobados en el outbox. Exige el secret compartido de los crons internos.
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const ANTHROPIC = Deno.env.get("ANTHROPIC_API_KEY")!;
const TEST = /@viven\.ch$|@entropia|@example\.|test/i;
const VOICE: Record<string, string> = {
  sofia: "You write as Sofia Treviño, producer at VIVEN: warm, precise, service-minded, zero fluff.",
  sebastian: "You write as Sebastian Cepeda, founder of VIVEN (produced the first Swiss feature film on Netflix): direct, generous, entrepreneurial, zero hype.",
  team: "You write as the VIVEN team: friendly, professional, concise.",
};
async function aiDraft(lead: Record<string, unknown>, prompt: string, sender: string): Promise<{ subject: string; body: string } | null> {
  const lang = ["en", "de", "es"].includes(String(lead.lang)) ? String(lead.lang) : "en";
  const sys = `${VOICE[sender] || VOICE.team} Language: ${lang === "de" ? "Swiss High German (Sie form, NEVER ß — always ss)" : lang === "es" ? "Spanish (voseo friendly but professional)" : "English"}. Plain text only, 60-120 words, ONE call to action, no marketing hype, no multiple exclamation marks, no emojis unless natural. Sign with the sender's first name only. Never invent facts not present in the context. Output ONLY minified JSON {"subject":"...","body":"..."} — body paragraphs separated by \n\n.`;
  const ctx = `CONTACT: ${lead.name || ""} · ${lead.company || ""} · stage: ${lead.status || "nuevo"} · source: ${lead.source || "form"} · their original message: "${String(lead.message || "").slice(0, 500)}"`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 700, system: sys, messages: [{ role: "user", content: `TASK FOR THIS EMAIL: ${prompt}\n\n${ctx}` }] }),
  });
  if (!res.ok) { console.error("AI_DRAFT_FAIL", res.status); return null; }
  const data = await res.json();
  let t = (data.content?.[0]?.text ?? "").trim().replace(/```json|```/g, "");
  const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
  try { const p = JSON.parse(t); return p.subject && p.body ? p : null; } catch { return null; }
}
const STAGE_TS: Record<string, string> = { contactado: "contacted_at", videocall: "videocall_at", propuesta: "proposal_at", ganado: "won_at", perdido: "lost_at" };
const isNuevo = (st: string) => ["", "new", "nuevo", "pending"].includes((st || "").toLowerCase());

// pedido explícito de Sebastián: no mandar emails automatizados fuera de
// horario laboral suizo (Mon-Fri 09:00-12:00 y 13:30-17:00, hora de
// Zúrich). Usa Intl con timeZone en vez de matemática manual de offset
// para que el cambio de horario de verano (CEST/CET) no rompa esto dos
// veces al año. Fuera de horario: el draft queda 'approved' esperando la
// próxima corrida — no se pierde, solo se demora hasta la próxima ventana.
function isSwissBusinessHours(d = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zurich", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const mins = (+get("hour")) * 60 + (+get("minute"));
  return (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 13 * 60 + 30 && mins < 17 * 60);
}

const FROMS: Record<string, { from: string; reply: string }> = {
  sofia: { from: "Sofia Treviño — VIVEN <info@viven.ch>", reply: "sofia@viven.ch" },
  sebastian: { from: "Sebastian Cepeda — VIVEN <info@viven.ch>", reply: "sebastian@viven.ch" },
  team: { from: "VIVEN AG <info@viven.ch>", reply: "info@viven.ch" },
};

async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
// avisa por email al remitente de un borrador nuevo (SQL 0063/outbox-notify) —
// best-effort: si falla, el borrador ya quedó pendiente en el dashboard igual.
function notifyOutbox(id: string | number) {
  fetch(`${SB_URL}/functions/v1/outbox-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}
function fill(t: string, lead: Record<string, unknown>): string {
  const first = String(lead.first_name || String(lead.name || "").split(" ")[0] || "").trim();
  // {{last_name}} — para saludos formales en alemán ("Guten Tag {{last_name}},"
  // con Sie), donde el nombre de pila suena mal si el resto del texto ya usa
  // Sie. A propósito NO se adivina Herr/Frau (no hay campo de género en
  // leads y adivinarlo por nombre de pila puede fallar con nombres
  // internacionales/ambiguos — un error ahí es peor que no ponerlo).
  const last = String(lead.last_name || "").trim() || String(lead.name || "").split(" ").slice(1).join(" ").trim() || first;
  const refCode = String(lead.referral_code || "");
  return String(t || "")
    .replaceAll("{{first_name}}", first)
    .replaceAll("{{last_name}}", last)
    .replaceAll("{{name}}", String(lead.name || first))
    .replaceAll("{{company}}", String(lead.company || ""))
    .replaceAll("{{referral_code}}", refCode)
    .replaceAll("{{referral_link}}", refCode ? `https://www.viven.ch/?ref=${refCode}` : "https://www.viven.ch");
}
function wrap(bodyText: string, unsub: string, lang: string, sender: string): string {
  const bye = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" }[lang] || "Unsubscribe";
  const paras = bodyText.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#222">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#5b7cfa">$1</a>').replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${paras}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${esc(sender)}, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${bye}</a></p>
</div></body>`;
}
// content_step arma su body como HTML ya listo (thumbnails/link cards), no
// texto libre — a diferencia de wrap(), NO se escapa el body entero (si no,
// <img>/<table> quedarían como texto literal). Mismo shell que outbox-action.
function wrapRaw(bodyHtml: string, unsub: string, lang: string): string {
  const bye = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" }[lang] || "Unsubscribe";
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${bodyHtml}</div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${bye}</a></p>
</div></body>`;
}

// el chip de tipo de video en el mensaje de la calculadora ("🧮 CALCULADORA —
// 📦 Product video · ...") cambia de texto por idioma pero el emoji es el
// mismo en EN/DE/ES — matchear solo por emoji cubre los 3 idiomas sin listar
// cada traducción. Aislar el PRIMER segmento (antes del primer '·') evita
// chocar con el chip de talento "👥 Our own employees", que comparte emoji
// con la categoría Employer branding.
const CATEGORY_RE: [string, RegExp][] = [
  ["product", /📦/], ["brand", /🎬/], ["employer", /👥/], ["howto", /🎓/], ["social", /📱/], ["corporate", /🏢/],
];
function categoryOf(message: string | null | undefined): string | null {
  const seg = String(message || "").match(/🧮 CALCULADORA — ([^·]+)·/);
  if (!seg) return null;
  for (const [cat, re] of CATEGORY_RE) if (re.test(seg[1])) return cat;
  return null;
}
const pick = (obj: Record<string, string> | undefined, lang: string) => (obj && (obj[lang] || obj.en)) || "";
function thumbTable(items: { href: string; img: string; caption: string }[]): string {
  const valid = items.filter((it) => it && it.href && it.img);
  if (!valid.length) return "";
  const td = valid.map((it, i) => `<td width="${Math.floor(100 / valid.length)}%" style="padding:0 ${i === 0 ? 6 : 3}px 0 ${i === valid.length - 1 ? 0 : 3}px;vertical-align:top">` +
    `<a href="${esc(it.href)}" style="text-decoration:none"><img src="${esc(it.img)}" width="100%" style="display:block;border-radius:8px;border:1px solid #e5e7eb" alt="${esc(it.caption)}"/>` +
    `<p style="margin:6px 0 0;font-size:11.5px;color:#555;text-align:center">▶ ${esc(it.caption)}</p></a></td>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>${td}</tr></table>`;
}
function linkCardBlock(href: string, title: string, icon = "📝"): string {
  if (!href) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#f4f5f7;border-radius:12px"><tr>` +
    `<td style="padding:14px 16px"><a href="${esc(href)}" style="text-decoration:none;color:#0f1826"><span style="font-size:18px;margin-right:8px">${icon}</span><b style="font-size:14px">${esc(title)}</b><br>` +
    `<span style="font-size:11.5px;color:#8891a0;font-family:monospace">${esc(href.replace(/^https?:\/\//, ""))}</span></a></td></tr></table>`;
}
function pBlock(text: string, muted: boolean): string {
  return `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:${muted ? "#555" : "#222"}">${esc(text).replace(/\n/g, "<br>")}</p>`;
}
type ContentBlock = { type: string; muted?: boolean; text?: Record<string, string>; items?: { href: string; img: string; caption: string }[]; href?: Record<string, string>; title?: Record<string, string>; icon?: string };
function renderBlocks(blocks: ContentBlock[], lang: string, lead: Record<string, unknown>): string {
  return (blocks || []).map((b) => {
    if (b.type === "p") return pBlock(fill(pick(b.text, lang), lead), !!b.muted);
    if (b.type === "video_grid") return thumbTable(b.items || []);
    if (b.type === "link_card") return linkCardBlock(pick(b.href, lang), pick(b.title, lang), b.icon || "📝");
    return "";
  }).join("");
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const { data: autos, error: aerr } = await service.from("automations").select("*").eq("enabled", true);
    if (aerr) return json({ error: aerr.message }, 500);
    const out: Record<string, number> = { enrolled: 0, steps: 0, emails: 0, done: 0, skipped: 0 };

    // ============ 1) INSCRIPCIÓN ============
    for (const au of autos ?? []) {
      const cfg = au.trigger_config || {};
      let cands: Record<string, unknown>[] = [];
      // 21 días (no 10): content_step puede tener pasos hasta día+9+margen de
      // aprobación manual — una ventana más corta dejaría afuera leads reales
      // que matchean una categoría pero ya no son "recién llegados".
      const since = new Date(Date.now() - 21 * 864e5).toISOString();
      if (au.trigger === "lead_new") {
        // fix (auditoría 2026-07-14): pedía leads.source, columna que NUNCA existió —
        // PostgREST devolvía error, q.data quedaba undefined, y con `?? []` esto hacía
        // que CUALQUIER automation con trigger "Nuevo Lead" jamás inscribiera a nadie,
        // en silencio. El heurístico real (mensaje de la calculadora) no dependía de
        // esa columna, así que queda solo esa señal.
        const q = await service.from("leads").select("id,email,name,first_name,company,lang,status,channel,message,created_at,unsubscribed").gte("created_at", since).not("email", "is", null);
        cands = (q.data ?? []).filter((r) => {
          if (cfg.source === "calculator" && !String(r.message || "").includes("CALCULADORA")) return false;
          if (cfg.source === "form" && String(r.message || "").includes("CALCULADORA")) return false;
          if (cfg.category && categoryOf(String(r.message || "")) !== cfg.category) return false;
          if (cfg.lang && cfg.lang !== "any" && (r.lang || "en") !== cfg.lang) return false;
          if (cfg.channel === "paid" && !r.channel?.toString().includes("paid")) return false;
          if (cfg.channel === "organic" && !/organic|search/.test(String(r.channel || ""))) return false;
          return new Date(String(r.created_at)).getTime() < Date.now() - 15 * 60e3;   // 15 min de gracia
        });
      } else if (au.trigger === "stage") {
        const col = STAGE_TS[String(cfg.stage)] || "won_at";
        const q = await service.from("leads").select(`id,email,name,first_name,company,lang,status,unsubscribed,${col}`).gte(col, since).not("email", "is", null);
        cands = q.data ?? [];
      } else if (au.trigger === "inactivity") {
        const days = Math.max(2, +cfg.days || 7);
        if (cfg.scope === "dormant") {
          // clientes GANADOS sin actividad hace 'days' días (reactivación de dormidos)
          const q = await service.from("leads").select("id,email,name,first_name,company,lang,status,won_at,unsubscribed,message").not("email", "is", null).not("won_at", "is", null).lte("won_at", new Date(Date.now() - days * 864e5).toISOString());
          cands = (q.data ?? []).slice(0, 10);   // lotes chicos: máx 10 por corrida, no saturar la bandeja
        } else {
          const q = await service.from("leads").select("id,email,name,first_name,company,lang,status,created_at,contacted_at,unsubscribed,message").not("email", "is", null).lte("created_at", new Date(Date.now() - days * 864e5).toISOString()).gte("created_at", new Date(Date.now() - (days + 14) * 864e5).toISOString());
          cands = (q.data ?? []).filter((r) => isNuevo(String(r.status)) || String(r.status).toLowerCase() === "contactado" || String(r.status).toLowerCase() === "contacted");
        }
      }
      for (const r of cands) {
        if (!r.email || TEST.test(String(r.email)) || (r as { unsubscribed?: boolean }).unsubscribed) { out.skipped++; continue; }
        const variant = au.ab_split >= 50 && (Number(r.id) % 2 === 1) ? "b" : "a";
        const ins = await service.from("automation_runs").insert({ automation_id: au.id, lead_id: r.id, variant });
        if (!ins.error) out.enrolled++;
      }
    }

    // ============ 2) EJECUCIÓN ============
    const { data: runs } = await service.from("automation_runs").select("*").eq("status", "active").lte("next_at", new Date().toISOString()).limit(200);
    for (const run of runs ?? []) {
      const au = (autos ?? []).find((a) => a.id === run.automation_id);
      if (!au) { await service.from("automation_runs").update({ status: "stopped" }).eq("id", run.id); continue; }
      const cfg = au.trigger_config || {};
      const steps = (run.variant === "b" ? au.steps_b : au.steps_a) || [];
      if (run.step_idx >= steps.length) { await service.from("automation_runs").update({ status: "done" }).eq("id", run.id); out.done++; continue; }
      const { data: lead } = await service.from("leads").select("*").eq("id", run.lead_id).maybeSingle();
      if (!lead || (lead as { unsubscribed?: boolean }).unsubscribed) { await service.from("automation_runs").update({ status: "stopped" }).eq("id", run.id); continue; }
      // código de referido propio (para {{referral_link}}) — se genera una sola
      // vez, la primera vez que un workflow lo necesita, y queda para siempre
      if (!lead.referral_code) {
        lead.referral_code = "REF" + lead.id;
        await service.from("leads").update({ referral_code: lead.referral_code }).eq("id", lead.id).then(() => {}, () => {});
      }
      // EXIT RULES: conversación viva o lead que avanzó → robots afuera
      const enrolledAt = new Date(run.created_at).getTime();
      const replied = lead.last_reply_at && new Date(lead.last_reply_at).getTime() > enrolledAt;
      const stageAdvanced = (au.trigger === "lead_new" || au.trigger === "inactivity") && !isNuevo(String(lead.status)) && !/contactado|contacted/i.test(String(lead.status));
      const booked = lead.videocall_at && new Date(lead.videocall_at).getTime() > enrolledAt;
      if (replied || stageAdvanced || booked) {
        await service.from("automation_runs").update({ status: "stopped" }).eq("id", run.id);
        out.exited = (out.exited || 0) + 1; continue;
      }
      const step = steps[run.step_idx];
      // THROTTLE global: máx 1 email automático / 5 días por contacto (los waits del camino mandan igual)
      if ((step.type === "email" || step.type === "ai_email" || step.type === "content_step") && lead.last_automated_email_at &&
          Date.now() - new Date(lead.last_automated_email_at).getTime() < 5 * 864e5 && !(run.step_idx === 0 && au.trigger === "lead_new")) {
        await service.from("automation_runs").update({ next_at: new Date(Date.now() + 2 * 864e5).toISOString() }).eq("id", run.id);
        out.throttled = (out.throttled || 0) + 1; continue;
      }
      let nextAt = new Date();
      if (body.dry_run) { out.steps++; continue; }
      let stepsSkippedToEnd = false;
      try {
        if (step.type === "wait") {
          nextAt = new Date(Date.now() + (Math.max(0, +step.days || 1)) * 864e5);
        } else if (step.type === "email") {
          // A pedido de Sebastián: TODO email automatizado pasa por la Bandeja
          // de salida, sin excepciones — antes esto mandaba directo por Resend
          // (bypaseaba la aprobación humana que sí tenían los pasos ai_email).
          // Se guarda CRUDO (con tokens {{first_name}} etc.) — la sección 3 más
          // abajo hace fill()+wrap() recién al aprobar/enviar, con el lead fresco.
          const { data: obIns } = await service.from("outbox").insert({ lead_id: lead.id, automation_id: au.id, run_id: run.id, kind: "workflow", sender: step.from || "team", subject: step.subject || "", body: step.body || "", status: "pending" }).select("id").maybeSingle();
          if (obIns?.id) notifyOutbox(obIns.id);
          out.drafts = (out.drafts || 0) + 1;
        } else if (step.type === "ai_email") {
          // borrador IA → BANDEJA DE SALIDA (nunca sale sin aprobación humana)
          const draft = await aiDraft(lead, String(step.prompt || "Short friendly follow-up about their video project."), step.from || "team");
          if (draft) {
            const { data: obIns } = await service.from("outbox").insert({ lead_id: lead.id, automation_id: au.id, run_id: run.id, kind: "workflow", sender: step.from || "team", subject: draft.subject, body: draft.body }).select("id").maybeSingle();
            if (obIns?.id) notifyOutbox(obIns.id);
            out.drafts = (out.drafts || 0) + 1;
          }
        } else if (step.type === "content_step") {
          // A pedido de Sebastián: quiere ver LOS 3 pasos de la secuencia para
          // aprobar juntos, no uno por vez a medida que van venciendo los
          // waits. Se arman TODOS los content_step restantes del camino en
          // esta misma corrida, cada uno con su fecha real de envío en
          // scheduled_at (respeta el espaciado original día+2/+5/+9 desde
          // que el lead entró — no se manda nada antes de tiempo, solo se
          // puede REVISAR antes). La sección 3 más abajo solo manda un
          // draft aprobado si ya llegó su scheduled_at.
          const enrolledAt = new Date(run.created_at).getTime();
          const cumulativeDays = (upTo: number) => {
            let d = 0;
            for (let i = 0; i < upTo; i++) if (steps[i]?.type === "wait") d += Math.max(0, +steps[i].days || 0);
            return d;
          };
          const lang = ["en", "de", "es"].includes(String(lead.lang)) ? String(lead.lang) : "en";
          for (let i = run.step_idx; i < steps.length; i++) {
            const st = steps[i];
            if (st.type !== "content_step") continue;
            const subject = fill(pick(st.subject, lang), lead);
            const bodyHtml = renderBlocks(st.blocks || [], lang, lead);
            const stepNum = steps.slice(0, i + 1).filter((s: { type: string }) => s.type === "content_step").length;
            const schedAt = new Date(enrolledAt + cumulativeDays(i) * 864e5).toISOString();
            const { data: obIns } = await service.from("outbox").insert({
              lead_id: lead.id, automation_id: au.id, run_id: run.id, kind: "content_followup",
              category: cfg.category || null, step: stepNum, sender: st.from || "team", subject, body: bodyHtml,
              status: "pending", scheduled_at: schedAt,
            }).select("id").maybeSingle();
            if (obIns?.id) notifyOutbox(obIns.id);
            out.drafts = (out.drafts || 0) + 1;
          }
          stepsSkippedToEnd = true; // ya no queda nada más que ejecutar en este camino
        } else if (step.type === "task") {
          await service.from("lead_tasks").insert({ lead_id: lead.id, title: "⚙️ " + fill(step.title, lead), due_date: new Date().toISOString().slice(0, 10), done: false });
        } else if (step.type === "push") {
          await fetch(`${SB_URL}/functions/v1/push-send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "⚙️ " + fill(step.title, lead), body: String(lead.name || lead.email) }) });
        } else if (step.type === "status") {
          await service.from("leads").update({ status: step.value || "contactado" }).eq("id", lead.id);
        }
      } catch (e) { console.error("STEP_ERROR", run.id, String(e)); }
      const nextIdx = stepsSkippedToEnd ? steps.length : run.step_idx + 1;
      await service.from("automation_runs").update({ step_idx: nextIdx, next_at: nextAt.toISOString(), status: nextIdx >= steps.length ? "done" : "active" }).eq("id", run.id);
      out.steps++;
      await new Promise((ok) => setTimeout(ok, 120));
    }
    // ============ 3) BANDEJA: enviar los aprobados ============
    // incluye 'content_followup' — antes solo lo mandaba el link de un-click
    // de outbox-action; si se aprobaba desde el dashboard (Bandeja de salida)
    // el borrador quedaba en status='approved' para siempre, sin nada que lo
    // agarre y lo mande de verdad. Bug real, encontrado al migrar content-followup acá.
    //
    // Fuera de horario laboral suizo: no se manda nada en esta corrida — los
    // aprobados quedan tal cual, la próxima corrida en horario los agarra.
    if (!isSwissBusinessHours()) return json({ ok: true, ...out, automations: (autos ?? []).length, skipped_out_of_hours: true });
    const nowIso2 = new Date().toISOString();
    const { data: appr } = await service.from("outbox").select("*").eq("status", "approved").in("kind", ["workflow", "content_followup"])
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso2}`).limit(50);
    for (const ob of appr ?? []) {
      const { data: lead } = await service.from("leads").select("id,email,name,first_name,company,lang,unsubscribed").eq("id", ob.lead_id).maybeSingle();
      if (!lead || !lead.email || (lead as { unsubscribed?: boolean }).unsubscribed || TEST.test(String(lead.email))) {
        await service.from("outbox").update({ status: "discarded" }).eq("id", ob.id); continue;
      }
      const F = FROMS[ob.sender] || FROMS.team;
      const unsub = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
      const senderName = ob.sender === "sebastian" ? "Sebastian" : "Sofia";
      const subjectFilled = fill(ob.subject, lead);
      // content_followup: el body ya salió de renderBlocks() como HTML con
      // tokens ya resueltos (fill() de nuevo acá es un no-op) — wrapRaw() no
      // escapa, a diferencia de wrap() que sí espera texto libre.
      const htmlFilled = ob.kind === "content_followup"
        ? wrapRaw(fill(ob.body, lead), unsub, String(lead.lang || "en"))
        : wrap(fill(ob.body, lead), unsub, String(lead.lang || "en"), senderName); // wrap() escapea los campos del lead sustituidos — nunca guardar fill() crudo
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
        body: JSON.stringify({ from: F.from, reply_to: F.reply, to: [lead.email], subject: subjectFilled, html: htmlFilled }),
      });
      if (res.ok) {
        await service.from("outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ob.id);
        await service.from("leads").update({ last_automated_email_at: new Date().toISOString() }).eq("id", lead.id);
        await service.from("email_log").insert({ lead_id: String(lead.id), to_addr: lead.email, subject: subjectFilled, body: htmlFilled, sender_label: senderName, source: "automations-run" }).then(() => {}, () => {});
        out.outbox_sent = (out.outbox_sent || 0) + 1;
      } else await service.from("outbox").update({ status: "failed" }).eq("id", ob.id);
      await new Promise((ok) => setTimeout(ok, 120));
    }
    return json({ ok: true, ...out, automations: (autos ?? []).length });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
