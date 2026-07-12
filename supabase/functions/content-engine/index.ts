// Supabase Edge Function: content-engine
// El MOTOR DE CONTENIDO: corre por cron lunes/miércoles/viernes, toma el próximo
// tema de content_queue, escribe el artículo en EN + su versión NATIVA en DE
// (misma lógica y prompt que ai-blog), los guarda como BORRADORES en blogs
// (nunca publica solo — Sebastián aprueba en el tab Blog) y avisa por push.
//
// Deploy:   supabase functions deploy content-engine --no-verify-jwt
// Schedule: SQL 0032 (cron L/M/V 05:30 UTC ≈ 07:30 CH)
// Secrets:  ANTHROPIC_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// media por categoría: hero image SIEMPRE (stills reales), video solo cuando encaja
const MEDIA: Record<string, { imgs: string[]; video?: string }> = {
  corporate: { imgs: ["/projects/siemens-shaping-the-future-together-employer-branding-campaign/03-RORES_clean_VIVEN.00_09_29_23.Still033.jpg"], video: "861150876" },
  employer:  { imgs: ["/projects/siemens-shaping-the-future-together-employer-branding-campaign/02-RORES_clean_VIVEN.00_13_13_20.Still042.jpg"], video: "412290258" },
  product:   { imgs: ["/projects/meteomatics-product-campaign-brand-video/02-Meteomatics_VIVEN_Video_Agentur_040.jpg"], video: "1068759296" },
  social:    { imgs: ["/projects/fifa-living-football-social-media-campaign/01-Living_Football_Viven_Video_Agentur6.jpeg"], video: "828322230" },
  howto:     { imgs: ["/projects/kanebo-sensai-skincare-how-to-video-campaign/01-re_How_To_Videos_Viven_Video_Agency_51.jpg"], video: "1026464530" },
  event:     { imgs: ["/projects/fifa-living-football-social-media-campaign/02-Living_Football_Viven_Video_Agentur17.jpeg"], video: "757649241" },
  brand:     { imgs: ["/projects/meteomatics-product-campaign-brand-video/03-Meteomatics_VIVEN_Video_Agentur_060.jpg"], video: "502153490" },
  process:   { imgs: ["/projects/siemens-shaping-the-future-together-employer-branding-campaign/05-RORES_clean_VIVEN.00_12_48_09.Still040.jpg"] },
  general:   { imgs: ["/projects/carvolution-tvc-social-media-campaign/01-2sec_EN_B_v20210824_COMPOSED.Still0013.jpg"] },
};
function pickMedia(topic: string): { hero: string; video: string | null } {
  const t = topic.toLowerCase();
  const cat = /corporate|internal comm/.test(t) ? "corporate"
    : /employer|recruit|talent|gen z/.test(t) ? "employer"
    : /product/.test(t) ? "product"
    : /social/.test(t) ? "social"
    : /how-to|explainer|support|onboarding|e-learning/.test(t) ? "howto"
    : /event|stream|trade show/.test(t) ? "event"
    : /cost|price|roi|choose|brief|timeline|process|shoot day|batch/.test(t) ? "process"
    : /brand|marketing|video seo|multilingual|trend/.test(t) ? "brand" : "general";
  const m = MEDIA[cat] || MEDIA.general;
  return { hero: m.imgs[0], video: m.video || null };
}

const INTERNAL = ["services/brand-video", "services/product-video", "services/employer-branding", "services/how-to-video", "services/social-media-video", "services/corporate-video", "projects", "contact", "faq", "blog", "resources"];

async function pushAll(title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  const { data: subs } = await service.from("push_subscriptions").select("*");
  const payload = JSON.stringify({ title, body, url });
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await service.from("push_subscriptions").delete().eq("id", s.id); }
  }
}

