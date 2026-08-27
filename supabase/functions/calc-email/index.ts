// Supabase Edge Function: calc-email
// PRIMER TOUCHPOINT de la calculadora de presupuesto: en vez de revelar el
// rango CHF en la página, se lo mandamos por email al instante — la bandeja
// de entrada es el "unlock". Público (sin auth), llamado directo desde
// site.js al enviar el formulario de la calculadora.
//
// Deploy: supabase functions deploy calc-email --no-verify-jwt
// Usa:    RESEND_API_KEY (ya seteado)
//
// 📚 Plantillas (SQL 0062, dashboard → Workflows → 📚 Plantillas): si existe
// una fila email_templates(key='calc_result', lang), su subject/body pisan el
// intro+nota de abajo (tokens {{first_name}}/{{range}}). Sin fila → default
// hardcodeado de siempre. Lookup defensivo: tabla ausente = mismo camino que
// "sin fila".
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

// rate limit por IP: máx N hits en una ventana de M minutos, compartido por
// todos los endpoints públicos que mandan email (misma tabla, `fn` distinto).
async function rateLimited(fn: string, ip: string, max = 5, windowMin = 10): Promise<boolean> {
  const since = new Date(Date.now() - windowMin * 60_000).toISOString();
  const { count } = await service.from("rl_hits").select("id", { count: "exact", head: true }).eq("fn", fn).eq("key", ip).gte("at", since);
  await service.from("rl_hits").insert({ fn, key: ip });
  if (Math.random() < 0.02) service.from("rl_hits").delete().lt("at", new Date(Date.now() - 86_400_000).toISOString()).then(() => {}, () => {});
  return (count ?? 0) >= max;
}
const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

async function getTemplate(key: string, lang: string): Promise<{ subject: string; body: string } | null> {
  try {
    const { data, error } = await service.from("email_templates").select("subject,body").eq("key", key).eq("lang", lang).maybeSingle();
    if (error || !data || !data.subject || !data.body) return null;
    return data as { subject: string; body: string };
  } catch (_e) { return null; }
}

