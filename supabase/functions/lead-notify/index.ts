// Supabase Edge Function: lead-notify
// Disparada por un Database Webhook en INSERT sobre `leads`.
// Manda un email instantáneo a info@viven.ch vía Resend.
//
// Deploy:  supabase functions deploy lead-notify --no-verify-jwt
// Secret:  supabase secrets set RESEND_API_KEY=re_xxx
// Webhook: Supabase → Database → Webhooks → New:
//          tabla=leads, evento=INSERT, tipo=Supabase Edge Function → lead-notify

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const TO = "info@viven.ch";
const FROM = "Viven Leads <leads@viven.ch>"; // dominio verificado en Resend
const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const r = body.record ?? body; // webhook trae { type, table, record }

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
    if (!res.ok) return new Response(await res.text(), { status: 502 });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
