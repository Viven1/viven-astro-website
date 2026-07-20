// Supabase Edge Function: content-followup
// Reemplaza al nurture genérico (borrado, SQL 0085) con follow-ups CONECTADOS
// AL CONTENIDO que cada lead realmente pidió: la categoría se lee del mismo
// texto "🧮 CALCULADORA — 📦 Product video · ..." que ya arma calc-email en
// leads.message (sin columnas nuevas — pedido explícito de Sebastián).
//
// Por ahora solo 'product' tiene contenido real (aprobado por Sebastián el
// 2026-07-20). Las otras 5 categorías (brand/employer/howto/social/corporate)
// quedan en CONTENT con un array vacío — se completan cuando el blog para esas
// categorías esté listo (content_queue ids 25-28 ya encolados en top priority).
//
// Mismo patrón de seguridad que nurture: nunca sale un email solo (todo pasa
// por outbox), se frena solo si el lead ya fue contactado, nunca a bajas/spam,
// máximo un email por paso. Enrolamiento automático (source:'auto') detectado
// acá + manual (source:'manual', vía dashboard) conviven en la misma tabla.
//
// Deploy: supabase functions deploy content-followup --no-verify-jwt
// Cron:   SQL 0086, cada hora, mismo Authorization: Bearer CRON_SECRET que
//         el resto de los cron.job desde la auditoría 0081.

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SITE = "https://www.viven.ch";
const D = 864e5;

type Lead = Record<string, any>;

// el chip label completo ("📦 Product video"/"📦 Produktvideo"/"📦 Video de
// producto") cambia de texto en cada idioma de la calculadora, PERO el emoji
// de cada categoría es el mismo y único en los 3 idiomas (verificado contra
// las 3 páginas reales) — matchear solo por emoji es simple y ya cubre EN/DE/ES
// sin tener que listar cada traducción a mano.
const CATEGORY_RE: [string, RegExp][] = [
  ["product", /📦/],
  ["brand", /🎬/],
  ["employer", /👥/],
  ["howto", /🎓/],
  ["social", /📱/],
  ["corporate", /🏢/],
];
function categoryOf(message: string | null | undefined): string | null {
  // ¡cuidado! el chip de talento "👥 Our own employees"/"Eigene Mitarbeitende"
  // usa el MISMO emoji que la categoría "Employer branding" — si se busca el
  // emoji en TODO el mensaje, un lead de How-to/Social/Corporate/Brand que
  // eligió "propios empleados" como talento se clasificaría mal como
  // "employer". El tipo de video SIEMPRE es el primer chip en cfg.join(' · ')
  // (video-cost-calculator/index.astro: cfg se arma recorriendo los botones
  // .on en orden del DOM, y el grupo "type" es el primero) — aislar ese
  // primer segmento evita el choque con talento/extras más adelante.
  const m = String(message || "");
  const seg = m.match(/🧮 CALCULADORA — ([^·]+)·/);
  if (!seg) return null;
  for (const [cat, re] of CATEGORY_RE) if (re.test(seg[1])) return cat;
  return null;
}

const P = SITE + "/projects/";
type Step = { subject: Record<string, string>; body: Record<string, string> };
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

function thumbTable(items: { href: string; img: string; caption: string }[]): string {
  const td = items.map((it, i) => `<td width="${Math.floor(100 / items.length)}%" style="padding:0 ${i === 0 ? 6 : 3}px 0 ${i === items.length - 1 ? 0 : 3}px;vertical-align:top">` +
    `<a href="${it.href}" style="text-decoration:none"><img src="${it.img}" width="100%" style="display:block;border-radius:8px;border:1px solid #e5e7eb" alt="${esc(it.caption)}"/>` +
    `<p style="margin:6px 0 0;font-size:11.5px;color:#555;text-align:center">▶ ${esc(it.caption)}</p></a></td>`).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr>${td}</tr></table>`;
}
function linkCard(href: string, title: string, icon = "📝"): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#f4f5f7;border-radius:12px"><tr>` +
    `<td style="padding:14px 16px"><a href="${href}" style="text-decoration:none;color:#0f1826"><span style="font-size:18px;margin-right:8px">${icon}</span><b style="font-size:14px">${esc(title)}</b><br>` +
    `<span style="font-size:11.5px;color:#8891a0;font-family:monospace">${href.replace(/^https?:\/\//, "")}</span></a></td></tr></table>`;
}
function p(text: string, muted = false): string {
  return `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:${muted ? "#555" : "#222"}">${text}</p>`;
}

