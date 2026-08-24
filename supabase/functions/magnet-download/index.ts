// Supabase Edge Function: magnet-download
// Gate REAL del lead magnet: el PDF vive en el bucket PRIVADO 'magnets' —
// no hay URL pública. El cliente manda {email, magnet, lang(+atribución)},
// acá se crea el lead (server-side, service role) y se devuelve una URL
// FIRMADA de 5 minutos. Sin email válido no hay link; compartir el link
// vencido no sirve.
//
// Deploy: supabase functions deploy magnet-download --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// Además de Supabase, el lead también va a HubSpot (mismo portal/form que el
// contact form del sitio y el embed de las landings de Ads) — pedido de
// Sebastián 2026-07-28: TODO lead de viven.ch sincronizado en ambos sistemas.
// Best-effort: nunca bloquea ni rompe la respuesta real si HubSpot falla.
async function hubspotSubmit(opts: { firstname?: string; lastname?: string; email: string; company?: string; message?: string }) {
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
        ],
        context: { pageUri: "https://www.viven.ch/" },
      }),
    });
  } catch (_e) { /* best-effort */ }
}

// el cliente NO elige el archivo — solo el magnet+lang; el mapeo vive acá
// (nadie puede pedir paths arbitrarios del bucket).
const okLang = (l: unknown) => (["en", "de", "es"].includes(String(l)) ? String(l) : "en");

const MAGNETS: Record<string, { file: (lang: string) => string; label: string; asunto: Record<string, string>; nombre: Record<string, string>; trae: Record<string, string> }> = {
  "social-formats": {
    file: (lang) => `viven-social-media-video-cheat-sheet-2026-${okLang(lang)}.pdf`,
    label: "Lead magnet: social media formats",
    asunto: {
      en: "Your Social Media Video Cheat Sheet 2026",
      de: "Ihr Social-Media-Video Cheat-Sheet 2026",
      es: "Tu cheat sheet de video para redes 2026",
    },
    nombre: {
      en: "Social Media Video Cheat Sheet 2026",
      de: "Social-Media-Video Cheat-Sheet 2026",
      es: "Cheat sheet de video para redes 2026",
    },
    trae: {
      en: "Every platform-native format, frame rate, length and spec for YouTube, Reels, TikTok and LinkedIn — on one page.",
      de: "Alle plattform-nativen Formate, Frameraten, Längen und Specs für YouTube, Reels, TikTok und LinkedIn — auf einer Seite.",
      es: "Todos los formatos nativos, frame rates, duraciones y specs para YouTube, Reels, TikTok y LinkedIn — en una página.",
    },
  },
  "explainer-guide": {
    file: (lang) => `viven-explainer-video-guide-2026-${okLang(lang)}.pdf`,
    label: "Lead magnet: explainer video guide",
    asunto: {
      en: "Your guide: the explainer video that converts",
      de: "Ihr Leitfaden: das Erklärvideo, das konvertiert",
      es: "Tu guía: el video explicativo que convierte",
    },
    nombre: {
      en: "How to make an explainer video that converts",
      de: "Wie Sie ein Erklärvideo machen, das konvertiert",
      es: "Cómo hacer un video explicativo que convierte",
    },
    trae: {
      en: "Inside: the five decisions before the script, a 90-second script template with timings, specs by placement, a realistic timeline and the 30-point pre-production checklist.",
      de: "Darin: die fünf Entscheidungen vor dem Drehbuch, ein 90-Sekunden-Template mit Timings, Specs nach Placement, ein realistischer Zeitplan und die 30-Punkte-Checkliste.",
      es: "Adentro: las cinco decisiones antes del guion, una plantilla de 90 segundos con tiempos, specs según dónde va, un cronograma realista y el checklist de 30 puntos.",
    },
  },
};

