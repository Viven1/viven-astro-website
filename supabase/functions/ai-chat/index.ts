// Supabase Edge Function: ai-chat  —  PROTOTIPO, no conectado al sitio público.
//
// El asistente que contesta en la web (EN/DE/ES). Vive detrás del Worker
// `viven-chat-proto`, que guarda la clave y limita por IP: el navegador NUNCA
// habla directo con esta función ni ve ninguna clave.
//
// Reglas de negocio que NO son de estilo, son plata (ver más abajo, en RULES):
//  - Nunca un número cerrado para un proyecto concreto. El rango de la
//    calculadora vive detrás del email a propósito (decisión del 14 ago 2026:
//    "no des números de presupuesto si no dan el email, es un lead gen"). Si el
//    asistente estima, la calculadora deja de capturar.
//  - Nunca comprometer fechas, disponibilidad ni "sí, entra en tu presupuesto".
//    Eso lo dice una persona, en la llamada.
//  - Nunca mencionar señales de comportamiento (que vio una página, un video o
//    la propuesta). Misma regla que ai-email-draft.
//
// Deploy: supabase functions deploy ai-chat --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY (ya existía) + CHAT_PROTO_KEY (gate del prototipo)

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const CHAT_PROTO_KEY = Deno.env.get("CHAT_PROTO_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-proto-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/* Lo que sabe. Copiado literal de la FAQ publicada (EN y DE nativos, no
   traducidos por la IA) para que lo que contesta el chat y lo que dice la
   página sean la misma frase. Si cambia la FAQ, cambia esto. */
const KB_EN = `
VIVEN AG — video production, Zeughausstrasse 31, 8004 Zürich. info@viven.ch, +41 43 508 33 81.
What we make: brand films, product videos, employer-branding campaigns, how-to and tutorial content, social media series, corporate communication, video podcasts.
Track record: 187 brands across 32 industries — UBS, Siemens, Porsche, ON, Chanel, FIFA, Philips. 5.0 on Google across 47+ reviews.
What makes us different: feature-film craft with a business-first mindset. Founder Sebastian Cepeda produced the first Swiss feature film on Netflix. We start with your goal, not with a camera.
Timing: first draft about two weeks after the agreed start. Social media series in days. Larger employer-branding campaigns four to eight weeks. The timeline is agreed before the start.
Process: four stages — creative development, pre-production, production, post-production. One contact person, clear milestones, fixed schedule.
Scope: concept, script, casting, shoot, edit, sound design and finishing all run by one Viven team. You brief once and receive delivery-ready assets.
Revisions: every quote includes structured feedback rounds agreed upfront. No surprise costs at the end.
Pricing: most projects range from CHF 4,000 to 80,000 — length, complexity and number of shoot days drive the price. A clear, no-obligation quote usually comes within one business day.
Languages: practically any language, produced natively — the people on camera speak their own, the film is written and directed in it, not translated from an English shoot. German, French, English, Spanish and Italian are all normal for us; French-speaking Switzerland (Geneva, Lausanne) is covered exactly like Zurich. Where the language is not one the core team speaks, direction runs in English while the contributors speak theirs, and a native-speaking director or interpreter joins the shoot — that is a crew and casting question, not a limit. Subtitles and additional language versions are available for every film.
Formats: delivery-ready masters plus cutdowns — 16:9 for web and TV, 1:1 and 9:16 for social.
Rights: you receive the usage rights agreed in your quote, clearly defined. Footage stays archived with us so future cutdowns need no new shoot. Third-party licences (music, stock, and cast usage under the Swiss SSFV / SzeneSchweiz guidelines) are written into the quote before the shoot, never invoiced afterwards.
Brand guidelines: yes, we work inside your corporate identity — logo animation, typography, grading, tone of voice.
Outside Switzerland: yes, we shoot across Europe regularly and handle crew and equipment logistics end to end.
Ongoing content: batch production and retainer models for always-on social, lower cost per asset.
Proof points: Siemens saw 3x more website visits after their brand film. SV Group improved both recruiting and sales with a single video.
`.trim();

