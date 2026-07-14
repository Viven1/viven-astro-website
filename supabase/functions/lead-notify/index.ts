// Supabase Edge Function: lead-notify
// Disparada por un Database Webhook en INSERT sobre `leads`.
// Manda un email instantáneo a info@viven.ch vía Resend.
//
// Deploy:  supabase functions deploy lead-notify --no-verify-jwt
// Secret:  supabase secrets set RESEND_API_KEY=re_xxx
// Webhook: Supabase → Database → Webhooks → New:
//          tabla=leads, evento=INSERT, tipo=Supabase Edge Function → lead-notify
//          HTTP Headers → agregar Authorization: Bearer <CRON_SECRET>
//
// fix (auditoría 2026-07-14): invocable sin auth por cualquiera con un body
// { record: {...} } armado a mano — filtraba nombre/mensaje/campaña de leads
// reales y podía spammear el push del team. Exige el mismo CRON_SECRET
// compartido que el resto de las funciones internas — el Database Webhook
// tiene que mandarlo como header custom (configuración manual en el
// Dashboard, ver arriba; no se puede setear desde una migración SQL).

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const TO = "info@viven.ch";
const FROM = "Viven Leads <leads@viven.ch>"; // dominio verificado en Resend
const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

// push al celular de todo el team (best-effort: sin VAPID/suscripciones, no molesta)
async function pushBroadcast(title: string, body: string, url = "/dashboard/") {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  try {
    webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: subs } = await service.from("push_subscriptions").select("*");
    const payload = JSON.stringify({ title, body, url });
    for (const s of subs ?? []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await service.from("push_subscriptions").delete().eq("id", s.id);
      }
    }
  } catch (e) { console.error("PUSH_ERROR", String(e)); }
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await req.json();
    const r = body.record ?? body; // webhook trae { type, table, record }

    // 'manual' = lo cargó el equipo mismo desde Personas → no es un lead nuevo real,
    // avisarnos de algo que acabamos de hacer nosotros no tiene sentido
    if (r.channel === "manual") return new Response(JSON.stringify({ ok: true, skipped: "manual" }), { headers: { "Content-Type": "application/json" } });

    const name = r.name || `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—";
    const rows: [string, unknown][] = [
      ["Nombre", name],
      ["Email", r.email],
      ["Mensaje", r.message || "—"],
      ["Canal", r.channel || "direct"],
      ["Campaña", r.utm_campaign || "—"],
      ["Google Ads (gclid)", r.gclid ? "sí" : "no"],
      ["Landing", r.landing_path || "—"],
      ["Idioma", r.lang || "—"],
    ];
    const html = `
      <h2 style="font-family:sans-serif;margin:0 0 12px">🎬 Nuevo lead — ${esc(name)}</h2>
      <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
        ${rows.map(([k, v]) => `<tr>
          <td style="padding:4px 12px 4px 0;color:#667;white-space:nowrap">${k}</td>
          <td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join("")}
      </table>
      <p style="font-family:sans-serif;font-size:13px;margin-top:16px">
        <a href="https://www.viven.ch/dashboard/">Abrir en el dashboard →</a>
      </p>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [TO], reply_to: r.email || undefined,
        subject: `Nuevo lead: ${name}${r.email ? " · " + r.email : ""}`,
        html,
      }),
    });
    // push al celular (además del email) — abre el lead directo al tocarla
    await pushBroadcast("🎬 Nuevo lead: " + name, (r.message || "").slice(0, 120) || (r.email || ""), r.id ? "/dashboard/?lead=" + r.id : "/dashboard/");

    if (!res.ok) return new Response(await res.text(), { status: 502 });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