// ojo: las páginas de proyecto NO viven bajo /projects/ (esa ruta es solo
// para los stills, /projects/{slug}/archivo.jpg) — cada proyecto tiene su
// propia URL raíz, y el formato varía por página (legado): Meteomatics con
// prefijo de idioma, ANYbotics/Franke sin prefijo. Verificado en vivo (200)
// antes de mandar nada — no asumir un patrón único.
const PRODUCT_VIDEOS = [
  { href: SITE + "/en/meteomatics-product-campaign-brand-video/", img: P + "meteomatics-product-campaign-brand-video/02-Meteomatics_VIVEN_Video_Agentur_040.jpg", caption: "Meteomatics" },
  { href: SITE + "/anybotics-anymal-c-product-launch/", img: P + "anybotics-anymal-c-product-launch/01-on2019-08-22-12h10m12s489-1-1024x512.jpg", caption: "ANYbotics — ANYmal C" },
  { href: SITE + "/franke-the-office-hero-horeca-product-launch/", img: P + "franke-the-office-hero-horeca-product-launch/01-ro__VIVEN_Video_Film_Production-007.jpeg", caption: "Franke — Office Hero" },
];

const CONTENT: Record<string, Step[]> = {
  product: [
    {
      // día +2 — solo videos, sin pitch (feedback explícito: sin "no pitch" en el texto, firma "Viven Team")
      subject: { en: "Three product videos worth a look", de: "Drei Produktvideos, die sich lohnen", es: "Tres videos de producto que vale la pena ver" },
      body: {
        en: p("Hi {{first_name}},") + p("Since you were checking product video pricing — here's a few we've made, in case seeing the real thing is more useful than a range of numbers.") +
          thumbTable(PRODUCT_VIDEOS) + p("Click any of them and it opens on our site. Wanted you to have these on hand.", true) + p("— Viven Team", true),
        de: p("Hallo {{first_name}},") + p("Da Sie die Preise für Produktvideos geprüft haben — hier ein paar, die wir gemacht haben. Manchmal sagt das Ergebnis mehr als eine Preisspanne.") +
          thumbTable(PRODUCT_VIDEOS) + p("Einfach anklicken — es öffnet sich auf unserer Website. Wollten Ihnen diese einfach zur Verfügung stellen.", true) + p("— Viven Team", true),
        es: p("Hola {{first_name}},") + p("Ya que estabas viendo precios de video de producto — acá van algunos que hicimos, por si ver el resultado real sirve más que un rango de números.") +
          thumbTable(PRODUCT_VIDEOS) + p("Hacé clic en cualquiera y se abre en nuestro sitio. Quisimos que los tengas a mano.", true) + p("— Viven Team", true),
      },
    },
    {
      // día +5 — blog: conversión e-commerce
      subject: { en: "How product videos actually move e-commerce numbers", de: "Wie Produktvideos die E-Commerce-Zahlen wirklich bewegen", es: "Cómo los videos de producto mueven de verdad los números de e-commerce" },
      body: {
        en: p("Hi {{first_name}},") + p("Thought this might be useful while you're figuring out your own project:") +
          linkCard(SITE + "/en/blog/how-brands-increase-e-commerce-conversions-with-product-videos/", "How Brands Increase E-commerce Conversions With Product Videos") +
          p("Short read — real examples of what changes when a product video is made with intent, not just nice footage.", true) + p("— Viven Team", true),
        de: p("Hallo {{first_name}},") + p("Dachte, das könnte nützlich sein, während Sie Ihr eigenes Projekt planen:") +
          linkCard(SITE + "/de/blog/so-steigern-marken-ihre-e-commerce-konversionen-mit-produktvideos/", "So steigern Marken ihre E-Commerce-Konversionen mit Produktvideos") +
          p("Kurze Lektüre — echte Beispiele, was sich ändert, wenn ein Produktvideo mit Absicht gemacht wird, nicht nur mit schönen Bildern.", true) + p("— Viven Team", true),
        es: p("Hola {{first_name}},") + p("Pensé que esto podría servirte mientras armás tu propio proyecto:") +
          linkCard(SITE + "/es/blog/video-de-producto-como-convertir-caracteristicas-en-ventas/", "Video de producto: cómo convertir características en ventas") +
          p("Lectura corta — ejemplos reales de lo que cambia cuando un video de producto se hace con intención, no solo con buenas imágenes.", true) + p("— Viven Team", true),
      },
    },
    {
      // día +9 — último toque. ES no tiene un segundo post dedicado todavía → link a la página de servicio.
      subject: { en: "The other reason product videos work", de: "Der andere Grund, warum Produktvideos wirken", es: "Otra cosa que hace que un video de producto valga la pena" },
      body: {
        en: p("Hi {{first_name}},") + p('One more angle, less obvious than "more sales":') +
          linkCard(SITE + "/en/blog/how-product-videos-shorten-the-sales-cycle-for-brands/", "How Product Videos Shorten the Sales Cycle for Brands") +
          p("It's less about marketing and more about saving your own sales team time on every call. If any of this is useful, happy to talk it through — book a free 15-min call at " + SITE + "/book/. If not, no worries either way, we won't keep nudging.", true) + p("— Viven Team", true),
        de: p("Hallo {{first_name}},") + p("Noch ein Blickwinkel, weniger offensichtlich als «mehr Verkäufe»:") +
          linkCard(SITE + "/de/blog/wie-produktvideos-den-verkaufsprozess-für-marken-verkuerzen/", "Wie Produktvideos den Verkaufsprozess für Marken verkürzen") +
          p("Es geht weniger um Marketing als darum, Ihrem Sales-Team bei jedem Gespräch Zeit zu sparen. Falls das nützlich ist, sprechen wir gerne darüber — gratis 15-Min-Call auf " + SITE + "/book/. Falls nicht, auch gut, wir haken nicht weiter nach.", true) + p("— Viven Team", true),
        es: p("Hola {{first_name}},") + p('Otro ángulo, menos obvio que "más ventas":') +
          linkCard(SITE + "/es/services/product-video/", "Cómo trabajamos los videos de producto") +
          p("Menos sobre marketing y más sobre ahorrarle tiempo a tu propio equipo de ventas en cada llamada. Si algo de esto te sirve, hablemos — reservá una llamada gratis de 15 min en " + SITE + "/book/. Si no, sin problema, no vamos a insistir.", true) + p("— Viven Team", true),
      },
    },
  ],
  brand: [],
  employer: [],
  howto: [],
  social: [],
  corporate: [],
};
const STEP_DAYS = [2, 5, 9];

