// Supabase Edge Function: followup-send
// Corre por CRON cada 30 min: manda los follow-ups APROBADOS cuya hora llegó,
// al email del lead, vía Resend. Si el lead ya avanzó de etapa (video call,
// propuesta, ganado, perdido), cancela los pendientes en vez de mandar.
//
// Deploy:    supabase functions deploy followup-send --no-verify-jwt
// Schedule:  Supabase Dashboard → Edge Functions → followup-send → Schedules → */30 * * * *
// Secrets:   RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

// solo se frena si el deal CERRÓ (ganado/perdido). Al avanzar de etapa, el dashboard
// ya cancela la secuencia vieja — y la nueva (ej. decisión sobre la oferta) es válida.
const STOP_STAGES = ["won", "ganado", "cerrado", "lost", "perdido"];
const SENDER = (k: string) => k === "sebastian"
  ? { name: "Sebastian Cepeda", email: "sebastian@viven.ch" }
  : { name: "Sofia Treviño", email: "sofia@viven.ch" };
const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

Deno.serve(async (_req) => {
  try {
    const { data: due, error } = await service.from("lead_followups")
      .select("*").eq("status", "approved").lte("send_at", new Date().toISOString()).limit(20);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    let sent = 0, canceled = 0;
    for (const fu of due ?? []) {
      const { data: lead } = await service.from("leads").select("*").eq("id", fu.lead_id).maybeSingle();
      if (!lead || !lead.email) { await service.from("lead_followups").update({ status: "canceled" }).eq("id", fu.id); canceled++; continue; }
      // el deal avanzó → cancelar TODOS los pendientes de este lead
      if (STOP_STAGES.includes(String(lead.status || "").toLowerCase())) {
        await service.from("lead_followups").update({ status: "canceled" }).eq("lead_id", fu.lead_id).in("status", ["draft", "approved"]);
        canceled++; continue;
      }
      const snd = SENDER(fu.sender_key || "sofia");
      // CTA según la etapa: sin call → botón de booking; oferta/propuesta enviada → link a la propuesta si existe
      const stage = String(lead.status || "").toLowerCase();
      const SITE = "https://viven-astro-website.viven-ag.workers.dev"; // TODO al ir live: https://www.viven.ch
      const BOOK_URL = SITE + "/book/";
      let cta = "";
      if (["new", "nuevo", "", "pending", "contacted", "contactado"].includes(stage)) {
        const label = lead.lang === "de" ? "📅 15-Min-Call buchen" : lead.lang === "es" ? "📅 Agendar un call de 15 min" : "📅 Book a 15-min call";
        cta = `<div style="text-align:center;margin:26px 0 4px"><a href="${BOOK_URL}" style="background:#ddf98f;color:#1c2508;font-weight:700;font-size:14px;text-decoration:none;border-radius:100px;padding:13px 26px;display:inline-block">${label}</a></div>`;
      } else if (["proposal", "propuesta", "qualified"].includes(stage)) {
        const { data: prop } = await service.from("proposals").select("slug,password,status").eq("lead_id", String(fu.lead_id)).eq("is_template", false).not("slug", "is", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
        if (prop?.slug) {
          const label = lead.lang === "de" ? "→ Ihre Offerte ansehen" : lead.lang === "es" ? "→ Ver tu propuesta" : "→ View your proposal";
          cta = `<div style="text-align:center;margin:26px 0 4px"><a href="${SITE}/proposal/?id=${encodeURIComponent(prop.slug)}" style="background:#ddf98f;color:#1c2508;font-weight:700;font-size:14px;text-decoration:none;border-radius:100px;padding:13px 26px;display:inline-block">${label}</a>${prop.password ? `<div style="font-size:11.5px;color:#8a94a8;margin-top:8px">Access code: <b style="color:#1a2230">${esc(prop.password)}</b></div>` : ""}</div>`;
        }
      }
      // email con el diseño de marca (mismo estilo que el email de oferta)
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2230">
        <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:22px 28px">
          <span style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ddf98f">viven</span>
          <span style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#9aa6bd;margin-left:10px">Film Production</span>
        </div>
        <div style="border:1px solid #e8eaef;border-top:0;border-radius:0 0 14px 14px;padding:26px 28px">
          <div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${esc(fu.body)}</div>
          ${cta}
          <p style="font-size:11px;color:#8a94a8;text-align:center;margin:22px 0 0;border-top:1px solid #e8eaef;padding-top:14px"><b style="color:#1a2230">VIVEN AG</b> · Film Production · Zeughausstrasse 31, 8004 Zürich<br>viven.ch · ★★★★★ 5.0 on Google (47 reviews)</p>
        </div></div>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${snd.name} — VIVEN AG <info@viven.ch>`, to: [lead.email], reply_to: snd.email, subject: fu.subject, html, text: fu.body }),
      });
      if (!res.ok) { console.error("RESEND_ERROR", res.status, await res.text()); continue; }   // reintenta en el próximo cron
      await service.from("lead_followups").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", fu.id);
      // registrar como actividad en el historial del lead
      await service.from("lead_notes").insert({ lead_id: String(fu.lead_id), author: snd.name, body: "📬 Follow-up automático enviado: «" + fu.subject + "»" }).then(() => {}, () => {});
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, sent, canceled }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