const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Mismo token que newsletter-send / newsletter-unsub: el link de baja de este
// mail tiene que funcionar igual que el de cualquier otro envío nuestro.
async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// Wrapper: el MISMO de newsletter-send y de la bienvenida (header navy + logo,
// tarjeta blanca, pie con la baja). Si cambia el look del newsletter, cambian
// los tres — para el que recibe tiene que ser reconociblemente la misma casa.
const BOOK = "https://www.viven.ch/book/";
const COPY_MAIL: Record<string, { hola: string; cuerpo: string; btn: string; ojo: string; call: string; callBtn: string; firma: string; unsub: string }> = {
  en: {
    hola: "Here it is — thanks for reading.",
    cuerpo: "Your PDF is one click away. The link works for seven days; after that just ask us again and we will send it over.",
    btn: "Download the PDF",
    ojo: "It also downloaded in your browser when you asked for it — this copy is so it does not get lost in a downloads folder.",
    call: "Rather talk it through? Twenty minutes with a producer, no pitch: bring your project and we will tell you what we would do — and what we would not.",
    callBtn: "Book a call",
    firma: "The Viven team · Zurich",
    unsub: "Unsubscribe",
  },
  de: {
    hola: "Hier ist er — danke fürs Lesen.",
    cuerpo: "Ihr PDF ist einen Klick entfernt. Der Link gilt sieben Tage; danach schreiben Sie uns einfach und wir schicken ihn erneut.",
    btn: "PDF herunterladen",
    ojo: "Der Download ist beim Anfordern auch direkt im Browser gestartet — diese Kopie ist dafür, dass er nicht im Download-Ordner verschwindet.",
    call: "Lieber darüber sprechen? Zwanzig Minuten mit einem Producer, ohne Verkaufsgespräch: Sie bringen Ihr Projekt mit, wir sagen Ihnen, was wir machen würden — und was nicht.",
    callBtn: "Termin buchen",
    firma: "Das Team von Viven · Zürich",
    unsub: "Abmelden",
  },
  es: {
    hola: "Acá está — gracias por leernos.",
    cuerpo: "Tu PDF está a un click. El link vale siete días; después escribinos y te lo mandamos de nuevo.",
    btn: "Descargar el PDF",
    ojo: "También se descargó en tu navegador cuando lo pediste — esta copia es para que no se pierda en la carpeta de descargas.",
    call: "¿Preferís hablarlo? Veinte minutos con un productor, sin venta: traés tu proyecto y te decimos qué haríamos — y qué no.",
    callBtn: "Agendar una llamada",
    firma: "El equipo de Viven · Zúrich",
    unsub: "Darme de baja",
  },
};

