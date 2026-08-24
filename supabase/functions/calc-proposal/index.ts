// Supabase Edge Function: calc-proposal
//
// Sebastián, 14 ago 2026: "cuando alguien lo llena, con esa información crea una
// propuesta con los tres precios, si eligió un precio como base usa ese también.
// Después danos un push y un email para que nosotros la aprobemos y se pueda
// enviar. Así sabemos que sale algo bien armado."
//
// Entonces: la calculadora manda lo que la persona eligió (ya convertido en tres
// paquetes, porque los precios viven en la calculadora y no se duplican acá) y
// esta función arma la propuesta REAL — la misma tabla, el mismo formato y el
// mismo editor que una propuesta hecha a mano — en estado BORRADOR.
//
// Nunca se publica sola y el cliente no recibe nada de acá: el aviso va al
// equipo, alguien la revisa, la publica y la manda con su link. Ese es el punto
// de todo el pedido.
//
// Deploy: supabase functions deploy calc-proposal --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const service = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND = Deno.env.get("RESEND_API_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: unknown) => String(x ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const chf = (n: number) => "CHF " + Math.round(n).toLocaleString("de-CH");

type Tier = { name: string; subtitle?: string; price: number; recommended?: boolean; includes?: string[] };

/* Textos de la propuesta por idioma. Es la parte que NO sale de la calculadora:
   cómo trabajamos, qué incluye cada etapa, condiciones. Igual que en una
   propuesta hecha a mano — si el texto cambia, cambia acá y vale para todas. */
const T: Record<string, {
  titulo: (empresa: string) => string;
  intro: (nombre: string) => string;
  objetivo: string; entrega: string; timing: string; lugar: string;
  scope: { title: string; text: string }[];
  terms: string; nota: string;
}> = {
  es: {
    titulo: (e) => "Propuesta de video — " + e,
    intro: (n) => `Hola ${n}, gracias por contarnos qué necesitás. Armamos esta propuesta con lo que elegiste en la calculadora, en tres alcances para que puedas elegir el que mejor entra en tu presupuesto. Los números salen de producciones reales que hicimos en Suiza; el alcance define el precio, no al revés.`,
    objetivo: "Producir el video con la calidad que la marca necesita, en el alcance elegido y con fechas claras.",
    entrega: "Master en 16:9 y 9:16, listo para web y redes. Archivos fuente disponibles a pedido.",
    timing: "Arrancamos a los pocos días de la confirmación; primer corte en dos semanas desde el rodaje.",
    lugar: "Suiza (a coordinar según locación).",
    scope: [
      { title: "Preproducción", text: "Tomamos el brief y lo convertimos en un plan: equipo necesario, jornadas, cronograma y logística." },
      { title: "Rodaje", text: "Salimos con cámara, luces y sonido propios a filmar todo lo que el video necesita." },
      { title: "Postproducción", text: "Montaje, color, música, gráfica y animación hasta que el video hace lo que tiene que hacer." },
      { title: "Presentación y correcciones", text: "Te lo presentamos y ajustamos hasta que quede." },
    ],
    terms: "Precios en CHF, sin IVA (8.1%). 50% al confirmar, 50% a la entrega. Validez de la oferta: 30 días.",
    nota: "Los extras que no estén en el paquete elegido se pueden sumar después sin rehacer nada.",
  },
  en: {
    titulo: (e) => "Video proposal — " + e,
    intro: (n) => `Hi ${n}, thanks for telling us what you need. We built this proposal from what you selected in the calculator, in three scopes so you can pick the one that fits your budget. The numbers come from real productions we've done in Switzerland; scope drives the price, not the other way round.`,
    objetivo: "Produce the video at the quality the brand needs, in the chosen scope and with clear dates.",
    entrega: "Master in 16:9 and 9:16, ready for web and social. Source files available on request.",
    timing: "We start within days of confirmation; first cut two weeks after the shoot.",
    lugar: "Switzerland (location to be agreed).",
    scope: [
      { title: "Pre-production", text: "We turn the brief into a plan: crew, shoot days, schedule and logistics." },
      { title: "Production", text: "We come out with our own cameras, lights and sound to capture everything the video needs." },
      { title: "Post-production", text: "Edit, colour, music, graphics and animation until the video does its job." },
      { title: "Presentation & revisions", text: "We present it and adjust until it's right." },
    ],
    terms: "Prices in CHF, excl. VAT (8.1%). 50% on confirmation, 50% on delivery. Offer valid for 30 days.",
    nota: "Extras not included in the chosen package can be added later without redoing anything.",
  },
  de: {
    titulo: (e) => "Video-Offerte — " + e,
    intro: (n) => `Guten Tag ${n}, danke für Ihre Angaben. Diese Offerte basiert auf Ihrer Auswahl im Rechner, in drei Umfängen, damit Sie den passenden wählen können. Die Zahlen stammen aus echten Schweizer Produktionen; der Umfang bestimmt den Preis, nicht umgekehrt.`,
    objetivo: "Das Video in der Qualität produzieren, die die Marke braucht — im gewählten Umfang und mit klaren Terminen.",
    entrega: "Master in 16:9 und 9:16, bereit für Web und Social. Rohdaten auf Anfrage.",
    timing: "Start wenige Tage nach Bestätigung; erster Schnitt zwei Wochen nach dem Dreh.",
    lugar: "Schweiz (Location nach Absprache).",
    scope: [
      { title: "Vorproduktion", text: "Aus dem Briefing wird ein Plan: Crew, Drehtage, Zeitplan und Logistik." },
      { title: "Dreh", text: "Wir kommen mit eigener Kamera, Licht und Ton und drehen alles, was das Video braucht." },
      { title: "Postproduktion", text: "Schnitt, Farbe, Musik, Grafik und Animation, bis das Video seine Aufgabe erfüllt." },
      { title: "Präsentation & Korrekturen", text: "Wir zeigen das Resultat und passen an, bis es sitzt." },
    ],
    terms: "Preise in CHF, exkl. MWST (8.1%). 50% bei Bestätigung, 50% bei Lieferung. Gültigkeit: 30 Tage.",
    nota: "Nicht enthaltene Extras lassen sich später ergänzen, ohne etwas neu zu machen.",
  },
};