function fillTok(s: string, lead: Lead): string {
  const first = String(lead.first_name || String(lead.name || "").split(" ")[0] || "").trim();
  return s.replaceAll("{{first_name}}", esc(first) || "there");
}

const CONTACT_STAGES = new Set(["contactado", "videocall", "propuesta", "ganado", "perdido", "won", "lost"]);

async function notifyBestEffort(id: number) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/outbox-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ id }),
    });
  } catch (_e) { /* best-effort */ }
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const { data: settings } = await service.from("app_settings").select("value").eq("key", "content_followup").maybeSingle();
    if (settings && settings.value && settings.value.enabled === false) {
      return new Response(JSON.stringify({ ok: true, skipped: "disabled" }), { headers: { "Content-Type": "application/json" } });
    }

    // 1) auto-enrolar leads nuevos (últimos 21 días) que matchean una categoría
    //    y todavía no tienen fila para esa categoría.
    const since21 = new Date(Date.now() - 21 * D).toISOString();
    const { data: recentLeads } = await service.from("leads").select("id,message,created_at").not("email", "is", null).gte("created_at", since21);
    const { data: existing } = await service.from("content_followup_state").select("lead_id,category");
    const already = new Set((existing ?? []).map((r: any) => `${r.lead_id}|${r.category}`));
    let enrolled = 0;
    for (const l of recentLeads ?? []) {
      const cat = categoryOf(l.message);
      if (!cat || already.has(`${l.id}|${cat}`)) continue;
      const { error } = await service.from("content_followup_state").insert({ lead_id: l.id, category: cat, status: "active", source: "auto", enrolled_at: l.created_at });
      if (!error) { enrolled++; already.add(`${l.id}|${cat}`); }
    }

    // 2) recorrer inscripciones activas, mandar el paso que corresponda
    const { data: activeRows } = await service.from("content_followup_state").select("*").eq("status", "active");
    const { data: logs } = await service.from("content_followup_log").select("lead_id,category,step");
    const sentSet = new Set((logs ?? []).map((r: any) => `${r.lead_id}|${r.category}|${r.step}`));
    const { data: pendingObs } = await service.from("outbox").select("lead_id,category,step").eq("kind", "content_followup").in("status", ["pending", "approved"]);
    const pendingSet = new Set((pendingObs ?? []).map((r: any) => `${r.lead_id}|${r.category}|${r.step}`));

    const out = { enrolled, drafted: 0, skipped_contacted: 0, skipped_no_content: 0 };
    for (const st of activeRows ?? []) {
      const steps = CONTENT[st.category];
      if (!steps || !steps.length) { out.skipped_no_content++; continue; }
      const { data: lead } = await service.from("leads").select("id,name,first_name,email,lang,status,unsubscribed,session_id").eq("id", st.lead_id).maybeSingle();
      if (!lead || !lead.email || lead.unsubscribed || /^claude-/.test(lead.session_id || "")) continue;
      // se frena solo si ya lo trabajaste (mismo criterio que tenía nurture)
      if (CONTACT_STAGES.has(String(lead.status || "").toLowerCase()) || /spam|descartado/i.test(lead.status || "")) { out.skipped_contacted++; continue; }

      const ageDays = (Date.now() - Date.parse(st.enrolled_at)) / D;
      for (let i = 0; i < steps.length; i++) {
        const step = i + 1;
        if (ageDays < STEP_DAYS[i]) break;   // todavía no toca este paso ni los siguientes
        const key = `${st.lead_id}|${st.category}|${step}`;
        if (sentSet.has(key) || pendingSet.has(key)) continue;   // ya enviado o ya esperando OK
        const lang = ["en", "de", "es"].includes(lead.lang) ? lead.lang : "en";
        const s = steps[i];
        const subject = fillTok(s.subject[lang] || s.subject.en, lead);
        const body = fillTok(s.body[lang] || s.body.en, lead);
        const { data: ins, error } = await service.from("outbox").insert({
          lead_id: st.lead_id, kind: "content_followup", category: st.category, step,
          sender: "team", subject, body, status: "pending",
        }).select("id").maybeSingle();
        if (!error && ins) { out.drafted++; notifyBestEffort(ins.id); }
        break;   // un solo paso por corrida por inscripción — el próximo toca en la corrida que siga
      }
    }

    return new Response(JSON.stringify({ ok: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