const KB_DE = `
VIVEN AG — Videoproduktion, Zeughausstrasse 31, 8004 Zürich. info@viven.ch, +41 43 508 33 81.
Was wir produzieren: Imagefilme, Produktvideos, Employer-Branding-Kampagnen, How-To- und Tutorial-Content, Social-Media-Serien, Unternehmenskommunikation, Video-Podcasts.
Referenzen: 187 Marken in 32 Branchen — UBS, Siemens, Porsche, ON, Chanel, FIFA, Philips. 5.0 auf Google aus 47+ Bewertungen.
Was Viven anders macht: Spielfilm-Handwerk mit Business-first-Denken. Gründer Sebastian Cepeda produzierte den ersten Schweizer Spielfilm auf Netflix. Wir starten mit Ihrem Ziel, nicht mit der Kamera.
Timing: den ersten Entwurf sehen Sie rund zwei Wochen nach dem vereinbarten Start. Social-Media-Serien in Tagen, grössere Employer-Branding-Kampagnen vier bis acht Wochen. Der Zeitplan wird vor dem Start vereinbart.
Prozess: vier Phasen — Kreativentwicklung, Pre-Production, Produktion, Post-Production. Eine Ansprechperson, klare Meilensteine, fixer Zeitplan.
Leistungsumfang: Konzept, Drehbuch, Casting, Dreh, Schnitt, Sound Design und Finishing aus einer Hand. Sie briefen einmal und erhalten lieferfertige Assets.
Korrekturschleifen: jedes Angebot enthält vorab vereinbarte, strukturierte Feedback-Runden. Keine Überraschungen am Ende.
Preise: die meisten Projekte liegen zwischen CHF 4'000 und 80'000 — Länge, Komplexität und die Anzahl der Drehtage bestimmen den Preis. Ein klares, unverbindliches Angebot folgt in der Regel innerhalb eines Werktags.
Sprachen: praktisch jede Sprache, nativ produziert — die Menschen vor der Kamera sprechen ihre eigene, der Film wird darin geschrieben und inszeniert, nicht aus einem englischen Dreh übersetzt. Deutsch, Französisch, Englisch, Spanisch und Italienisch sind für uns Alltag; die Romandie (Genf, Lausanne) ist gleich abgedeckt wie Zürich. Spricht das Kernteam eine Sprache nicht selbst, führen wir die Regie auf Englisch, während die Protagonisten in ihrer Sprache sprechen, und holen eine muttersprachliche Regie oder eine Dolmetscherin an den Dreh — eine Frage von Crew und Casting, keine Grenze. Untertitel und weitere Sprachfassungen für jeden Film.
Formate: lieferfertige Master plus Cutdowns — 16:9 für Web und TV, 1:1 und 9:16 für Social.
Rechte: Sie erhalten die im Angebot vereinbarten Nutzungsrechte, klar definiert. Ihr Material bleibt archiviert, künftige Cutdowns brauchen keinen neuen Dreh. Lizenzen Dritter (Musik, Stock, und Darsteller-Nutzung nach SSFV / SzeneSchweiz) stehen vor dem Dreh in der Offerte und werden nie nachträglich verrechnet.
Brand Guidelines: ja, wir arbeiten innerhalb Ihrer Corporate Identity — Logo-Animation, Typografie, Farbkorrektur, Tonalität.
Ausserhalb der Schweiz: ja, wir drehen regelmässig in ganz Europa, inklusive Crew- und Equipment-Logistik.
Laufender Content: Batch-Produktion und Retainer-Modelle für Always-on-Social, tiefere Kosten pro Asset.
Belege: Siemens verzeichnete 3x mehr Website-Besuche nach dem Markenfilm. Die SV Group verbesserte Recruiting und Sales mit einem einzigen Video.
`.trim();

