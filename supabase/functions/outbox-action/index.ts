// Supabase Edge Function: outbox-action
// Botones de UN CLICK del email de outbox-notify (GET, sin login — auth vía
// token HMAC-like, mismo esquema que newsletter-unsub). Dos acciones:
//   ?action=approve → manda el email YA MISMO por Resend (no espera al cron)
//   ?action=discard → marca el borrador como descartado
// Nadie más puede aprobar/descartar adivinando IDs porque el token depende
// del id + un secreto del server (RESEND_API_KEY, igual que el resto del código).
//
// Deploy: supabase functions deploy outbox-action --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND = Deno.env.get("RESEND_API_KEY")!;

async function obToken(id: string): Promise<string> {
  const data = new TextEncoder().encode("ob|" + String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const page = (msg: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>VIVEN — Bandeja de salida</title><body style="font-family:sans-serif;background:#0f1826;color:#f4f6fb;display:grid;place-items:center;min-height:100vh;text-align:center;margin:0"><div style="max-width:420px;padding:24px"><p style="font-size:40px;margin:0">📤</p><h1 style="font-size:20px">${msg}</h1><p style="color:#9aa6bd"><a href="https://www.viven.ch" style="color:#ddf98f">viven.ch</a></p></div>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

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
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${paras}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${esc(sender)}, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${bye}</a></p>
</div></body>`;
}

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id"), action = u.searchParams.get("action"), token = u.searchParams.get("token");
    if (!id || !action || !token || token !== await obToken(id)) return page("Link inválido o vencido.");
    const { data: ob, error } = await service.from("outbox").select("*").eq("id", id).maybeSingle();
    if (error || !ob) return page("Borrador no encontrado (¿ya fue procesado?).");
    if (ob.status !== "pending") return page("Este borrador ya se marcó como «" + ob.status + "» — nada que hacer.");

    if (action === "discard") {
      await service.from("outbox").update({ status: "discarded" }).eq("id", id);
      return page("Descartado — no se envía.");
    }
    if (action !== "approve") return page("Acción desconocida.");

    const { data: lead } = await service.from("leads").select("id,email,name,first_name,company,lang,unsubscribed").eq("id", ob.lead_id).maybeSingle();
    if (!lead || !lead.email || lead.unsubscribed) {
      await service.from("outbox").update({ status: "discarded" }).eq("id", id);
      return page("El contacto no tiene email válido o está dado de baja — descartado.");
    }
    const F = FROMS[ob.sender] || FROMS.team;
    const unsub = `${Deno.env.get("SUPABASE_URL")}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
    const subjectFilled = fill(ob.subject, lead);
    const htmlFilled = ob.kind === "followup"
      ? `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a2230"><div style="border:1px solid #e8eaef;border-radius:14px;padding:26px 28px"><div style="font-size:15px;line-height:1.7;white-space:pre-wrap">${esc(fill(ob.body, lead))}</div></div></div>`
      : wrap(fill(ob.body, lead), unsub, String(lead.lang || "en"), F.name);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: F.from, reply_to: F.reply, to: [lead.email], subject: subjectFilled, html: htmlFilled }),
    });
    if (!res.ok) { await service.from("outbox").update({ status: "failed" }).eq("id", id); return page("Resend falló al enviar — quedó marcado como fallido, revisá en el dashboard."); }
    await service.from("outbox").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id);
    await service.from("leads").update({ last_automated_email_at: new Date().toISOString() }).eq("id", lead.id).then(() => {}, () => {});
    if (ob.kind === "followup" && ob.followup_id) await service.from("lead_followups").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", ob.followup_id).then(() => {}, () => {});
    await service.from("email_log").insert({ lead_id: String(lead.id), to_addr: lead.email, subject: subjectFilled, body: htmlFilled, sender_label: F.name, source: "outbox-action" }).then(() => {}, () => {});
    return page("✅ Enviado a " + lead.email + ".");
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return page("Error inesperado — probá desde el dashboard.");
  }
});
