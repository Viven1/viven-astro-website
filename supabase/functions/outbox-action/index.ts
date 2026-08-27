// Supabase Edge Function: outbox-action
// Botones de UN CLICK del email de outbox-notify (sin login — auth vía
// token HMAC-like, mismo esquema que newsletter-unsub). Dos acciones:
//   ?action=approve → manda el email YA MISMO por Resend (no espera al cron)
//   ?action=discard → marca el borrador como descartado
// Nadie más puede aprobar/descartar adivinando IDs porque el token depende
// del id + un secreto del server (RESEND_API_KEY, igual que el resto del código).
//
// fix real (2026-07-20): un GET a esta URL ejecutaba la acción directo —
// eso es exactamente lo que escáneres de seguridad de email (Safe Links de
// Microsoft, Link Tracking Protection de Apple Mail, proxies de Gmail)
// visitan solos para revisar que el link no sea malicioso, ANTES de que la
// persona lo vea. Resultado real observado: 6 borradores de contenido
// quedaron con status='approved' sin que Sebastián tocara nada. Ahora un
// GET solo muestra una página de confirmación (con un <form method="POST">
// real) — la acción se ejecuta recién en el POST, que ningún escáner
// automático envía.
//
// Deploy: supabase functions deploy outbox-action --no-verify-jwt

import { autolink } from "../_shared/autolink.ts";
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
// página de confirmación para el GET — el <form method="POST"> es lo que un
// escáner de seguridad NUNCA envía (solo sigue GET), así que la acción real
// queda a salvo de clics fantasma.
function confirmPage(actionUrl: string, actionLabel: string, danger: boolean, toName: string, subject: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>VIVEN — Bandeja de salida</title><body style="font-family:sans-serif;background:#0f1826;color:#f4f6fb;display:grid;place-items:center;min-height:100vh;text-align:center;margin:0"><div style="max-width:420px;padding:24px">
      <p style="font-size:40px;margin:0 0 8px">📤</p>
      <h1 style="font-size:18px;margin:0 0 6px">Confirmar acción</h1>
      <p style="color:#9aa6bd;margin:0 0 4px">Para: <b style="color:#f4f6fb">${esc(toName)}</b></p>
      <p style="color:#9aa6bd;margin:0 0 20px">Asunto: ${esc(subject)}</p>
      <form method="POST" action="${esc(actionUrl)}">
        <button type="submit" style="background:${danger ? "#eee" : "#ddf98f"};color:${danger ? "#333" : "#1c2508"};font-weight:700;font-size:15px;border:0;border-radius:100px;padding:14px 28px;cursor:pointer">${esc(actionLabel)}</button>
      </form>
      <p style="color:#9aa6bd;margin-top:18px"><a href="https://www.viven.ch" style="color:#9aa6bd">Cancelar</a></p>
    </div>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const FROMS: Record<string, { from: string; reply: string; name: string }> = {
  /* De la persona, no del buzón general — ver la nota en automations-run. */
  sofia: { from: "Sofia Treviño — VIVEN <sofia@viven.ch>", reply: "sofia@viven.ch", name: "Sofia" },
  sebastian: { from: "Sebastian Cepeda — VIVEN <sebastian@viven.ch>", reply: "sebastian@viven.ch", name: "Sebastian" },
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
    `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#222">${autolink(esc(p)).replace(/\n/g, "<br>")}</p>`).join("");
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${paras}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${esc(sender)}, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${bye}</a></p>
</div></body>`;
}
// content-followup arma su body como HTML ya listo (thumbnails de video +
// link cards) del lado del server, no texto libre — a diferencia de wrap(),
// NO se escapa (si no, <img>/<table> quedarían como texto literal en el mail).
// mismo gate que automations-run/followup-send: el link de un-click no debe
// saltarse ni la fecha programada (scheduled_at, content_followup) ni el
// horario laboral suizo — si no corresponde mandar YA, se deja 'approved'
// para que el cron lo mande en la próxima ventana válida.
//
// EL CORTE DE MEDIODÍA (12:00-13:30) ES A PROPÓSITO. Confirmado por Sebastián
// el 11 ago 2026 al revisar la ventana: NO unificar en un 09:30-17:00 corrido
// aunque parezca más simple. Copia exacta de la de automations-run — si tocás
// una, tocá la otra.
function isSwissBusinessHours(d = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Zurich", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const mins = (+get("hour")) * 60 + (+get("minute"));
  return (mins >= 9 * 60 && mins < 12 * 60) || (mins >= 13 * 60 + 30 && mins < 17 * 60);
}
function wrapRaw(bodyHtml: string, unsub: string, lang: string): string {
  const bye = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" }[lang] || "Unsubscribe";
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">${bodyHtml}</div>
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
    if (action !== "approve" && action !== "discard") return page("Acción desconocida.");

    if (req.method !== "POST") {
      const { data: leadPreview } = await service.from("leads").select("name,email").eq("id", ob.lead_id).maybeSingle();
      const toName = leadPreview?.name || leadPreview?.email || ("Lead #" + ob.lead_id);
      // req.url adentro de la function refleja la URL INTERNA (sin /functions/v1/,
      // a veces http://) — nunca la pública. Reconstruimos la URL real a partir
      // de SUPABASE_URL, si no el <form action> queda roto (404 al aprobar).
      const publicActionUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/outbox-action?id=${encodeURIComponent(id)}&action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}`;
      return confirmPage(publicActionUrl, action === "approve" ? "✅ Sí, aprobar y enviar" : "✕ Sí, descartar", action === "discard", toName, ob.subject);
    }

    if (action === "discard") {
      await service.from("outbox").update({ status: "discarded" }).eq("id", id);
      return page("Descartado — no se envía.");
    }

    // VENTANA DE ARREPENTIMIENTO (2026-07-27, tras una aprobación por error):
    // aprobar NUNCA envía al instante. Se programa a +10 minutos (o la fecha
    // futura ya agendada, si es posterior) y el envío real lo hace el pipeline
    // (automations-run), que ya valida lead/baja/test y respeta horario laboral.
    // Deshacer: Bandeja de salida del dashboard, mientras no haya salido.
    const undoAt = new Date(Date.now() + 10 * 60e3);
    const prevSched = ob.scheduled_at ? new Date(ob.scheduled_at) : null;
    const sched = prevSched && prevSched > undoAt ? prevSched : undoAt;
    await service.from("outbox").update({ status: "approved", scheduled_at: sched.toISOString() }).eq("id", id);
    if (prevSched && prevSched > undoAt) {
      const when = prevSched.toLocaleDateString("es-CH", { day: "numeric", month: "long", timeZone: "Europe/Zurich" });
      return page("✅ Aprobado — sale automáticamente el " + when + ". Hasta entonces podés deshacerlo desde la Bandeja del dashboard.");
    }
    return page("✅ Aprobado — sale en ~10 minutos (en horario laboral). ¿Te arrepentiste? Deshacelo desde la Bandeja del dashboard antes de que salga.");
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return page("Error inesperado — probá desde el dashboard.");
  }
});
