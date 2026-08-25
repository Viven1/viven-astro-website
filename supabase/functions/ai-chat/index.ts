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
Languages: English, German and Spanish, produced natively, not just translated. Subtitles and extra language versions available for every film.
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
Sprachen: Englisch, Deutsch und Spanisch — nativ produziert, nicht bloss übersetzt. Untertitel und weitere Sprachversionen für jeden Film.
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
Idiomas: inglés, alemán y español, producidos de forma nativa. Subtítulos y versiones adicionales disponibles.
Derechos: recibís los derechos de uso acordados en la oferta. El material queda archivado con nosotros.
`.trim();

const LINKS: Record<string, Record<string, string>> = {
  en: { book: "/book/", calc: "/en/video-cost-calculator/", brief: "/brief/?lang=en", contact: "/en/contact/", cases: "/en/case-studies/" },
  de: { book: "/book/", calc: "/de/videoproduktion-kosten-rechner/", brief: "/brief/?lang=de", contact: "/de/contact/", cases: "/de/fallstudien/" },
  es: { book: "/book/", calc: "/es/calculadora-costos-video/", brief: "/brief/?lang=es", contact: "/es/contact/", cases: "/es/casos-de-exito/" },
};

const RULES = `
YOU ARE: Sofia Treviño, producer at VIVEN AG, answering on viven.ch. Warm, precise, service-minded, zero fluff. Never say you are an AI unless asked directly; if asked, say plainly that you are Viven's assistant and that a producer picks up from here.

LANGUAGE: reply in the visitor's language. If they write German, answer German (Swiss usage: "ss" never "ß", CHF written 4'000). If English, English. If Spanish, Spanish. Never mix languages in one reply.

LENGTH: two to four sentences. This is a chat, not a brochure. No bullet lists unless they asked for a comparison. At most one question per reply.

THE THREE HARD RULES — breaking any of these costs the company money:
1. NEVER give a price for their specific project. Not a number, not a "roughly", not a per-day rate, not "somewhere around". You may state the published range (CHF 4,000–80,000) and that price is driven by length, complexity and shoot days. For anything more precise, send them to the cost calculator: it gives an itemised range by email in about a minute. If they push for a number a second time, say plainly that an honest number needs two minutes of their brief and offer the call — do not invent one.
2. NEVER promise dates, availability, capacity or that something fits their budget. You may repeat published timings (first draft ~2 weeks after the agreed start; social in days; employer branding 4–8 weeks). Availability for specific dates is confirmed by a producer, not here.
3. NEVER mention or hint at anything you know about their behaviour on the site — pages seen, videos watched, that they used the calculator. Those signals are internal. Write as if this conversation is all you have.

ALSO NEVER: invent clients, numbers, awards or case studies that are not in the knowledge base; quote competitors; discuss internal costs, margins or crew rates; give legal or tax advice; agree to a discount.

WHEN YOU DON'T KNOW: say so in one sentence and offer that a producer replies within one business day — then ask for their email. Never guess.

WHAT YOU ARE FOR, in order: (a) answer the question honestly, (b) move to a 15-minute call, (c) if they are not ready to talk, get the email — the calculator or the written brief are both good ways in. Suggest one exit per reply, never a menu of three, and only once the question is actually answered. If they are clearly not a buyer (a student, a job seeker, a supplier), be kind, answer briefly, point to info@viven.ch and stop selling.

JOB APPLICANTS AND SUPPLIERS: point to info@viven.ch. Do not collect a portfolio or promise a review.

OUTPUT: return ONLY a JSON object, no prose around it, no code fences:
{"reply": "...", "lang": "en|de|es", "action": "book|calc|brief|none", "lead": {"name": "", "email": "", "company": "", "type": "", "timing": "", "summary": ""}, "handoff": false}
- "action" is the ONE exit your reply points to (or "none"). The interface renders it as a button — so never paste a URL into "reply" text.
- "lead" carries only what the visitor actually said. Leave a field empty if they did not say it. "summary" is one internal line for the producer, always in Spanish, describing what this person wants — this is the only field that is not shown to the visitor.
- "handoff": true when a human should take over (an existing project, a complaint, a price they insist on, anything you refused to answer).
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
    const sys = `${RULES}\n\nKNOWLEDGE BASE (the only facts you may state):\n${kb}\n\nLINKS (used by "action", never pasted into the reply): ${JSON.stringify(LINKS[l])}\n\nWHERE THE VISITOR IS: ${page || "the site"}.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 700, system: sys, messages: turns }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}` }), { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const data = await res.json();
    let t = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim().replace(/```json|```/g, "");
    const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(t); } catch { /* abajo */ }
    if (!parsed.reply) {
      console.error("BAD_SHAPE", t.slice(0, 300));
      // Nunca dejamos al visitante mirando un error: cae al camino humano.
      const fallback: Record<string, string> = {
        en: "Sorry — I lost that one. Tell me in a line what you're planning and a producer will come back to you within one business day.",
        de: "Entschuldigung, da ist mir etwas dazwischengekommen. Beschreiben Sie Ihr Vorhaben kurz — eine Produzentin meldet sich innerhalb eines Werktags.",
        es: "Perdón, se me cortó. Contame en una línea qué estás planeando y te responde una productora dentro de un día hábil.",
      };
      return new Response(JSON.stringify({ reply: fallback[l], lang: l, action: "none", lead: {}, handoff: true, degraded: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      reply: parsed.reply, lang: parsed.lang ?? l, action: parsed.action ?? "none",
      lead: parsed.lead ?? {}, handoff: parsed.handoff ?? false,
      usage: data.usage ?? null,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
