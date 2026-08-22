// Supabase Edge Function: newsletter-welcome
// 👋 El email de bienvenida del newsletter, en los tres idiomas (EN/DE/ES).
//
// POR QUÉ EXISTE: el form del footer decía "✓ Listo — estás en la lista" y
// después no llegaba NADA hasta la edición mensual siguiente (hasta 30 días).
// El que se suscribe no tenía forma de saber si funcionó, cada cuánto le vamos
// a escribir, ni desde qué dirección — y ese primer email es justamente el que
// le enseña al filtro de Gmail que viven.ch no es promoción. Ahora sale al
// instante, en el idioma en el que la persona estaba navegando.
//
// APAGADO POR DEFECTO: no manda nada hasta que app_settings.key='newsletter'
// tenga {"welcome_enabled": true} — el check 👋 del tab Newsletter del
// dashboard. Deployarla no la enciende. El preview (test_to) sí funciona
// apagada: es lo que se usa para revisar el texto antes de prenderla.
//
// LO MANDA EL SITIO: public/assets/site.js llama acá DESPUÉS de que el insert
// del lead salió bien (best-effort — si esta function está caída, la
// suscripción igual quedó hecha y el visitante no ve ningún error).
//
// QUÉ LO FRENA (el form es público y no tiene captcha):
//   • el email tiene que existir ya como lead — o sea, alguien lo acaba de
//     cargar por el form; no se le puede mandar a una dirección cualquiera;
//   • UNA bienvenida por dirección para siempre — índice único
//     newsletter_welcomes_email_uq (SQL 0130). Repetir el submit no repite el
//     email. La fila se reserva ANTES de mandar, así dos clicks simultáneos no
//     mandan dos veces;
//   • los dados de baja no reciben nada, ni siquiera esto.
//
// PREVIEW SIN SUSCRIBIRSE: { test_to: "…", lang: "de" } — pide sesión del
// dashboard (o service role) y solo acepta tu propia casilla o una @viven.ch;
// no toca el log ni consume el candado. Son los botones 👋 EN/DE/ES del tab
// Newsletter del dashboard.
//
// Deploy:  supabase functions deploy newsletter-welcome --no-verify-jwt
// SQL:     supabase/migrations/0130_newsletter_welcome.sql (correr una vez).
//          Sin correrla no hay interruptor que leer, así que queda apagada y no
//          manda nada. Si algún día existe el interruptor pero no la tabla del
//          log, manda igual y grita FALTA_CORRER_0130 en los logs: preferimos
//          la bienvenida sin candado antes que a alguien sin bienvenida.
// Usa:     RESEND_API_KEY (ya seteado) + SERVICE_ROLE para leer leads.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const service = createClient(SB_URL, SERVICE_ROLE_KEY);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const okLang = (l: unknown) => (["en", "de", "es"].includes(String(l)) ? String(l) : "en");

// MISMO token que newsletter-send/newsletter-unsub: el link de baja de esta
// bienvenida tiene que funcionar igual que el de cualquier otro envío.
async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// ---------------------------------------------------------------------------
// EL TEXTO, en los tres idiomas.
//
// LO QUE PROMETE ACÁ TIENE QUE SER LO QUE MANDAMOS DE VERDAD, y esto ya se
// rompió una vez: la primera versión decía "no es un digest" y prometía
// formatos, presupuestos y números — y la edición mensual ES un digest (3-4
// posts rankeados por pageviews + 1 proyecto, ver newsletter-builder). El
// primer email prometía lo único que no le íbamos a mandar. Lo cazó Sebastián
// el 22 ago 2026, antes de que saliera ninguno.
//
// POR ESO NO HAY FRECUENCIA FIJA. "Una vez por mes" se sacó el mismo día
// (Sebastián quiere poder escribir más seguido, con emails cortos de una sola
// idea además del digest). Lo que queda es un TECHO —nunca más de uno por
// semana— que es una promesa que podemos cumplir escribamos poco o mucho, y
// que además es lo que el que se suscribe quiere saber: no cada cuánto, sino
// cuánto es lo peor que le puede pasar. Si algún día se manda más que eso, el
// texto miente: cambialo antes, no después.
//
// Reglas de la casa:
//   · DE: Sie SIEMPRE, nunca du, nunca ß (siempre ss), saludo "Guten Tag" a
//     secas — no tenemos apellido ni género confiables (misma regla que 0089 /
//     0111 / newsletter-send).
//   · ES: voseo, cordial pero profesional.
//   · Nada de hype, una promesa concreta (uno por mes) y la baja a la vista.
// ---------------------------------------------------------------------------
type Copy = {
  subject: string;
  preheader: string;
  intro: string[];             // párrafos
  sign: string;                // con qué firma (va info@viven.ch, no una persona)
  linksTitle: string;
  links: { href: (l: string) => string; label: string; note: string }[];
  ps: string;
};

