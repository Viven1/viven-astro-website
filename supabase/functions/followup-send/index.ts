// Supabase Edge Function: followup-send
// Corre por CRON cada 30 min — YA NO manda directo. A pedido de Sebastián
// (bandeja de salida sin excepciones), esta función tiene DOS fases:
//
//   1) DRAFT: lead_followups aprobados (por el vendedor, en la ficha del
//      contacto) cuya hora llegó → se convierten en un borrador de
//      📤 Bandeja de salida (kind='followup', followup_id=<id>). Si el lead
//      ya avanzó de etapa (won/lost) directamente se cancela, sin borrador.
//   2) SEND: borradores kind='followup' con status='approved' en el outbox
//      (aprobados desde el dashboard o desde el link de outbox-notify) →
//      recién ahí se arma el HTML de marca + CTA (con el status MÁS FRESCO
//      del lead) y se manda por Resend.
//
// Por qué dos fases y no mandar directo al aprobar en outbox: mismo motor que
// automations-run — el outbox es la ÚNICA puerta de salida.
//
// Deploy:    supabase functions deploy followup-send --no-verify-jwt
// Schedule:  Supabase Dashboard → Edge Functions → followup-send → Schedules → */30 * * * *
// Secrets:   RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// fix (auditoría 2026-07-14): sin auth, mismo riesgo que automations-run — cron
// pausado (migración 0060) pero función directamente invocable. Exige el secret compartido.
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

// solo se frena si el deal CERRÓ (ganado/perdido). Al avanzar de etapa, el dashboard
// ya cancela la secuencia vieja — y la nueva (ej. decisión sobre la oferta) es válida.
const STOP_STAGES = ["won", "ganado", "cerrado", "lost", "perdido"];
const SENDER = (k: string) => k === "sebastian"
  ? { name: "Sebastian Cepeda", email: "sebastian@viven.ch" }
  : { name: "Sofia Treviño", email: "sofia@viven.ch" };
const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