const T: Record<string, Record<string, string>> = {
  en: {
    subject: "Your video cost estimate: CHF",
    hi: "Hi",
    intro: "Thank you for your enquiry — here is the range for what you put together, calculated on real budgets from 1137+ Swiss productions for brands like UBS, Siemens and FIFA.",
    basedOn: "Your cost breakdown:",
    note: "It is a reference range for that scope. The final number depends on the location, the crew it takes and the timing — which is why we prefer to go through it with you before putting a fixed price on it. If the estimate sits above your budget, we can usually help bring the costs down: adjusting shoot days, scope or format, without compromising the result. If you'd like to go through the details, don't hesitate to contact us — we're happy to think along with you.",
    cta: "Book a free 15-min call →",
    bye: "Prefer email? Just reply to this message — it lands directly with me.",
    sign: "Sofia Treviño, Producer",
    briefT: "Want the exact price for your project?",
    briefP: "Tell us the project in 2 minutes and we come back with a real proposal — scope, timing and a fixed price.",
    briefB: "Fill the brief (2 min) →",
    callB: "Or book a 15-min call →",
    foot: "You're receiving this because you used our video cost calculator.",
  },
  de: {
    subject: "Ihre Videokosten-Schätzung: CHF",
    hi: "Guten Tag",
    intro: "vielen Dank für Ihre Anfrage — hier ist die Spanne für Ihre Auswahl, berechnet auf echten Budgets aus 1137+ Schweizer Produktionen für Marken wie UBS, Siemens und FIFA.",
    basedOn: "Ihre Kostenaufstellung:",
    note: "Es ist ein Richtwert für diesen Umfang. Die finale Zahl hängt von Location, nötiger Crew und Timing ab — deshalb schauen wir sie lieber gemeinsam mit Ihnen an, bevor wir einen Festpreis nennen. Liegt die Schätzung über Ihrem Budget, helfen wir gerne, die Kosten zu senken: über Drehtage, Umfang oder Format, ohne Kompromisse beim Resultat. Möchten Sie ins Detail gehen? Kontaktieren Sie uns jederzeit — wir denken gerne mit.",
    cta: "Gratis 15-Min-Call buchen →",
    bye: "Lieber per E-Mail? Antworten Sie einfach auf diese Nachricht — sie landet direkt bei mir.",
    sign: "Sofia Treviño, Producerin",
    briefT: "Möchten Sie den genauen Preis für Ihr Projekt?",
    briefP: "Beschreiben Sie das Projekt in 2 Minuten und wir kommen mit einer echten Offerte zurück — Umfang, Timing und Festpreis.",
    briefB: "Briefing ausfüllen (2 Min) →",
    callB: "Oder 15-Min-Call buchen →",
    foot: "Sie erhalten dies, weil Sie unseren Videokosten-Rechner genutzt haben.",
  },
  es: {
    subject: "Tu estimación de costos de video: CHF",
    hi: "Hola",
    intro: "gracias por tu consulta — acá va el rango para lo que armaste, calculado sobre presupuestos reales de 1137+ producciones suizas para marcas como UBS, Siemens y FIFA.",
    basedOn: "Tu desglose de costos:",
    note: "Es un rango de referencia para ese alcance. El número final depende de la locación, del equipo que haga falta y de los tiempos — por eso preferimos verlo con vos antes de ponerle un precio cerrado. Si la estimación queda por encima de tu presupuesto, normalmente podemos ayudarte a bajar los costos: ajustando días de rodaje, alcance o formato, sin comprometer el resultado. Si querés entrar en más detalle, no dudes en contactarnos — pensamos el proyecto con vos.",
    cta: "Reservar llamada gratis de 15 min →",
    bye: "¿Preferís por email? Respondé este mensaje — me llega directo a mí.",
    sign: "Sofia Treviño, Producer",
    briefT: "¿Querés el precio exacto para tu proyecto?",
    briefP: "Contanos el proyecto en 2 minutos y volvemos con una propuesta real: alcance, tiempos y precio cerrado.",
    briefB: "Llenar el brief (2 min) →",
    callB: "O agendar una llamada de 15 min →",
    foot: "Recibís esto porque usaste nuestra calculadora de costos de video.",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (await rateLimited("calc-email", clientIp(req))) return json({ error: "too_many_requests" }, 429);
  try {
    const { to, name, lang: rawLang, lines, lo, hi, config, hutk, page_uri, page_name, gclid } = await req.json();
    if (!to || !lo || !hi) return json({ error: "faltan datos (to/lo/hi)" }, 400);
    const lang = ["en", "de", "es"].includes(rawLang) ? rawLang : "en";
    const t = T[lang];
    const first = String(name || "").trim().split(" ")[0] || "";
    // DE automatizado: Sie + APELLIDO (regla fija) — sin apellido, nombre completo
    const last = String(name || "").trim().split(" ").slice(1).join(" ") || String(name || "").trim();
    const sal = lang === "de" ? last : first;
    const fmt = (n: number) => "CHF " + Math.round(+n || 0).toLocaleString("de-CH");
    const rows = (Array.isArray(lines) ? lines : []).map((l: [string, number]) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #eee;font-size:13.5px;color:#333">${esc(l[0])}</td><td style="padding:6px 4px;border-bottom:1px solid #eee;font-size:13.5px;color:#333;text-align:right">${fmt(l[1])}</td></tr>`).join("");
    const cfgLine = Array.isArray(config) ? config.map(esc).join(" · ") : "";
    const range = `${fmt(lo)} – ${fmt(hi)}`;

    // template opcional (📚 Plantillas) — pisa subject + intro/nota; el resto
    // (desglose, botón, firma, footer) sigue siendo estructura fija del código
    const tmpl = await getTemplate("calc_result", lang);
    const tok = (s: string) => s.replaceAll("{{first_name}}", first).replaceAll("{{last_name}}", last).replaceAll("{{range}}", range);
    const subject = tmpl ? tok(tmpl.subject) : `${t.subject} ${fmt(lo)}–${fmt(hi)}`;
    const bodyParas = tmpl
      ? tok(tmpl.body).trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#222">${esc(p).replace(/\n/g, "<br>")}</p>`).join("")
      : `<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#222">${t.intro}</p>`;
    const noteHtml = tmpl ? "" : `<p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#555">${t.note}</p>`;

    const html = `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    <p style="margin:0 0 15px;font-size:15px;color:#222">${t.hi}${sal ? " " + esc(sal) : ""},</p>
    ${bodyParas}
    <div style="background:#f4f5f7;border-radius:14px;padding:22px;text-align:center;margin:0 0 18px">
      <div style="font-size:11px;letter-spacing:.8px;text-transform:uppercase;color:#888">${cfgLine ? esc(cfgLine) : ""}</div>
      <div style="font-size:30px;font-weight:800;color:#0f1826;margin-top:6px">${range}</div>
    </div>
    ${noteHtml}
    <!-- Salida al brief. El rango es un rango; la propuesta de verdad necesita
         saber del proyecto. Sebastián, 14 ago: "ahí le decimos ¿querés una
         propuesta propia? llená el brief que tenemos, o agendá una llamada". -->
    <div style="border:1px solid #e4e7ec;border-radius:14px;padding:20px 22px;margin:0 0 20px">
      <p style="margin:0 0 6px;font-size:15px;font-weight:700;color:#111">${esc(t.briefT)}</p>
      <p style="margin:0 0 14px;font-size:14px;color:#555;line-height:1.55">${esc(t.briefP)}</p>
      <p style="margin:0 0 10px"><a href="https://www.viven.ch/brief/?lang=${lang}" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:14.5px;padding:12px 22px;border-radius:100px;display:inline-block">${esc(t.briefB)}</a></p>
      <p style="margin:0"><a href="https://www.viven.ch/book/" style="color:#0f1826;font-weight:600;font-size:13.5px">${esc(t.callB)}</a></p>
    </div>
    <p style="margin:0;font-size:13.5px;color:#777">${t.bye}</p>
    <p style="margin:22px 0 0;font-size:14px;color:#444">— ${t.sign} · VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a><br>${t.foot}</p>
</div></body>`;

    const textLines = (Array.isArray(lines) ? lines : []).map((l: [string, number]) => `  ${l[0]}: ${fmt(l[1])}`).join("\n");
    const text = `${t.hi}${sal ? " " + sal : ""},\n\n${tmpl ? tok(tmpl.body) : t.intro}\n\n${range}\n${cfgLine ? "(" + config.join(" · ") + ")\n" : ""}\n${tmpl ? "" : t.note + "\n\n"}${t.briefT}\n${t.briefP}\n${t.briefB.replace(" →", "")}: https://www.viven.ch/brief/?lang=${lang}\n${t.callB.replace(" →", "")}: https://www.viven.ch/book/\n\n${t.bye}\n\n— ${t.sign} · VIVEN AG · viven.ch`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Sofia — VIVEN <sofia@viven.ch>", reply_to: "sofia@viven.ch", to: [to], subject, html, text }),
    });
    if (!res.ok) { console.error("RESEND_FAIL", await res.text()); return json({ error: "send_failed" }, 502); }

    /* Dejar constancia en el hilo del contacto.
       Este email SALE de verdad y hasta hoy no se anotaba en ningún lado: al
       abrir la ficha de alguien que había usado la calculadora, la timeline
       estaba vacía y parecía que nunca le habíamos escrito. Sebastián preguntó
       justamente eso el 17 ago ("¿salen?") mirando gente que sí había recibido
       su estimación. Un email invisible es peor que uno que no salió: te hace
       escribir dos veces, o no escribir por las dudas.

       Va DESPUÉS del envío y dentro de su propio try: el email ya está mandado,
       así que un problema para registrarlo no puede devolverle un error al
       formulario ni hacer que el visitante reintente y reciba dos estimaciones.

       El lead lo crea el sitio antes de llamar acá, no esta función — por eso se
       busca por email (el más reciente, si hay repetidos). Si no aparece, se
       registra igual con lead_id null: mejor un renglón suelto que ninguno. */
    try {
      const { data: lead } = await service.from("leads")
        .select("id").ilike("email", to)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const { error: logErr } = await service.from("email_log").insert({
        lead_id: lead?.id != null ? String(lead.id) : null,   // la columna es text, leads.id es bigint
        to_addr: to,
        subject,
        body: text,
        sender_label: "Sofia",
        source: "calc-email",   // misma convención que automations-run / booking-create
        direction: "out",
      });
      if (logErr) console.error("EMAIL_LOG_FAIL", logErr.message);
    } catch (e) { console.error("EMAIL_LOG_FAIL", String(e)); }

    await hubspotSubmit({ firstname: first, lastname: last, email: to, message: `Calculadora de costos: ${range}${cfgLine ? " · " + cfgLine : ""}` , hutk: hutk ?? null, pageUri: page_uri ?? null, pageName: page_name ?? null, gclid: gclid ?? null });
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
