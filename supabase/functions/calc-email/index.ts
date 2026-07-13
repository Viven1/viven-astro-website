// Supabase Edge Function: calc-email
// PRIMER TOUCHPOINT de la calculadora de presupuesto: en vez de revelar el
// rango CHF en la página, se lo mandamos por email al instante — la bandeja
// de entrada es el "unlock". Público (sin auth), llamado directo desde
// site.js al enviar el formulario de la calculadora.
//
// Deploy: supabase functions deploy calc-email --no-verify-jwt
// Usa:    RESEND_API_KEY (ya seteado)

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

const T: Record<string, Record<string, string>> = {
  en: {
    subject: "Your video cost estimate: CHF",
    hi: "Hi",
    intro: "Thank you for your enquiry — here is the cost estimate you requested, based on real budgets from over 100 Swiss productions for brands like UBS, Siemens and FIFA.",
    basedOn: "Your cost breakdown:",
    note: "Every project is different, and these figures are an honest starting point — not a fixed quote. If the estimate sits above your budget, we can usually help bring the costs down: adjusting shoot days, scope or format, without compromising the result. If you'd like to go through the details, don't hesitate to contact us — we're happy to think along with you.",
    cta: "Book a free 15-min call →",
    bye: "Prefer email? Just reply to this message — it lands directly with me.",
    sign: "Sofia Treviño, Producer",
    foot: "You're receiving this because you used our video cost calculator.",
  },
  de: {
    subject: "Ihre Videokosten-Schätzung: CHF",
    hi: "Guten Tag",
    intro: "vielen Dank für Ihre Anfrage — hier ist die gewünschte Kostenschätzung, basierend auf echten Budgets aus über 100 Schweizer Produktionen für Marken wie UBS, Siemens und FIFA.",
    basedOn: "Ihre Kostenaufstellung:",
    note: "Jedes Projekt ist anders — diese Zahlen sind ein ehrlicher Richtwert, keine fixe Offerte. Liegt die Schätzung über Ihrem Budget, helfen wir gerne, die Kosten zu senken: über Drehtage, Umfang oder Format, ohne Kompromisse beim Resultat. Möchten Sie ins Detail gehen? Kontaktieren Sie uns jederzeit — wir denken gerne mit.",
    cta: "Gratis 15-Min-Call buchen →",
    bye: "Lieber per E-Mail? Antworten Sie einfach auf diese Nachricht — sie landet direkt bei mir.",
    sign: "Sofia Treviño, Producerin",
    foot: "Sie erhalten dies, weil Sie unseren Videokosten-Rechner genutzt haben.",
  },
  es: {
    subject: "Tu estimación de costos de video: CHF",
    hi: "Hola",
    intro: "gracias por tu consulta — acá tenés la estimación de costos que pediste, basada en presupuestos reales de más de 100 producciones suizas para marcas como UBS, Siemens y FIFA.",
    basedOn: "Tu desglose de costos:",
    note: "Cada proyecto es distinto y estos números son un punto de partida honesto, no una oferta cerrada. Si la estimación queda por encima de tu presupuesto, normalmente podemos ayudarte a bajar los costos: ajustando días de rodaje, alcance o formato, sin comprometer el resultado. Si querés entrar en más detalle, no dudes en contactarnos — pensamos el proyecto con vos.",
    cta: "Reservar llamada gratis de 15 min →",
    bye: "¿Preferís por email? Respondé este mensaje — me llega directo a mí.",
    sign: "Sofia Treviño, Producer",
    foot: "Recibís esto porque usaste nuestra calculadora de costos de video.",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { to, name, lang: rawLang, lines, lo, hi, config } = await req.json();
    if (!to || !lo || !hi) return json({ error: "faltan datos (to/lo/hi)" }, 400);
    const lang = ["en", "de", "es"].includes(rawLang) ? rawLang : "en";
    const t = T[lang];
    const first = String(name || "").trim().split(" ")[0] || "";
    const fmt = (n: number) => "CHF " + Math.round(+n || 0).toLocaleString("de-CH");
    const rows = (Array.isArray(lines) ? lines : []).map((l: [string, number]) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #eee;font-size:13.5px;color:#333">${esc(l[0])}</td><td style="padding:6px 4px;border-bottom:1px solid #eee;font-size:13.5px;color:#333;text-align:right">${fmt(l[1])}</td></tr>`).join("");
    const cfgLine = Array.isArray(config) ? config.map(esc).join(" · ") : "";

    const html = `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    <p style="margin:0 0 15px;font-size:15px;color:#222">${t.hi}${first ? " " + esc(first) : ""},</p>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#222">${t.intro}</p>
    <div style="background:#f4f5f7;border-radius:14px;padding:22px;text-align:center;margin:0 0 18px">
      <div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#888">${cfgLine ? esc(cfgLine) : ""}</div>
      <div style="font-size:30px;font-weight:800;color:#0f1826;margin-top:6px">${fmt(lo)} – ${fmt(hi)}</div>
    </div>
    ${rows ? `<p style="margin:0 0 6px;font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:#888">${esc(t.basedOn)}</p><table style="width:100%;border-collapse:collapse;margin-bottom:18px">${rows}</table>` : ""}
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#555">${t.note}</p>
    <p style="margin:0 0 20px"><a href="https://www.viven.ch/book/" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 22px;border-radius:100px;display:inline-block">${t.cta}</a></p>
    <p style="margin:0;font-size:13.5px;color:#777">${t.bye}</p>
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${t.sign} · VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a><br>${t.foot}</p>
</div></body>`;

    const textLines = (Array.isArray(lines) ? lines : []).map((l: [string, number]) => `  ${l[0]}: ${fmt(l[1])}`).join("\n");
    const text = `${t.hi}${first ? " " + first : ""},\n\n${t.intro}\n\n${fmt(lo)} – ${fmt(hi)}\n${cfgLine ? "(" + config.join(" · ") + ")\n" : ""}\n${textLines ? t.basedOn + "\n" + textLines + "\n\n" : ""}${t.note}\n\n${t.cta.replace(" →", "")}: https://www.viven.ch/book/\n\n${t.bye}\n\n— ${t.sign} · VIVEN AG · viven.ch`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Sofia — VIVEN <info@viven.ch>", reply_to: "sofia@viven.ch", to: [to], subject: `${t.subject} ${fmt(lo)}–${fmt(hi)}`, html, text }),
    });
    if (!res.ok) { console.error("RESEND_FAIL", await res.text()); return json({ error: "send_failed" }, 502); }
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