function mailHtml(lang: string, titulo: string, trae: string, url: string, unsubUrl: string | null): string {
  const c = COPY_MAIL[lang] || COPY_MAIL.en;
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(titulo)}</span>
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#222">${esc(c.hola)}</p>
    <p style="margin:0 0 20px;font-size:17px;line-height:1.4;color:#111"><b>${esc(titulo)}</b></p>
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#222">${esc(trae)}</p>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.65;color:#222">${esc(c.cuerpo)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:#0f1826;border-radius:999px">
      <a href="${url}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#ddf98f;text-decoration:none">${esc(c.btn)} →</a>
    </td></tr></table>
    <p style="margin:0 0 4px;font-size:13px;line-height:1.6;color:#666">${esc(c.ojo)}</p>
    <hr style="border:0;border-top:1px solid #eef0f3;margin:24px 0 20px" />
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#222">${esc(c.call)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px"><tr><td style="border:1.5px solid #0f1826;border-radius:999px">
      <a href="${BOOK}" style="display:inline-block;padding:11px 22px;font-size:14.5px;font-weight:700;color:#0f1826;text-decoration:none">${esc(c.callBtn)} →</a>
    </td></tr></table>
    <p style="margin:22px 0 0;font-size:14px;color:#444">${esc(c.firma)}</p>
    ${unsubUrl ? `<p style="margin:16px 0 0;font-size:12.5px;color:#8a919e"><a href="${unsubUrl}" style="color:#8a919e">${esc(c.unsub)}</a></p>` : ""}
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a></p>
</div></body>`;
}

// Mismo backoff que newsletter-send: 700ms, 1.4s, 2.8s.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const magnet = MAGNETS[String(b.magnet || "")];
    const lang = String(b.lang || "en");
    if (!magnet) return json({ error: "magnet desconocido" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email inválido" }, 400);

    const quiereNewsletter = b.newsletter === true;
    /* La prueba del consentimiento. El sitio manda el texto EXACTO que la
       persona tenía al lado de la casilla (nl_text): si mañana cambiamos esa
       frase, las filas viejas siguen diciendo qué decía la que ellos vieron.
       Se recorta por las dudas — es una prueba, no un campo libre. */
    const consentimiento = quiereNewsletter
      ? [String(b.magnet || "magnet"), String(b.form_path || ""), String(b.nl_text || "").slice(0, 300)]
        .filter(Boolean).join(" · ")
      : null;

    // lead (best-effort: el PDF no se le niega a un humano por un hipo del insert)
    let leadId: number | null = null;
    try {
      const row: Record<string, unknown> = {
        name: "", first_name: "", email, message: magnet.label,
        form_path: String(b.form_path || ""), lang,
      };
      if (b.session_id) row.session_id = b.session_id;
      if (b.channel) row.channel = b.channel;
      if (b.utm_source) row.utm_source = b.utm_source;
      if (b.landing_path) row.landing_path = b.landing_path;
      // la casilla tildada es consentimiento explícito y se guarda con fecha:
      // el día que haya que demostrar quién lo pidió, el dato existe (SQL 0132)
      if (quiereNewsletter) {
        row.newsletter_opt_in = new Date().toISOString();
        row.newsletter_opt_in_src = consentimiento;
      }
      const ins = await service.from("leads").insert(row).select("id").maybeSingle();
      leadId = (ins.data as { id: number } | null)?.id ?? null;
      if (ins.error) console.error("LEAD_INSERT_WARN", ins.error.message);

      /* La SQL 0134 dejó de permitir contactos duplicados: si esta persona YA
         existía, el trigger completa su ficha y NO crea fila, así que el insert
         no devuelve nada. Hay que ir a buscarla.
         Sin esto pasan dos cosas, y la segunda es grave:
           1. magnet_sends queda sin lead_id → la descarga no se ve en la ficha
              de esa persona, que es justamente para lo que existe.
           2. el email sale SIN LINK DE BAJA, porque el link se arma con el id.
         Pasó de verdad: dos envíos del 24/08 quedaron con lead_id nulo. */
      if (leadId == null) {
        const ya = await service.from("leads").select("id")
          .ilike("email", email).order("created_at", { ascending: true }).limit(1).maybeSingle();
        leadId = (ya.data as { id: number } | null)?.id ?? null;
        if (leadId == null) console.error("LEAD_SIN_ID", email);
      }
    } catch (e) { console.error("LEAD_INSERT_WARN", String(e)); }
    await hubspotSubmit({ email, message: magnet.label });

    // el link que baja YA: corto a propósito, es de un solo uso en la práctica
    const { data, error } = await service.storage.from("magnets").createSignedUrl(magnet.file(lang), 300);
    if (error || !data?.signedUrl) return json({ error: "no se pudo firmar: " + (error?.message || "?") }, 500);

    /* ---- Y el mismo PDF por email, con un link de 7 días -------------------
       Va DESPUÉS de tener la descarga resuelta y nunca puede romper la
       respuesta: si Resend falla, la persona ya tiene su PDF y solo se pierde
       la copia por correo (queda gritado en los logs). */
    try {
      if (!RESEND) throw new Error("sin RESEND_API_KEY");
      const largo = await service.storage.from("magnets").createSignedUrl(magnet.file(lang), 7 * 24 * 3600);
      const url7 = largo.data?.signedUrl;
      if (!url7) throw new Error("no se pudo firmar el link de 7 días: " + (largo.error?.message || "?"));

      const log = await service.from("magnet_sends")
        .insert({ email, magnet: String(b.magnet || ""), lang, lead_id: leadId }).select("id").maybeSingle();
      if (log.error) console.error("FALTA_CORRER_0132", log.error.message);
      const sendId = (log.data as { id: number } | null)?.id ?? null;

      const unsubUrl = leadId != null
        ? `${SB_URL}/functions/v1/newsletter-unsub?l=${leadId}&t=${await unsubToken(leadId)}`
        : null;
      const titulo = magnet.nombre[lang] || magnet.nombre.en;
      const payload: Record<string, unknown> = {
        from: "VIVEN <info@viven.ch>",
        reply_to: "info@viven.ch",
        to: [email],
        subject: magnet.asunto[lang] || magnet.asunto.en,
        html: mailHtml(lang, titulo, magnet.trae[lang] || magnet.trae.en, url7, unsubUrl),
      };
      // resend-events estampa apertura/click sobre magnet_sends con este tag
      if (sendId != null) payload.tags = [{ name: "magnet_id", value: String(sendId) }];

      const res = await resendSend(payload);
      if (!res.ok) {
        console.error("RESEND_MAGNET_FAIL", res.status, (await res.text()).slice(0, 200), email);
      } else if (sendId != null) {
        let resendId: string | null = null;
        try { resendId = (await res.json())?.id ?? null; } catch { /* ignore */ }
        await service.from("magnet_sends").update({ sent_at: new Date().toISOString(), resend_id: resendId }).eq("id", sendId);
      }
    } catch (e) {
      console.error("MAGNET_MAIL_WARN", String(e), email);
    }

    /* ---- La casilla del newsletter ----------------------------------------
       Tildada = pidió el newsletter explícitamente, así que le corresponde la
       bienvenida (el mismo email que recibe quien se suscribe por el footer).
       Se llama con el CRON_SECRET, que es el camino interno que esa function
       reconoce; si está apagada, ella misma no manda nada. Best-effort: nadie
       se queda sin PDF porque la bienvenida falle. */
    if (quiereNewsletter) {
      try {
        await service.from("leads").insert({
          name: "", first_name: "", email, message: "Newsletter signup",
          form_path: String(b.form_path || ""), lang,
          newsletter_opt_in: new Date().toISOString(),
          newsletter_opt_in_src: consentimiento,
        });
        if (CRON_SECRET) {
          await fetch(`${SB_URL}/functions/v1/newsletter-welcome`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + CRON_SECRET },
            body: JSON.stringify({ email, lang, form_path: String(b.form_path || "") }),
          });
        }
      } catch (e) { console.error("NEWSLETTER_OPTIN_WARN", String(e), email); }
    }

    return json({ ok: true, url: data.signedUrl });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