const CALC: Record<string, string> = {
  en: "https://www.viven.ch/en/video-cost-calculator/",
  de: "https://www.viven.ch/de/videoproduktion-kosten-rechner/",
  es: "https://www.viven.ch/es/calculadora-costos-video/",
};
const BLOG = (l: string) => `https://www.viven.ch/${l}/blog/`;
const CALL = () => "https://www.viven.ch/book/";

const COPY: Record<string, Copy> = {
  en: {
    subject: "You're on the list — welcome to VIVEN",
    preheader: "What is working in video, and recommendations you can use.",
    intro: [
      "Thanks for subscribing — you're on the list.",
      "You will get what is working in video right now, recommendations you can actually use, and a look behind the projects we shoot. Never more than one email a week — and if there is nothing worth reading, nothing goes out.",
    ],
    sign: "— The VIVEN team",
    linksTitle: "Three things worth having before the first one arrives:",
    links: [
      { href: (l) => CALC[l] || CALC.en, label: "Video cost calculator", note: "what your project should cost, in about two minutes" },
      { href: (l) => BLOG(l), label: "The blog", note: "formats, cases, and what we learned shooting them" },
      { href: CALL, label: "Free 15-minute call", note: "bring a project, leave with a plan — no pitch" },
    ],
    ps: "And if you ever want to reply to one of these emails, do — info@viven.ch is a real inbox, and someone reads it.",
  },
  de: {
    subject: "Willkommen bei VIVEN — Sie sind auf der Liste",
    preheader: "Was bei Video gerade funktioniert, und konkrete Empfehlungen.",
    intro: [
      "Danke für Ihre Anmeldung — Sie sind auf der Liste.",
      "Sie bekommen, was bei Video gerade funktioniert, konkrete Empfehlungen und einen Blick hinter die Projekte, die wir drehen. Nie mehr als eine E-Mail pro Woche — und wenn es nichts zu sagen gibt, kommt nichts.",
    ],
    sign: "— Ihr VIVEN Team",
    linksTitle: "Drei Dinge, die schon vor der ersten Ausgabe nützlich sind:",
    links: [
      { href: (l) => CALC[l] || CALC.en, label: "Kostenrechner", note: "was Ihr Projekt kosten sollte — in rund zwei Minuten" },
      { href: (l) => BLOG(l), label: "Der Blog", note: "Formate, Cases und was wir dabei gelernt haben" },
      { href: CALL, label: "Gratis 15-Minuten-Call", note: "bringen Sie ein Projekt mit, gehen Sie mit einem Plan — ohne Verkaufsgespräch" },
    ],
    ps: "Und wenn Sie auf eine dieser E-Mails antworten möchten: gerne. info@viven.ch ist ein echtes Postfach, das auch gelesen wird.",
  },
  es: {
    subject: "Ya estás en la lista — bienvenida a VIVEN",
    preheader: "Qué está funcionando en video, y recomendaciones concretas.",
    intro: [
      "Gracias por suscribirte — ya estás en la lista.",
      "Vas a recibir qué está funcionando en video, recomendaciones que podés usar, y una mirada detrás de los proyectos que filmamos. Nunca más de un email por semana — y si no hay nada que valga la pena, no mandamos nada.",
    ],
    sign: "— El equipo de VIVEN",
    linksTitle: "Tres cosas que ya te sirven, antes de que llegue la primera:",
    links: [
      { href: (l) => CALC[l] || CALC.en, label: "Calculadora de costos", note: "cuánto debería costar tu proyecto, en unos dos minutos" },
      { href: (l) => BLOG(l), label: "El blog", note: "formatos, casos y lo que aprendimos filmándolos" },
      { href: CALL, label: "Llamada gratis de 15 minutos", note: "traé un proyecto, llevate un plan — sin discurso de venta" },
    ],
    ps: "Y si alguna vez querés responder uno de estos emails, respondé: info@viven.ch es una casilla de verdad y alguien la lee.",
  },
};

