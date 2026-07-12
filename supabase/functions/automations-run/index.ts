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

const TEST = /@viven\.ch$|@entropia|@example\.|test/i;
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
  return String(t || "").replaceAll("{{first_name}}", first).replaceAll("{{name}}", String(lead.name || first)).replaceAll("{{company}}", String(lead.company || ""));
}
function wrap(bodyText: string, unsub: string, lang: string, sender: string): string {
  const bye = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" }[lang] || "Unsubscribe";
  const paras = bodyText.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#222">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#5b7cfa">$1</a>').replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><span style="color:#fff;font-weight:800;font-size:19px;letter-spacing:.5px">viven<span style="color:#ddf98f">.</span></span></div>
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
        const q = await service.from("leads").select("id,email,name,first_name,company,lang,status,created_at,contacted_at,unsubscribed").not("email", "is", null).lte("created_at", new Date(Date.now() - days * 864e5).toISOString()).gte("created_at", new Date(Date.now() - (days + 14) * 864e5).toISOString());
        cands = (q.data ?? []).filter((r) => isNuevo(String(r.status)) || String(r.status).toLowerCase() === "contactado" || String(r.status).toLowerCase() === "contacted");
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
      const step = steps[run.step_idx];
      let nextAt = new Date();
      if (body.dry_run) { out.steps++; continue; }
      try {
        if (step.type === "wait") {
          nextAt = new Date(Date.now() + (Math.max(0, +step.days || 1)) * 864e5);
        } else if (step.type === "email") {
          const F = FROMS[step.from] || FROMS.team;
          const unsub = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
          const sender = (FROMS[step.from] ? (step.from === "team" ? "Sofia & Sebastian" : step.from === "sofia" ? "Sofia" : "Sebastian") : "Sofia & Sebastian");
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
            body: JSON.stringify({ from: F.from, reply_to: F.reply, to: [lead.email], subject: fill(step.subject, lead), html: wrap(fill(step.body, lead), unsub, String(lead.lang || "en"), sender) }),
          });
          if (res.ok) out.emails++; else console.error("RESEND_FAIL", lead.email, res.status);
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
    return json({ ok: true, ...out, automations: (autos ?? []).length });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
