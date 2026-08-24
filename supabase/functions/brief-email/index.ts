// Supabase Edge Function: brief-email
// Manda por email una copia del brief que el usuario acaba de llenar en /brief/,
// a la MISMA dirección que puso en el formulario — así lo tiene en su bandeja
// y se lo puede reenviar a otra persona (decisor, jefe, etc.). Público (sin auth).
//
// Deploy: supabase functions deploy brief-email --no-verify-jwt
// Usa:    RESEND_API_KEY (ya seteado)
//
// fix (auditoría 2026-07-14): sin límite, cualquiera podía usar esto como
// open-relay hacia un `to` arbitrario o bombardear una sola bandeja. Rate
// limit simple por IP vía tabla rl_hits (SQL 0082): máx 5 envíos / 10 min.

import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Además de Supabase, el lead también va a HubSpot (mismo portal/form que el
// contact form del sitio y el embed de las landings de Ads) — pedido de
// Sebastián 2026-07-28: TODO lead de viven.ch sincronizado en ambos sistemas.
// Best-effort: nunca bloquea ni rompe la respuesta real si HubSpot falla.
async function hubspotSubmit(opts: { firstname?: string; lastname?: string; email: string; company?: string; message?: string;
  hutk?: string | null; pageUri?: string | null; pageName?: string | null; gclid?: string | null }) {
  try {
    await fetch("https://api.hsforms.com/submissions/v3/integration/submit/4084680/994b80e1-84c2-42de-a5a1-ea2145608d76", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "firstname", value: opts.firstname || "" },
          { name: "lastname", value: opts.lastname || "" },
          { name: "email", value: opts.email },
          { name: "company", value: opts.company || "-" },
          { name: "message", value: opts.message || "" },
          // El gclid como campo propio: no cambia el Original Source (eso sale de
          // la cookie de HubSpot y no se puede pasar por API) pero da una segunda
          // vía para cruzar leads con campañas que NO depende del consentimiento.
          ...(opts.gclid ? [{ name: "gclid", value: opts.gclid }] : []),
        ],
        // `hutk` es LA pieza de la atribución: sin ese token HubSpot no puede
        // asociar el envío con la sesión de navegación donde quedó registrado el
        // origen, y marca el contacto como "Offline Sources" aunque venga de
        // Google Ads (reporte de la agencia, 25/08/2026). Llega desde el
        // navegador, que es el único que puede leer la cookie.
        // pageUri estaba FIJO a la home: HubSpot creía que todas las
        // conversiones pasaban ahí. Ahora viaja la página real.
        context: {
          ...(opts.hutk ? { hutk: opts.hutk } : {}),
          pageUri: opts.pageUri || "https://www.viven.ch/",
          ...(opts.pageName ? { pageName: opts.pageName } : {}),
        },
      }),
    });
  } catch (_e) { /* best-effort */ }
}

async function rateLimited(fn: string, ip: string, max = 5, windowMin = 10): Promise<boolean> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const { count } = await service.from("rl_hits").select("id", { count: "exact", head: true }).eq("fn", fn).eq("key", ip).gte("at", since);
  await service.from("rl_hits").insert({ fn, key: ip });
  if (Math.random() < 0.02) service.from("rl_hits").delete().lt("at", new Date(Date.now() - 86_400_000).toISOString()).then(() => {}, () => {});
  return (count ?? 0) >= max;
}
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

const T: Record<string, Record<string, string>> = {
  en: { subject: "Your project brief — VIVEN", hi: "Hi", intro: "Here's a copy of the brief you just filled in — forward it to anyone else who needs to weigh in.", refLabel: "References", notesLabel: "Anything else", bye: "We'll be in touch shortly. Prefer to talk sooner?", cta: "Book a free 15-min call →", foot: "You're receiving this because you filled in our project brief." },
  de: { subject: "Ihr Projekt-Briefing — VIVEN", hi: "Guten Tag", intro: "Hier eine Kopie des Briefings, das Sie gerade ausgefüllt haben — leiten Sie es an alle weiter, die mitentscheiden.", refLabel: "Referenzen", notesLabel: "Sonstiges", bye: "Wir melden uns in Kürze. Lieber gleich sprechen?", cta: "Gratis 15-Min-Call buchen →", foot: "Sie erhalten dies, weil Sie unser Projekt-Briefing ausgefüllt haben." },
  es: { subject: "Tu brief de proyecto — VIVEN", hi: "Hola", intro: "Acá tenés una copia del brief que acabás de completar — reenviaselo a quien más tenga que decidir.", refLabel: "Referencias", notesLabel: "Otros comentarios", bye: "Te contactamos pronto. ¿Preferís hablar antes?", cta: "Reservar llamada gratis de 15 min →", foot: "Recibís esto porque completaste nuestro brief de proyecto." },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (await rateLimited("brief-email", clientIp(req))) return json({ error: "too_many_requests" }, 429);
  try {
    const { to, name, lang: rawLang, pairs, references, extra, hutk, page_uri, page_name, gclid } = await req.json();
    if (!to || !Array.isArray(pairs) || !pairs.length) return json({ error: "faltan datos (to/pairs)" }, 400);
    const lang = ["en", "de", "es"].includes(rawLang) ? rawLang : "en";
    const t = T[lang];
    const first = String(name || "").trim().split(" ")[0] || "";
    const last = String(name || "").trim().split(" ").slice(1).join(" ") || String(name || "").trim();
    const sal = lang === "de" ? last : first;

    const row = (k: string, v: string) => `<tr><td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:12.5px;color:#888;width:44%;vertical-align:top">${esc(k)}</td><td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:13.5px;color:#222;font-weight:500;vertical-align:top">${esc(v)}</td></tr>`;
    let rows = pairs.map((p: [string, string]) => row(p[0], p[1])).join("");
    if (references) rows += row(t.refLabel, references);
    if (extra) rows += row(t.notesLabel, extra);

    const html = `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    <p style="margin:0 0 15px;font-size:15px;color:#222">${t.hi}${sal ? " " + esc(sal) : ""},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.65;color:#222">${t.intro}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px">${rows}</table>
    <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#555">${t.bye}</p>
    <p style="margin:0"><a href="https://www.viven.ch/book/" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 22px;border-radius:100px;display:inline-block">${t.cta}</a></p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a><br>${t.foot}</p>
</div></body>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "VIVEN <info@viven.ch>", reply_to: "sofia@viven.ch", to: [to], subject: t.subject, html }),
    });
    if (!res.ok) { console.error("RESEND_FAIL", await res.text()); return json({ error: "send_failed" }, 502); }
    await hubspotSubmit({ firstname: first, lastname: last, email: to, message: `Brief de proyecto enviado (${pairs.length} respuestas)` , hutk: hutk ?? null, pageUri: page_uri ?? null, pageName: page_name ?? null, gclid: gclid ?? null });
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