// avisa por email al remitente de un borrador nuevo (SQL 0063/outbox-notify) —
// best-effort: si falla, el borrador ya quedó pendiente en el dashboard igual.
function notifyOutbox(id: string | number) {
  fetch(`${SB_URL}/functions/v1/outbox-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}

async function ctaFor(lead: Record<string, unknown>, leadId: string | number): Promise<string> {
  const stage = String(lead.status || "").toLowerCase();
  const SITE = "https://www.viven.ch"; // LIVE ✓
  const BOOK_URL = SITE + "/book/";
  if (["new", "nuevo", "", "pending", "contacted", "contactado"].includes(stage)) {
    const label = lead.lang === "de" ? "📅 15-Min-Call buchen" : lead.lang === "es" ? "📅 Agendar un call de 15 min" : "📅 Book a 15-min call";
    return `<div style="text-align:center;margin:26px 0 4px"><a href="${BOOK_URL}" style="background:#ddf98f;color:#1c2508;font-weight:700;font-size:14px;text-decoration:none;border-radius:100px;padding:13px 26px;display:inline-block">${label}</a></div>`;
  }
  if (["proposal", "propuesta", "qualified"].includes(stage)) {
    const { data: prop } = await service.from("proposals").select("slug,password,status").eq("lead_id", String(leadId)).eq("is_template", false).not("slug", "is", null).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (prop?.slug) {
      const label = lead.lang === "de" ? "→ Ihre Offerte ansehen" : lead.lang === "es" ? "→ Ver tu propuesta" : "→ View your proposal";
      return `<div style="text-align:center;margin:26px 0 4px"><a href="${SITE}/proposal/?id=${encodeURIComponent(prop.slug)}" style="background:#ddf98f;color:#1c2508;font-weight:700;font-size:14px;text-decoration:none;border-radius:100px;padding:13px 26px;display:inline-block">${label}</a>${prop.password ? `<div style="font-size:11.5px;color:#8a94a8;margin-top:8px">Access code: <b style="color:#1a2230">${esc(prop.password)}</b></div>` : ""}</div>`;
    }
  }
  return "";
}
function brandHtml(bodyText: string, cta: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2230">
    <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:22px 28px">
      <span style="font-size:22px;font-weight:800;letter-spacing:-.02em;color:#ddf98f">viven</span>
      <span style="font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#9aa6bd;margin-left:10px">Film Production</span>
    </div>
    <div style="border:1px solid #e8eaef;border-top:0;border-radius:0 0 14px 14px;padding:26px 28px">
      <div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${esc(bodyText)}</div>
      ${cta}
      <p style="font-size:11px;color:#8a94a8;text-align:center;margin:22px 0 0;border-top:1px solid #e8eaef;padding-top:14px"><b style="color:#1a2230">VIVEN AG</b> · Film Production · Zeughausstrasse 31, 8004 Zürich<br>viven.ch · ★★★★★ 5.0 on Google (47 reviews)</p>
    </div></div>`;
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    let drafted = 0, canceled = 0, sent = 0, failed = 0;

    // ============ 1) DRAFT: aprobados + due → Bandeja de salida ============
    const { data: due, error } = await service.from("lead_followups")
      .select("*").eq("status", "approved").lte("send_at", new Date().toISOString()).limit(20);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    // idempotencia: no re-armar un borrador para un followup que ya tiene uno
    // (fu.status se queda en 'approved' hasta que realmente se manda)
    const dueIds = (due ?? []).map((f: { id: number }) => f.id);
    const already = new Set<number>();
    if (dueIds.length) {
      const { data: existing } = await service.from("outbox").select("followup_id").eq("kind", "followup").in("followup_id", dueIds);
      (existing ?? []).forEach((o: { followup_id: number }) => already.add(o.followup_id));
    }

    for (const fu of due ?? []) {
      if (already.has(fu.id)) continue;
      const { data: lead } = await service.from("leads").select("id,email,status").eq("id", fu.lead_id).maybeSingle();
      if (!lead || !lead.email) { await service.from("lead_followups").update({ status: "canceled" }).eq("id", fu.id); canceled++; continue; }
      if (STOP_STAGES.includes(String(lead.status || "").toLowerCase())) {
        await service.from("lead_followups").update({ status: "canceled" }).eq("lead_id", fu.lead_id).in("status", ["draft", "approved"]);
        canceled++; continue;
      }
      const { data: obIns } = await service.from("outbox").insert({
        lead_id: fu.lead_id, kind: "followup", followup_id: fu.id,
        sender: fu.sender_key || "sofia", subject: fu.subject, body: fu.body, status: "pending",
      }).select("id").maybeSingle();
      if (obIns?.id) notifyOutbox(obIns.id);
      drafted++;
    }

    // ============ 2) SEND: aprobados en la Bandeja (kind='followup') ============
    const { data: appr } = await service.from("outbox").select("*").eq("status", "approved").eq("kind", "followup").limit(50);
    for (const ob of appr ?? []) {
      const { data: lead } = await service.from("leads").select("*").eq("id", ob.lead_id).maybeSingle();
      if (!lead || !lead.email) { await service.from("outbox").update({ status: "discarded" }).eq("id", ob.id); continue; }
      // el deal cerró (o el follow-up fue cancelado desde la ficha) entre el draft y la aprobación → no mandar
      const stillApproved = ob.followup_id ? (await service.from("lead_followups").select("status").eq("id", ob.followup_id).maybeSingle()).data?.status === "approved" : true;
      if (STOP_STAGES.includes(String(lead.status || "").toLowerCase()) || !stillApproved) {
        await service.from("outbox").update({ status: "discarded" }).eq("id", ob.id);
        if (ob.followup_id) await service.from("lead_followups").update({ status: "canceled" }).eq("id", ob.followup_id).eq("status", "approved");
        canceled++; continue;
      }
      const snd = SENDER(ob.sender || "sofia");
      const cta = await ctaFor(lead, ob.lead_id);
      const html = brandHtml(ob.body, cta);
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${snd.name} — VIVEN AG <info@viven.ch>`, to: [lead.email], reply_to: snd.email, subject: ob.subject, html, text: ob.body }),
      });
      if (!res.ok) { console.error("RESEND_ERROR", res.status, await res.text()); failed++; continue; }   // reintenta en el próximo cron (queda 'approved')
      await service.from("outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ob.id);
      if (ob.followup_id) await service.from("lead_followups").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ob.followup_id);
      await service.from("lead_notes").insert({ lead_id: String(ob.lead_id), author: snd.name, body: "📬 Follow-up automático enviado: «" + ob.subject + "»" }).then(() => {}, () => {});
      await service.from("email_log").insert({ lead_id: String(ob.lead_id), to_addr: lead.email, subject: ob.subject, body: html, sender_label: snd.name, source: "followup-send" }).then(() => {}, () => {});
      sent++;
    }

    return new Response(JSON.stringify({ ok: true, drafted, sent, canceled, failed }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