// Saludo: MISMA regla que newsletter-send/0089/0111. En DE, "Guten Tag" a secas
// y nunca el nombre de pila (no tenemos apellido ni género confiables). En EN/ES,
// con el nombre si lo tenemos — el form del footer solo pide el email, así que
// casi siempre no lo hay y el email arranca directo por el "gracias".
function greetLine(lang: string, firstName: string): string {
  if (lang === "de") return "Guten Tag";
  if (!firstName) return "";
  return (lang === "es" ? "Hola " : "Hi ") + firstName + ",";
}

const UNSUB_LABEL: Record<string, string> = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" };
// la baja también se explica DENTRO del email, no solo en la letra chica del pie
const UNSUB_LINE: Record<string, string> = {
  en: "No spam, ever. One click in any of our emails and you're off the list",
  de: "Kein Spam. Ein Klick in jeder unserer E-Mails und Sie sind wieder von der Liste",
  es: "Sin spam. Un click en cualquiera de nuestros emails y te vas de la lista",
};

// atribución: todo link de este email cae con utm_source=newsletter&
// utm_campaign=welcome — así una venta que empezó acá se ve como email en el
// dashboard y no como "directo" (site.js mapea utm_source=newsletter → email).
const utm = (url: string) => url + (url.includes("?") ? "&" : "?") + "utm_source=newsletter&utm_campaign=welcome";

// Wrapper: ESPEJO del de newsletter-send (header navy + logo, tarjeta blanca,
// firma de Sofia, pie con la baja de un click). Si algún día cambia el look del
// newsletter, cambiá los dos — la bienvenida es el primer email que ven, tiene
// que ser reconociblemente el mismo.
function buildHtml(lang: string, unsubUrl: string, firstName = ""): string {
  const c = COPY[lang] || COPY.en;
  const greet = greetLine(lang, firstName);
  const parrafo = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#222">${esc(t)}</p>`;
  const items = c.links.map((l) =>
    `<tr><td style="padding:11px 0;border-bottom:1px solid #eef0f3">` +
    `<a href="${utm(l.href(lang))}" style="font-size:15px;font-weight:700;color:#5b7cfa;text-decoration:none">${esc(l.label)} →</a>` +
    `<div style="font-size:13px;color:#666;margin-top:3px">${esc(l.note)}</div>` +
    `</td></tr>`
  ).join("");

  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</span>
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    ${greet ? `<p style="margin:0 0 16px;font-size:15px;color:#222">${esc(greet)}</p>` : ""}
    ${c.intro.map(parrafo).join("")}
    <p style="margin:24px 0 4px;font-size:15px;line-height:1.65;color:#222"><b>${esc(c.linksTitle)}</b></p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px">${items}</table>
    ${parrafo(c.ps)}
    <p style="margin:18px 0 0;font-size:12.5px;color:#8a919e">${esc(UNSUB_LINE[lang] || UNSUB_LINE.en)} — <a href="${unsubUrl}" style="color:#8a919e">${esc(UNSUB_LABEL[lang] || UNSUB_LABEL.en)}</a>.</p>
    <p style="margin:22px 0 0;font-size:14px;color:#444">${esc(c.sign)}</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsubUrl}" style="color:#9aa">${esc(UNSUB_LABEL[lang] || UNSUB_LABEL.en)}</a></p>