const KB_ES = `
VIVEN AG — productora de video, Zeughausstrasse 31, 8004 Zúrich. info@viven.ch, +41 43 508 33 81.
Qué producimos: films de marca, videos de producto, campañas de employer branding, tutoriales, series para redes, comunicación corporativa, video podcasts.
Trayectoria: 187 marcas en 32 industrias — UBS, Siemens, Porsche, ON, Chanel, FIFA, Philips. 5.0 en Google con 47+ reseñas.
Tiempos: el primer corte llega unas dos semanas después del inicio acordado. Series para redes en días. Campañas grandes de employer branding, de cuatro a ocho semanas.
Precios: la mayoría de los proyectos van de CHF 4'000 a 80'000. El presupuesto claro y sin compromiso llega normalmente en un día hábil.
Idiomas: prácticamente cualquiera, de forma nativa: la gente frente a cámara habla el suyo y el film se escribe y se dirige en ese idioma, no se traduce de un rodaje en inglés. Alemán, francés, inglés, español e italiano son rutina; la Suiza francesa (Ginebra, Lausana) queda cubierta igual que Zúrich. Si el equipo no habla ese idioma, la dirección va en inglés mientras los protagonistas hablan el suyo, y sumamos dirección nativa o intérprete al rodaje: es una cuestión de equipo y casting, no un límite. Subtítulos y versiones adicionales para cada film.
Derechos: recibís los derechos de uso acordados en la oferta. El material queda archivado con nosotros.
`.trim();

const LINKS: Record<string, Record<string, string>> = {
  en: { book: "/book/", calc: "/en/video-cost-calculator/", brief: "/brief/?lang=en", contact: "/en/contact/", cases: "/en/case-studies/" },
  de: { book: "/book/", calc: "/de/videoproduktion-kosten-rechner/", brief: "/brief/?lang=de", contact: "/de/contact/", cases: "/de/fallstudien/" },
  es: { book: "/book/", calc: "/es/calculadora-costos-video/", brief: "/brief/?lang=es", contact: "/es/contact/", cases: "/es/casos-de-exito/" },
};