async function writeArticle(topic: string, lang: string, localize: boolean) {
  const language = lang === "de" ? "German" : lang === "es" ? "Spanish" : "English";
  const market = lang === "de" ? "Swiss/DACH (German-speaking)" : lang === "es" ? "Spanish-speaking (Spain + Latin America, and Spanish speakers in Switzerland)" : "international";
  const localizeNote = localize
    ? `\n\nIMPORTANT — this is the ${language} version of an existing article on the same subject. Do NOT translate. Write a fresh, NATIVE ${language} article: research mentally what keywords a ${language}-speaking audience in the ${market} market ACTUALLY types into Google for this topic (their real search phrasing, not a translation of the English keyword), and use those exact terms naturally in the title, H2s, slug and body. Localize examples, currency framing and search intent. It must read as originally written for that market.`
    : "";
  const prompt = `You write SEO blog articles for VIVEN AG, a video production company in Zürich (clients: UBS, Siemens, Porsche, ON, FIFA, Philips). Goal: rank on Google + AI overviews and drive leads.

Write a complete, genuinely useful article in ${language} about: "${topic}".${localizeNote}

Rules:
- 700–1100 words. Natural, expert, non-fluffy. Answer the search intent directly in the first paragraph.
- Structure: a strong lead paragraph, then 4–6 <h2> sections (with <h3> and <ul> where useful). No <h1>.
- Weave in 2–4 internal links using EXACTLY this placeholder form: [[slug|anchor text]] where slug is one of: ${INTERNAL.join(", ")}. Use them naturally.
- Never claim the founder made a "Netflix original" — the correct fact is: produced the first Swiss feature film on Netflix.
- End with a short CTA paragraph inviting the reader to contact Viven.
- Add 3 FAQ Q&A pairs for schema (concise answers).
- SEO title ≤ 60 chars ("| Viven" is added by us). Meta description ≤ 155 chars.
- slug: kebab-case, ascii.

Respond ONLY with valid minified JSON, no markdown fences:
{"title":"...","slug":"...","description":"...","eyebrow":"Industry insight","lead":"first paragraph, plain text","body_html":"<h2>...</h2><p>...</p>","faq":[{"q":"...","a":"..."}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: "You output ONLY a single valid minified JSON object. No markdown, no code fences, no commentary.",
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }],
    }),
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  let text = (data.content?.[0]?.text ?? "").trim();
  if (!text.startsWith("{")) text = "{" + text;
  text = text.replace(/```json|```/g, "").trim();
  const last = text.lastIndexOf("}");
  if (last > -1) text = text.slice(0, last + 1);
  let p: { title?: string; slug?: string; description?: string; eyebrow?: string; lead?: string; body_html?: string; faq?: unknown[] } | null = null;
  try { p = JSON.parse(text); } catch { p = null; }
  if (!p || !p.body_html) throw new Error("artículo inválido (" + lang + ")");
  p.faq = Array.isArray(p.faq) ? p.faq.slice(0, 5) : [];
  p.slug = String(p.slug || topic).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  return p;
}

Deno.serve(async (req) => {
  try {
    // modo WRITE NOW: body {queue_id} escribe ESE tema ya (botón ⚡ del dashboard);
    // sin body: el cron toma el próximo pendiente por prioridad
    const body = await req.json().catch(() => ({}));
    let item: Record<string, unknown> | undefined;
    if (body.queue_id) {
      const { data: one, error: e1 } = await service.from("content_queue").select("*").eq("id", body.queue_id).neq("status", "working").maybeSingle();
      if (e1) return json({ error: e1.message }, 500);
      item = one ?? undefined;
      if (!item) return json({ error: "tema no encontrado (¿ya se está escribiendo?)" }, 404);
    } else {
      const { data: items, error } = await service.from("content_queue")
        .select("*").eq("status", "pending").order("priority", { ascending: false }).order("id").limit(1);
      if (error) return json({ error: error.message }, 500);
      item = (items ?? [])[0];
    }
    if (!item) return json({ ok: true, msg: "cola vacía — sembrá más temas en content_queue" });

    await service.from("content_queue").update({ status: "working" }).eq("id", item.id);
    const groupId = crypto.randomUUID();
    const media = pickMedia(item.topic);
    const made: { lang: string; id: number; title: string; lead: string; token: string | null; body: string; faq: { q: string; a: string }[] }[] = [];
    try {
      for (const [lg, loc] of [["en", false], ["de", true], ["es", true]] as [string, boolean][]) {
        const a = await writeArticle(item.topic, lg, loc);
        const token = crypto.randomUUID();
        // insert RESILIENTE: si faltan columnas nuevas (SQL 0034 sin correr), las saca y reintenta
        let row: Record<string, unknown> = {
          lang: lg, topic: item.topic, slug: a.slug, title: a.title, description: a.description,
          eyebrow: a.eyebrow || "Industry insight", lead: a.lead, body_html: a.body_html, faq: a.faq,
          status: "draft", group_id: groupId, hero_image: media.hero, video_id: media.video, approve_token: token,
        };
        let ins = await service.from("blogs").insert(row).select("id").single();
        for (let tries = 0; ins.error && tries < 4; tries++) {
          const m = /'([^']+)' column/.exec(ins.error.message || "");
          if (!m || !(m[1] in row)) break;
          delete row[m[1]];
          ins = await service.from("blogs").insert(row).select("id").single();
        }
        if (ins.error) throw new Error("no pude guardar el borrador (" + lg + "): " + ins.error.message);
        made.push({ lang: lg.toUpperCase(), id: ins.data?.id, title: a.title, lead: a.lead || "", token: ("approve_token" in row) ? token : null, body: a.body_html || "", faq: (a.faq || []) as { q: string; a: string }[] });
      }
    } catch (e) {
      if (!made.length) { await service.from("content_queue").update({ status: "pending" }).eq("id", item.id); throw e; }
    }
    await service.from("content_queue").update({ status: "done", done_at: new Date().toISOString() }).eq("id", item.id);
    await pushAll("📝 Borradores listos: " + item.topic, made.map((m) => m.lang).join(" + ") + " esperan tu aprobación (email o tab Blog).", "/dashboard/");

    // email a Sebastián con preview + botones Publicar / Editar
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (RESEND_API_KEY && made.length) {
      const FN = Deno.env.get("SUPABASE_URL") + "/functions/v1/blog-approve";
      // artículo COMPLETO legible en el email: hero + cuerpo entero + FAQ, botones arriba
      const clean = (h: string) => h.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "<strong>$1</strong>");
      const cards = made.map((m) => `
        <div style="border:1px solid #e3e6ec;border-radius:14px;padding:20px 22px;margin:0 0 22px">
          <div style="font-size:11px;letter-spacing:.08em;color:#8a94a8;font-weight:700">${m.lang}</div>
          <div style="font-size:19px;font-weight:700;margin:4px 0 12px">${m.title}</div>
          <div style="margin-bottom:14px">
            ${m.token ? `<a href="${FN}?id=${m.id}&t=${m.token}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:10px 18px;border-radius:100px;text-decoration:none;margin-right:8px">🚀 Publicar ${m.lang}</a>` : ""}
            <a href="https://www.viven.ch/dashboard/" style="display:inline-block;border:1px solid #d5d9e2;color:#1a2230;font-weight:600;padding:10px 18px;border-radius:100px;text-decoration:none">✏️ Editar en el dashboard</a>
          </div>
          <img src="https://www.viven.ch${media.hero}" alt="" style="width:100%;border-radius:12px;margin-bottom:14px" />
          <div style="font-size:15px;color:#1a2230;line-height:1.7;font-style:italic;margin-bottom:12px">${m.lead}</div>
          <div style="font-size:14px;color:#333c4a;line-height:1.75">${clean(m.body)}</div>
          ${m.faq.length ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eceef2"><b style="font-size:13px">FAQ</b>${m.faq.map((f) => `<p style="font-size:13px;margin:8px 0 2px"><b>${f.q}</b><br>${f.a}</p>`).join("")}</div>` : ""}
          ${media.video ? `<p style="font-size:12.5px;color:#8a94a8;margin-top:12px">🎬 Al publicar se embebe también el video Vimeo ${media.video} al final del artículo.</p>` : ""}
        </div>`).join("");
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Viven Content Engine <leads@viven.ch>", to: ["sebastian@viven.ch"],
          subject: "📝 Para aprobar: " + item.topic,
          html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto"><h2 style="font-size:18px">Nuevos borradores del motor de contenido</h2><p style="color:#5b6472;font-size:13.5px">Tema: <b>${item.topic}</b> · hero image ✓${media.video ? " · video ✓" : ""}. Un click en Publicar y sale a la web (deploy ~2 min); Editar abre el dashboard.</p>${cards}</div>`,
        }),
      }).catch(() => {});
    }
    return json({ ok: true, topic: item.topic, made: made.map((m) => m.lang) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