function slugify(s: string): string {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "propuesta";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const lang = ["en", "de", "es"].includes(String(b.lang)) ? String(b.lang) : "en";
    const t = T[lang];
    const tiers = (Array.isArray(b.tiers) ? b.tiers : []) as Tier[];
    const email = String(b.email || "").trim().toLowerCase();
    if (!tiers.length || !email) return json({ error: "faltan datos" }, 400);

    const nombre = String(b.first_name || b.name || "").trim();
    const apellido = String(b.last_name || "").trim();
    const completo = (nombre + " " + apellido).trim();
    const empresa = String(b.company || "").trim() || completo || "tu proyecto";
    const rec = tiers.find((x) => x.recommended) || tiers[Math.min(1, tiers.length - 1)];

    /* Slug y password: la propuesta nace con su link propio listo, aunque no se
       publique hasta que alguien la apruebe. Password corto y legible por
       teléfono — la va a dictar un humano. */
    const slug = slugify(empresa) + "-" + Math.random().toString(36).slice(2, 7);
    const password = Math.random().toString(36).slice(2, 8).toUpperCase();

    const content = {
      lang, title: t.titulo(empresa), client_name: completo || empresa,
      client: { company: empresa, contact: completo, email },
      sender_key: "sofia",
      intro: t.intro(nombre || completo || ""),
      intro_sign: { name: "Sofia Treviño", role: "Producer" },
      overview: { objective: t.objetivo, outputs: [], location: t.lugar, timing: t.timing, delivery: t.entrega },
      scope: t.scope,
      tiers,
      addon_groups: [],
      videos: [],
      terms: t.terms,
      vat_rate: 8.1,
      sender: { name: "Sofia Treviño", email: "sofia@viven.ch", phone: "+41 43 508 33 81" },
      // de dónde salió, para que quien la revise sepa qué eligió la persona
      origen: { fuente: "calculadora", config: b.config || [], rango: b.rango || null, session_id: b.session_id || null },
    };

    const fila: Record<string, unknown> = {
      slug, password, title: content.title, client_name: completo || empresa, client_email: email,
      lead_id: b.lead_id ? String(b.lead_id) : null, status: "draft", content,
    };
    let ins = await service.from("proposals").insert(fila).select("id").single();
    for (let i = 0; ins.error && i < 4; i++) {           // columnas que falten: sacarlas y reintentar
      const m = /'([^']+)' column/.exec(ins.error.message || "");
      if (!m || !(m[1] in fila)) break;
      delete fila[m[1]];
      ins = await service.from("proposals").insert(fila).select("id").single();
    }
    if (ins.error) return json({ error: "no se pudo crear la propuesta: " + ins.error.message }, 500);
    const propId = ins.data?.id;

    /* Aviso al equipo: push + email. NO se le manda nada al cliente desde acá —
       la propuesta sale recién cuando alguien la aprueba. */
    const titulo = `📄 Propuesta lista para revisar — ${empresa}`;
    const cuerpo = `${completo || email} · ${rec ? chf(rec.price) : ""} · de la calculadora`;
    fetch(`${SB_URL}/functions/v1/push-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
      body: JSON.stringify({ title: titulo, body: cuerpo, url: "/dashboard/?tab=offers" }),
    }).catch((e) => console.error("PUSH_ERROR", String(e)));

    const filas = tiers.map((x) => `<tr><td style="padding:6px 12px 6px 0;color:#667">${esc(x.name)}${x.recommended ? " ⭐" : ""}</td><td style="padding:6px 0;text-align:right"><strong>${chf(x.price)}</strong></td></tr>`).join("");
    const html = `
      <h2 style="font-family:sans-serif;margin:0 0 10px">📄 Propuesta lista para revisar</h2>
      <p style="font-family:sans-serif;font-size:15px;margin:0 0 14px">
        <strong>${esc(empresa)}</strong> — ${esc(completo || "")} · <a href="mailto:${esc(email)}">${esc(email)}</a>
      </p>
      <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse;margin-bottom:14px">${filas}</table>
      ${(b.config as string[] | undefined)?.length ? `<p style="font-family:sans-serif;font-size:13px;color:#556">Eligió: ${esc((b.config as string[]).join(" · "))}</p>` : ""}
      <p style="font-family:sans-serif;font-size:14px;margin:16px 0 6px">Está en <strong>borrador</strong>: revisala, ajustá lo que haga falta y publicala. Recién ahí se le manda.</p>
      <p style="font-family:sans-serif;font-size:14px"><a href="https://www.viven.ch/dashboard/?tab=offers" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:100px;display:inline-block">Abrir en el dashboard →</a></p>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Viven <info@viven.ch>", to: ["info@viven.ch"], reply_to: email, subject: titulo, html }),
    }).catch((e) => console.error("MAIL_ERROR", String(e)));

    return json({ ok: true, id: propId, slug });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
