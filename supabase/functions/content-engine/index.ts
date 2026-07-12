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
  const localizeNote = localize
    ? `\n\nIMPORTANT — this is the ${language} version of an existing article on the same subject. Do NOT translate. Write a fresh, native ${language} article: think about the keywords a ${language}-speaking audience in the DACH/Swiss market ACTUALLY searches for this topic, and use those terms naturally in the title, headings and body. Localize examples, phrasing and search intent to that market.`
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

Deno.serve(async (_req) => {
  try {
    // próximo tema pendiente (mayor prioridad primero, después FIFO)
    const { data: items, error } = await service.from("content_queue")
      .select("*").eq("status", "pending").order("priority", { ascending: false }).order("id").limit(1);
    if (error) return json({ error: error.message }, 500);
    const item = (items ?? [])[0];
    if (!item) return json({ ok: true, msg: "cola vacía — sembrá más temas en content_queue" });

    await service.from("content_queue").update({ status: "working" }).eq("id", item.id);
    const groupId = crypto.randomUUID();
    const made: string[] = [];
    try {
      const en = await writeArticle(item.topic, "en", false);
      await service.from("blogs").insert({ lang: "en", topic: item.topic, slug: en.slug, title: en.title, description: en.description, eyebrow: en.eyebrow || "Industry insight", lead: en.lead, body_html: en.body_html, faq: en.faq, status: "draft", group_id: groupId });
      made.push("EN");
      const de = await writeArticle(item.topic, "de", true);
      await service.from("blogs").insert({ lang: "de", topic: item.topic, slug: de.slug, title: de.title, description: de.description, eyebrow: de.eyebrow || "Industry insight", lead: de.lead, body_html: de.body_html, faq: de.faq, status: "draft", group_id: groupId });
      made.push("DE");
    } catch (e) {
      // si falla a mitad, el tema vuelve a la cola para el próximo run
      if (!made.length) { await service.from("content_queue").update({ status: "pending" }).eq("id", item.id); throw e; }
    }
    await service.from("content_queue").update({ status: "done", done_at: new Date().toISOString() }).eq("id", item.id);
    await pushAll("📝 Borradores listos: " + item.topic, made.join(" + ") + " esperan tu aprobación en el tab Blog.", "/dashboard/");
    return json({ ok: true, topic: item.topic, made });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