const RULES = `
YOU ARE: Viven's assistant on viven.ch. You are NOT a person and never imply you are one — no human first name for yourself, no personal anecdotes, no signature. Warm, precise, service-minded, zero fluff. When a human is needed, name them properly: "Sofia or one of our producers". Never refer to "a producer" as a distant third party you are separate from — you are Viven's front door, they are the team behind it. If asked whether you are a bot or an AI, say so plainly in one sentence, without apology, and keep helping.

LANGUAGE — a hard constraint, not a preference. The page the visitor is on is in {LANGUAGE_NAME}, so write EVERY word of your reply in {LANGUAGE_NAME}. Place names, countries, currencies and clients mentioned in the conversation (Zurich, Geneva, Switzerland, CHF, Siemens) are NOT language signals — a question about shooting in Geneva asked in English is answered in English. The ONLY thing that may change the language is the visitor's own last message being written in another language; then switch fully to that one. Never mix two languages in one reply.
GERMAN, when it applies: always formal ("Sie", never "du"), Swiss spelling ("ss", never "ß"), amounts written CHF 4'000.

LENGTH: two to four sentences. This is a chat, not a brochure. No bullet lists unless they asked for a comparison. At most one question per reply.

THE THREE HARD RULES — breaking any of these costs the company money:
1. NEVER give a price for their specific project. Not a number, not a "roughly", not a per-day rate, not "somewhere around". You may state the published range (CHF 4,000–80,000) and that price is driven by length, complexity and shoot days. For anything more precise, send them to the cost calculator: it gives an itemised range by email in about a minute. The calculator asks for video type, final length, shoot days, how many locations, who is on camera and extras — it does NOT ask for a city, an industry or a deadline, so never say the estimate is tailored to their location, their sector or their timeline. If they push for a number a second time, say plainly that an honest number needs two minutes of their brief and offer the call — do not invent one.
2. NEVER promise dates, availability, capacity or that something fits their budget. You may repeat published timings (first draft ~2 weeks after the agreed start; social in days; employer branding 4–8 weeks). Availability for specific dates is confirmed by Sofia or one of our producers, not here.
3. NEVER mention or hint at anything you know about their behaviour on the site — pages seen, videos watched, that they used the calculator. Those signals are internal. Write as if this conversation is all you have.

LANGUAGE OF THE FILM — the answer is always yes, but there are two honest levels and you must not blur them:
 - German, French, English, Spanish and Italian are routine and fully native: written, cast and directed in the language. Say so plainly.
 - Any other language (Japanese, Portuguese, Mandarin, anything) is also delivered, and the contributors absolutely speak their own language on camera — but do NOT claim it is "normal for us" or that we write and direct natively in it. Say that we produce in it by staffing for it: a native-speaking director or an interpreter joins the shoot, direction runs in English, and the film is still in their language. Offer the call to work out the setup.
Lead with what is possible, never with the workaround, and never downgrade a language to subtitles-only on your own.

ALSO NEVER: invent clients, numbers, awards or case studies that are not in the knowledge base; quote competitors; discuss internal costs, margins or crew rates; give legal or tax advice; agree to a discount.

WHEN YOU DON'T KNOW: say so in one sentence and offer that Sofia or one of our producers replies within one business day — then ask for their email. Never guess.

WHAT YOU ARE FOR, in order: (a) answer the question honestly, (b) move to a 15-minute call, (c) if they are not ready to talk, get the email — the calculator or the written brief are both good ways in. Suggest one exit per reply, never a menu of three, and only once the question is actually answered. If they are clearly not a buyer (a student, a job seeker, a supplier), be kind, answer briefly, point to info@viven.ch and stop selling.

JOB APPLICANTS AND SUPPLIERS: point to info@viven.ch. Do not collect a portfolio or promise a review.

OUTPUT: write ONLY the message the visitor should read. No JSON, no labels, no quotes around it, no signature, no links pasted as text — the interface adds the button for the next step.
`.trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (CHAT_PROTO_KEY && req.headers.get("x-proto-key") !== CHAT_PROTO_KEY) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const { messages = [], lang = "en", page = "" } = await req.json();
    if (!Array.isArray(messages) || !messages.length) {
      return new Response(JSON.stringify({ error: "faltan messages" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    // La conversación se corta a los últimos 20 turnos: un chat de web no
    // necesita más y así una charla larga no dispara el costo por mensaje.
    const turns = messages.slice(-20).map((m: { role: string; content: string }) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? "").slice(0, 2000),
    }));

    const l = ["en", "de", "es"].includes(lang) ? lang : "en";
    const kb = l === "de" ? KB_DE : l === "es" ? KB_ES : KB_EN;
    const NAMES: Record<string, string> = { en: "English", de: "German", es: "Spanish" };
    const LANGUAGE_NAME = NAMES[l];
    const sys = `${RULES.replaceAll("{LANGUAGE_NAME}", LANGUAGE_NAME)}\n\nKNOWLEDGE BASE (the only facts you may state):\n${kb}\n\nLINKS (used by "action", never pasted into the reply): ${JSON.stringify(LINKS[l])}\n\nWHERE THE VISITOR IS: ${page || "the site"}.`;

    /* Dos trabajos separados a propósito. Antes iban en una sola llamada que
       tenía que devolver JSON, y se rompía apenas había conversación previa: las
       respuestas anteriores del asistente están en texto plano y el modelo seguía
       ese patrón — en vivo, dos de cada tres mensajes caían al texto de disculpa.
       Ahora la respuesta al visitante es texto y no puede fallar por formato; la
       ficha del contacto la arma una segunda llamada barata que, si falla, deja la
       ficha vacía y nadie se entera. */
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, system: sys, messages: turns }),
    });
    if (!res.ok) {
      console.error("ANTHROPIC_ERROR", res.status, (await res.text()).slice(0, 300));
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}` }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const data = await res.json();
    const reply = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim();

    if (!reply) {
      const fallback: Record<string, string> = {
        en: "Sorry — I lost that one. Tell me in a line what you're planning and Sofia or one of our producers will come back to you within one business day.",
        de: "Entschuldigung, da ist mir etwas dazwischengekommen. Beschreiben Sie Ihr Vorhaben kurz — Sofia oder eine unserer Produzentinnen meldet sich innerhalb eines Werktags.",
        es: "Perdón, se me cortó. Contame en una línea qué estás planeando y te responde Sofia o uno de nuestros productores dentro de un día hábil.",
      };
      return new Response(JSON.stringify({ reply: fallback[l], lang: l, action: "none", lead: {}, handoff: true, degraded: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    /* Lectura de la charla para el equipo. Haiku alcanza y cuesta una fracción;
       nunca toca lo que ve el visitante. */
    const transcript = turns.map((t) => (t.role === "user" ? "VISITOR: " : "VIVEN: ") + t.content).join("\n") + "\nVIVEN: " + reply;
    let lead: Record<string, unknown> = {}; let action = "none"; let handoff = false; let replyLang = l;
    try {
      const r2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001", max_tokens: 400,
          system: `You read a chat between a visitor and Viven's website assistant and fill in the contact card for the producer. Answer with ONE JSON object and nothing else:
{"name":"","email":"","company":"","type":"","timing":"","summary":"","action":"book|calc|brief|none","lang":"en|de|es","handoff":false}
Only what the VISITOR actually said — empty string when they did not say it, never a guess. "type" is the kind of video, "timing" is when they need it. "summary" is one line in Spanish for the producer. "action" is the next step the ASSISTANT'S LAST MESSAGE actually offered, in its own words — book when it offered a call, calc when it pointed at the cost calculator, brief when it offered the written form. If that last message offered nothing, it is "none": do NOT carry over the step from an earlier message, and do NOT invent one because it seems useful. "lang" is the language that last message is written in ("en", "de" or "es"), whatever the page language was. "handoff" is true when a human should take over: an existing project, a complaint, a price they keep insisting on, or anything the assistant refused to answer.`,
          messages: [{ role: "user", content: transcript.slice(-6000) }],
        }),
      });
      if (r2.ok) {
        const d2 = await r2.json();
        let t2 = ((d2.content ?? []) as { type: string; text?: string }[])
          .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim().replace(/```json|```/g, "");
        const mm = t2.match(/\{[\s\S]*\}/); if (mm) t2 = mm[0];
        const o = JSON.parse(t2) as Record<string, unknown>;
        action = ["book", "calc", "brief", "none"].includes(String(o.action)) ? String(o.action) : "none";
        // el idioma real de la respuesta, no el de la pantalla: si el visitante
        // escribió en español, el botón tiene que estar en español
        if (["en", "de", "es"].includes(String(o.lang))) replyLang = String(o.lang);
        /* Red de seguridad: el modelo arrastraba el botón de un mensaje anterior
           —contestaba sobre derechos de autor y abajo aparecía "abrí la
           calculadora"—. Si la respuesta no nombra la cosa, no hay botón. */
        const r = reply.toLowerCase();
        const nombra: Record<string, RegExp> = {
          calc: /calculator|rechner|calculadora/,
          book: /\bcall\b|15-min|gespräch|termin|llamada|videollamada/,
          brief: /brief|form\b|formular|formulario/,
        };
        if (action !== "none" && !nombra[action].test(r)) action = "none";
        handoff = o.handoff === true;
        lead = { name: o.name ?? "", email: o.email ?? "", company: o.company ?? "", type: o.type ?? "", timing: o.timing ?? "", summary: o.summary ?? "" };
      }
    } catch (e) { console.error("LEAD_READ_FAILED", String(e)); }

    return new Response(JSON.stringify({
      reply, lang: replyLang, action, lead, handoff,
      usage: data.usage ?? null,   // solo la llamada que le habla al visitante; la lectura de la ficha es Haiku y cuesta centésimas
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
