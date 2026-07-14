// Supabase Edge Function: outbox-notify
// Avisa por email al miembro del team dueño de un borrador nuevo en la
// 📤 Bandeja de salida (outbox), con el contenido del draft y dos links de
// UN CLICK (sin login) para aprobar o descartar directo desde el celular:
//   .../functions/v1/outbox-action?id=<id>&action=approve&token=<t>
//   .../functions/v1/outbox-action?id=<id>&action=discard&token=<t>
// El token es el mismo esquema que newsletter-unsub: sha256(id + secret) recortado.
//
// Llamada BEST-EFFORT desde automations-run/nurture/followup-send justo
// después de insertar una fila en outbox — si esta función falla, NO bloquea
// el flujo principal (el borrador ya quedó pendiente en el dashboard igual).
// No la llama ningún cron todavía — se dispara manualmente desde las otras
// funciones vía fetch(), best-effort (sin esperar ni frenar por su resultado).
//
// Deploy: supabase functions deploy outbox-notify --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// mismo esquema que newsletter-unsub / automations-run / nurture (sha256 recortado) —
// pero con una sal propia ("ob|") para que este token no sirva para dar de baja a nadie.
async function obToken(id: string): Promise<string> {
  const data = new TextEncoder().encode("ob|" + String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const SENDER_EMAIL: Record<string, string> = { sofia: "sofia@viven.ch", sebastian: "sebastian@viven.ch", team: "info@viven.ch" };
const SENDER_NAME: Record<string, string> = { sofia: "Sofia", sebastian: "Sebastian", team: "el team" };

Deno.serve(async (req) => {
  try {
    const { id } = await req.json().catch(() => ({}));
    if (!id) return json({ error: "falta id" }, 400);
    const { data: ob, error } = await service.from("outbox").select("*").eq("id", id).maybeSingle();
    if (error || !ob) return json({ error: "outbox no encontrado" }, 404);
    if (ob.status !== "pending") return json({ ok: true, skipped: "not_pending" });

    let leadName = "Lead #" + ob.lead_id, leadEmail = "";
    try {
      const { data: lead } = await service.from("leads").select("name,email,company").eq("id", ob.lead_id).maybeSingle();
      if (lead) { leadName = lead.name || lead.email || leadName; leadEmail = lead.email || ""; }
    } catch (_e) { /* best-effort */ }

    const to = SENDER_EMAIL[ob.sender] || SENDER_EMAIL.team;
    const kindLabel = ob.kind === "nurture" ? "🌱 Nurture" : ob.kind === "followup" ? "📬 Follow-up" : "⚙️ Workflow";
    const token = await obToken(id);
    const approveUrl = `${SB_URL}/functions/v1/outbox-action?id=${encodeURIComponent(id)}&action=approve&token=${token}`;
    const discardUrl = `${SB_URL}/functions/v1/outbox-action?id=${encodeURIComponent(id)}&action=discard&token=${token}`;

    if (!RESEND) return json({ ok: true, skipped: "no_resend_key" });
    const html = `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:#888">${esc(kindLabel)} · nuevo borrador para ${esc(SENDER_NAME[ob.sender] || "el team")}</p>
    <p style="margin:0 0 16px;font-size:16px;font-weight:700;color:#0f1826">Para: ${esc(leadName)}${leadEmail ? " &lt;" + esc(leadEmail) + "&gt;" : ""}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase">Asunto</p>
    <p style="margin:0 0 16px;font-size:15px;color:#222;font-weight:600">${esc(ob.subject)}</p>
    <p style="margin:0 0 6px;font-size:12px;color:#888;text-transform:uppercase">Cuerpo</p>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#444;white-space:pre-wrap">${esc(String(ob.body || "").slice(0, 800))}</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <a href="${approveUrl}" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:100px;display:inline-block">✅ Aprobar y enviar</a>
      <a href="${discardUrl}" style="background:#eee;color:#333;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:100px;display:inline-block">✕ No enviar</a>
    </div>
    <p style="margin:20px 0 0;font-size:12.5px;color:#999">O revisá/editá primero en el dashboard → 📤 Bandeja de salida.</p>
  </div>
</div></body>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Viven Dashboard <info@viven.ch>", to: [to], subject: `📤 Nuevo borrador para aprobar — ${leadName}`, html }),
    });
    if (!res.ok) return json({ error: "resend_failed", status: res.status }, 502);
    return json({ ok: true, to });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
