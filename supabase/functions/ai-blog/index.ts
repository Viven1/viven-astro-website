// Supabase Edge Function: ai-blog
// Genera un artículo de blog SEO completo desde un tema/keyword, con la estructura de Viven:
// title, slug, meta description, lead, cuerpo HTML (h2/h3/p/ul), FAQ (para schema), links internos sugeridos.
// El dashboard lo previsualiza y arma el .astro listo para publicar.
//
// Deploy:  supabase functions deploy ai-blog --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// links internos de Viven que la IA puede referenciar (slug relativo, sin /lang/)
const INTERNAL = ["services/brand-video", "services/product-video", "services/employer-branding", "services/how-to-video", "services/social-media-video", "services/corporate-video", "projects", "contact", "faq", "blog"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { topic = "", keyword = "", lang = "en", localize = false } = await req.json();
    const t = (topic || keyword || "").trim();
    if (!t) return json({ error: "falta el tema/keyword" }, 400);
    const language = lang === "de" ? "German" : lang === "es" ? "Spanish" : "English";
    // cuando es una versión en otro idioma: NO traducir — reescribir nativo con keywords locales
    const localizeNote = localize
      ? `\n\nIMPORTANT — this is the ${language} version of an existing article on the same subject. Do NOT translate. Write a fresh, native ${language} article: think about the keywords a ${language}-speaking audience in the DACH/Swiss (or Hispanic) market ACTUALLY searches for this topic, and use those terms naturally in the title, headings and body. Localize examples, phrasing and search intent to that market. It should read as if originally written for that audience.`
      : "";

    const prompt = `You write SEO blog articles for VIVEN AG, a video production company in Zürich (clients: UBS, Siemens, Porsche, ON, FIFA, Philips). Goal: rank on Google + AI overviews and drive leads.

Write a complete, genuinely useful article in ${language} about: "${t}".${localizeNote}

Rules:
- 700–1100 words. Natural, expert, non-fluffy. Answer the search intent directly in the first paragraph.
- Structure: a strong lead paragraph, then 4–6 <h2> sections (with <h3> and <ul> where useful). No <h1> (the title is separate).
- Weave in 2–4 internal links using EXACTLY this placeholder form: [[slug|anchor text]] where slug is one of: ${INTERNAL.join(", ")}. Use them naturally, not stuffed.
- End with a short CTA paragraph inviting the reader to contact Viven.
- Add 3 FAQ Q&A pairs for schema (concise answers, 1–3 sentences).
- SEO title ≤ 60 chars incl. "| Viven" is added by us, so keep it short. Meta description ≤ 155 chars, compelling.
- slug: kebab-case, ascii, from the title, no stopword-stuffing.

Respond ONLY with valid minified JSON, no markdown fences:
{"title":"...","slug":"...","description":"...","eyebrow":"Industry insight","lead":"first paragraph, plain text","body_html":"<h2>...</h2><p>... [[services/brand-video|brand video]] ...</p>...","faq":[{"q":"...","a":"..."}]}`;

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
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return json({ error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` });
    }
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    if (!text.startsWith("{")) text = "{" + text;
    text = text.replace(/```json|```/g, "").trim();
    const last = text.lastIndexOf("}");
    if (last > -1) text = text.slice(0, last + 1);
    let p: any;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || !p.body_html) {
      console.error("PARSE_ERROR stop=" + data.stop_reason, text.slice(-300));
      return json({ error: "La IA no devolvió un artículo válido" + (data.stop_reason === "max_tokens" ? " (cortado — probá de nuevo)" : "") + "." });
    }
    p.faq = Array.isArray(p.faq) ? p.faq.slice(0, 5) : [];
    p.slug = String(p.slug || t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
    return json({ title: p.title || t, slug: p.slug, description: p.description || "", eyebrow: p.eyebrow || "Industry insight", lead: p.lead || "", body_html: p.body_html, faq: p.faq, lang });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
