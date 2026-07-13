// Supabase Edge Function: automations-run
// MOTOR de las automatizaciones del dashboard (tab ⚙️): inscribe leads que
// matchean el trigger de cada automatización activa y ejecuta los pasos de su
// camino (A o B según el split). Cron cada 20 min (SQL 0041).
//
// Triggers:  lead_new {source?, lang?, channel?} · stage {stage} · inactivity {days}
// Pasos:     email {from, subject, body} · wait {days} · task {title} ·
//            push {title} · status {value}
// Tokens en subject/body: {{first_name}} {{name}} {{company}}
// Frenos: unsubscribed, emails de test, un run por lead y automatización (unique).
//
// Deploy: supabase functions deploy automations-run --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
function fill(t: string, lead: Record<string, unknown>): string {
  const first = String(lead.first_name || String(lead.name || "").split(" ")[0] || "").trim();
  const refCode = String(lead.referral_code || "");
  return String(t || "")
    .replaceAll("{{first_name}}", first)
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

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const { data: autos, error: aerr } = await service.from("automations").select("*").eq("enabled", true);
    if (aerr) return json({ error: aerr.message }, 500);
    const out: Record<string, number> = { enrolled: 0, steps: 0, emails: 0, done: 0, skipped: 0 };

    // ============ 1) INSCRIPCIÓN ============
    for (const au of autos ?? []) {
      const cfg = au.trigger_config || {};
      let cands: Record<string, unknown>[] = [];
      const since = new Date(Date.now() - 10 * 864e5).toISOString();
      if (au.trigger === "lead_new") {
        const q = await service.from("leads").select("id,email,name,first_name,company,lang,status,channel,source,message,created_at,unsubscribed").gte("created_at", since).not("email", "is", null);
        cands = (q.data ?? []).filter((r) => {
          if (cfg.source === "calculator" && !String(r.message || "").includes("CALCULADORA") && r.source !== "calculator") return false;
          if (cfg.source === "form" && (String(r.message || "").includes("CALCULADORA") || r.source === "calculator")) return false;
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
      if ((step.type === "email" || step.type === "ai_email") && lead.last_automated_email_at &&
          Date.now() - new Date(lead.last_automated_email_at).getTime() < 5 * 864e5 && !(run.step_idx === 0 && au.trigger === "lead_new")) {
        await service.from("automation_runs").update({ next_at: new Date(Date.now() + 2 * 864e5).toISOString() }).eq("id", run.id);
        out.throttled = (out.throttled || 0) + 1; continue;
      }
      let nextAt = new Date();
      if (body.dry_run) { out.steps++; continue; }
      try {
        if (step.type === "wait") {
          nextAt = new Date(Date.now() + (Math.max(0, +step.days || 1)) * 864e5);
        } else if (step.type === "email") {
          const F = FROMS[step.from] || FROMS.team;
          const unsub = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
          const sender = (FROMS[step.from] ? (step.from === "team" ? "Sofia" : step.from === "sofia" ? "Sofia" : "Sebastian") : "Sofia");
          const subjectFilled = fill(step.subject, lead);
          const htmlFilled = wrap(fill(step.body, lead), unsub, String(lead.lang || "en"), sender); // wrap() escapea los campos del lead sustituidos — nunca guardar fill() crudo
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
            body: JSON.stringify({ from: F.from, reply_to: F.reply, to: [lead.email], subject: subjectFilled, html: htmlFilled }),
          });
          if (res.ok) {
            out.emails++;
            await service.from("leads").update({ last_automated_email_at: new Date().toISOString() }).eq("id", lead.id);
            await service.from("email_log").insert({ lead_id: String(lead.id), to_addr: lead.email, subject: subjectFilled, body: htmlFilled, sender_label: sender, source: "automations-run" }).then(() => {}, () => {});
          } else console.error("RESEND_FAIL", lead.email, res.status);
        } else if (step.type === "ai_email") {
          // borrador IA → BANDEJA DE SALIDA (nunca sale sin aprobación humana)
          const draft = await aiDraft(lead, String(step.prompt || "Short friendly follow-up about their video project."), step.from || "team");
          if (draft) { await service.from("outbox").insert({ lead_id: lead.id, automation_id: au.id, run_id: run.id, sender: step.from || "team", subject: draft.subject, body: draft.body }); out.drafts = (out.drafts || 0) + 1; }
        } else if (step.type === "task") {
          await service.from("lead_tasks").insert({ lead_id: lead.id, title: "⚙️ " + fill(step.title, lead), due_date: new Date().toISOString().slice(0, 10), done: false });
        } else if (step.type === "push") {
          await fetch(`${SB_URL}/functions/v1/push-send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "⚙️ " + fill(step.title, lead), body: String(lead.name || lead.email) }) });
        } else if (step.type === "status") {
          await service.from("leads").update({ status: step.value || "contactado" }).eq("id", lead.id);
        }
      } catch (e) { console.error("STEP_ERROR", run.id, String(e)); }
      const nextIdx = run.step_idx + 1;
      await service.from("automation_runs").update({ step_idx: nextIdx, next_at: nextAt.toISOString(), status: nextIdx >= steps.length ? "done" : "active" }).eq("id", run.id);
      out.steps++;
      await new Promise((ok) => setTimeout(ok, 120));
    }
    // ============ 3) BANDEJA: enviar los aprobados (los de nurture los envía y marca la función nurture) ============
    const { data: appr } = await service.from("outbox").select("*").eq("status", "approved").eq("kind", "workflow").limit(50);
    for (const ob of appr ?? []) {
      const { data: lead } = await service.from("leads").select("id,email,name,first_name,company,lang,unsubscribed").eq("id", ob.lead_id).maybeSingle();
      if (!lead || !lead.email || (lead as { unsubscribed?: boolean }).unsubscribed || TEST.test(String(lead.email))) {
        await service.from("outbox").update({ status: "discarded" }).eq("id", ob.id); continue;
      }
      const F = FROMS[ob.sender] || FROMS.team;
      const unsub = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
      const senderName = ob.sender === "sebastian" ? "Sebastian" : "Sofia";
      const subjectFilled = fill(ob.subject, lead);
      const htmlFilled = wrap(fill(ob.body, lead), unsub, String(lead.lang || "en"), senderName); // wrap() escapea los campos del lead sustituidos — nunca guardar fill() crudo
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
