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

// etapas donde la secuencia ya no tiene sentido (el deal avanzó o cerró)
const STOP_STAGES = ["videocall", "video call booked", "call", "booked", "proposal", "propuesta", "qualified", "won", "ganado", "cerrado", "lost", "perdido"];
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
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.65;color:#1a2230;max-width:600px">${esc(fu.body).replace(/\n/g, "<br>")}</div>`;
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