</div></body>`;
}

// POST a Resend con reintentos en 429/5xx (mismo backoff que newsletter-send:
// 700ms, 1.4s, 2.8s). Un 429 no puede perder una bienvenida en silencio.
async function resendSend(payload: unknown, attempts = 3): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < attempts; i++) {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) return res;
    if (i < attempts - 1) await new Promise((ok) => setTimeout(ok, 700 * Math.pow(2, i)));
  }
  return res;
}

function emailPayload(to: string, lang: string, unsubUrl: string, welcomeId: string | number | null, firstName = "") {
  const c = COPY[lang] || COPY.en;
  const payload: Record<string, unknown> = {
    // Sale de info@viven.ch y firma el equipo, NO una persona (decisión de
    // Sebastián, 22 ago 2026). La bienvenida es un acuse de recibo del sitio:
    // si la firma Sofia, la respuesta cae en una casilla personal y el que
    // contesta "gracias" queda esperando a alguien que quizás no está.
    from: "VIVEN <info@viven.ch>",
    reply_to: "info@viven.ch",
    to: [to],
    subject: c.subject,
    html: buildHtml(lang, unsubUrl, firstName),
  };
  // resend-events estampa apertura/click sobre newsletter_welcomes con este tag
  if (welcomeId != null) payload.tags = [{ name: "welcome_id", value: String(welcomeId) }];
  return payload;
}

/* EL INTERRUPTOR — APAGADO POR DEFECTO.
   Pedido de Sebastián, 22 ago 2026: "no mandes hasta que confirmemos 100%".
   Que la function esté deployada NO puede significar que ya le esté escribiendo
   a gente real: entre "el código está" y "el texto está aprobado" pasan días, y
   la primera suscripción del sitio no espera a que nadie termine de leer.
   Así que el envío real vive detrás de app_settings.key='newsletter' →
   {"welcome_enabled": true}, y cualquier otra cosa (la clave sin poner, false,
   la fila que no existe, la tabla caída) significa APAGADO. El preview del
   dashboard NO pasa por acá: es justamente lo que se usa para confirmar.
   Prenderlo: el check 👋 del tab Newsletter, o
     update public.app_settings
        set value = value || '{"welcome_enabled": true}'::jsonb
      where key = 'newsletter'; */
async function bienvenidaEncendida(): Promise<boolean> {
  try {
    const { data } = await service.from("app_settings").select("value").eq("key", "newsletter").maybeSingle();
    return ((data?.value ?? {}) as { welcome_enabled?: boolean }).welcome_enabled === true;
  } catch (e) {
    console.error("WELCOME_SETTING_FAIL", String(e));
    return false;   // sin poder leer el interruptor, no se manda: el silencio se arregla, un email de más no
  }
}

// Un error del log NO es "ya se le mandó": lo único que significa eso es el
// choque contra el índice único (23505). Cualquier otro problema del log —
// arranca la tabla sin existir porque 0130 no se corrió— no puede dejar a una
// persona sin bienvenida: se manda igual, con un grito en los logs.
const esDuplicado = (err: { code?: string; message?: string }) =>
  err?.code === "23505" || /duplicate key|unique constraint/i.test(err?.message || "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const auth = req.headers.get("Authorization") ?? "";
    const isInternal = (!!SERVICE_ROLE_KEY && auth === `Bearer ${SERVICE_ROLE_KEY}`) ||
      (!!CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);

    // ---- PREVIEW: verlo antes de que lo vea un suscriptor --------------------
    // Pide sesión del dashboard (o service role) y solo manda a la casilla del
    // que lo pide o a una @viven.ch: un body armado a mano nunca puede usar esto
    // para mandarle a un tercero con nuestro dominio.
    if (b.test_to) {
      let allowed = isInternal;
      let quien = "";
      if (!allowed) {
        const asUser = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
        const { data: { user } } = await asUser.auth.getUser();
        allowed = !!user;
        quien = String(user?.email || "").toLowerCase().trim();
      }
      if (!allowed) return json({ error: "unauthorized" }, 401);
      const to = String(b.test_to).trim();
      // A su propia casilla (sea cual sea el email con el que entró al
      // dashboard) o a una @viven.ch. Nunca a un tercero: con un token robado
      // esto sería un formulario para mandar mails con nuestro dominio.
      if (to.toLowerCase() !== quien && !/^[^@\s]+@viven\.ch$/i.test(to)) {
        return json({ error: "el preview solo se manda a tu propia casilla o a una @viven.ch" }, 400);
      }
      const lang = okLang(b.lang);
      // link de baja real si esa casilla está cargada como lead; si no, al sitio
      const { data: lead } = await service.from("leads").select("id").ilike("email", to).limit(1).maybeSingle();
      const unsubUrl = lead?.id != null
        ? `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`
        : "https://www.viven.ch";
      const res = await resendSend(emailPayload(to, lang, unsubUrl, null));
      if (!res.ok) return json({ error: "Resend " + res.status + ": " + (await res.text()).slice(0, 200) }, 502);
      return json({ ok: true, test: true, lang, to });
    }

    // ---- ENVÍO REAL: alguien se acaba de suscribir --------------------------
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email inválido" }, 400);

    // ¿está prendido? Mientras no lo esté, la suscripción se registra igual (la
    // hace el sitio, no esta function) pero no sale ningún email.
    if (!await bienvenidaEncendida()) {
      console.log("WELCOME_OFF", email);
      return json({ ok: false, skipped: "apagado" });
    }

    // Tiene que existir como lead: es la prueba de que alguien lo cargó por el
    // form. `ilike` no distingue mayúsculas (el form guarda el email tal como lo
    // tipearon) pero % y _ son comodines en LIKE, así que la dirección
    // encontrada se compara de nuevo, entera, contra la pedida.
    const { data: lead } = await service.from("leads")
      .select("id,email,lang,unsubscribed,first_name,name")
      .ilike("email", email).order("id", { ascending: false }).limit(1).maybeSingle();
    if (!lead || String(lead.email || "").trim().toLowerCase() !== email) {
      return json({ ok: false, skipped: "sin lead" });   // sin detalle: no confirmamos si una dirección está o no en la base
    }
    if (lead.unsubscribed) return json({ ok: false, skipped: "dado de baja" });

    const lang = okLang(b.lang || lead.lang);

    // EL CANDADO: la fila se reserva ANTES de mandar. Dos submits simultáneos →
    // el segundo choca contra el índice único y no manda nada.
    let welcomeId: number | null = null;
    const ins = await service.from("newsletter_welcomes")
      .insert({ email, lead_id: lead.id, lang }).select("id").maybeSingle();
    if (ins.error) {
      // el candado haciendo su trabajo: a esta dirección ya se le mandó
      if (esDuplicado(ins.error)) {
        console.log("WELCOME_SKIP", email, "ya tenía bienvenida");
        return json({ ok: true, skipped: "ya enviado" });
      }
      // cualquier otra cosa (típicamente: 0130 sin correr) → mando igual
      console.error("FALTA_CORRER_0130", "no pude registrar la bienvenida — la mando igual, pero SIN candado anti-duplicados:", ins.error.message || ins.error);
    } else {
      welcomeId = (ins.data as { id: number } | null)?.id ?? null;
    }

    const unsubUrl = `${SB_URL}/functions/v1/newsletter-unsub?l=${lead.id}&t=${await unsubToken(lead.id)}`;
    const firstName = String(lead.first_name || String(lead.name || "").split(" ")[0] || "").trim();
    const res = await resendSend(emailPayload(email, lang, unsubUrl, welcomeId, firstName));
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 200);
      console.error("RESEND_WELCOME_FAIL", res.status, detalle, email);
      // liberar la reserva: si no, el candado deja a esa persona sin bienvenida
      // para siempre por un 500 pasajero de Resend.
      if (welcomeId != null) await service.from("newsletter_welcomes").delete().eq("id", welcomeId);
      return json({ error: "no se pudo enviar" }, 502);
    }
    let resendId: string | null = null;
    try { resendId = (await res.json())?.id ?? null; } catch { /* ignore */ }
    if (welcomeId != null) {
      await service.from("newsletter_welcomes")
        .update({ sent_at: new Date().toISOString(), resend_id: resendId }).eq("id", welcomeId);
    }
    return json({ ok: true, lang });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
