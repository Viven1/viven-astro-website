// Supabase Edge Function: blog-approve
// PUBLICAR DESDE EL EMAIL: GET ?id=<blog>&t=<approve_token> → arma el .astro
// (misma plantilla que el dashboard, + hero image y video si los trae), lo
// commitea a GitHub (Cloudflare deploya) y redirige al artículo live.
// El token es de un solo uso por borrador — sin token válido no publica nadie.
//
// Deploy:  supabase functions deploy blog-approve --no-verify-jwt
// Secrets: GITHUB_TOKEN, GITHUB_REPO (los mismos de publish-blog)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GH_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const REPO = Deno.env.get("GITHUB_REPO") || "Viven1/viven-astro-website";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

function buildAstro(b: Record<string, unknown>): { path: string; content: string; url: string } {
  const lang = String(b.lang || "en");
  const slug = String(b.slug || "");
  const title = String(b.title || "");
  const desc = String(b.description || "");
  const url = `https://www.viven.ch/${lang}/blog/${slug}/`;
  const body = String(b.body_html || "").replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, (_m, s: string, a: string) => `<a href={p("${s.trim()}")}>${a.trim()}</a>`);
  const faq = Array.isArray(b.faq) ? b.faq as { q: string; a: string }[] : [];
  const faqSchema = faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } }));
  const jsonld = JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "BlogPosting", mainEntityOfPage: { "@type": "WebPage", "@id": url }, headline: title, description: desc, inLanguage: lang, author: { "@type": "Person", name: "Sofia Treviño" }, publisher: { "@id": "https://www.viven.ch/#organization" }, url, ...(b.hero_image ? { image: "https://www.viven.ch" + b.hero_image } : {}) },
    { "@type": "BreadcrumbList", itemListElement: [ { "@type": "ListItem", position: 1, name: "Home", item: "https://www.viven.ch/" }, { "@type": "ListItem", position: 2, name: "Blog", item: "https://www.viven.ch/blog/" }, { "@type": "ListItem", position: 3, name: title, item: url } ] },
    ...(faqSchema.length ? [{ "@type": "FAQPage", mainEntity: faqSchema }] : []),
  ] });
  const esc = (x: string) => x.replace(/</g, "");
  const heroImg = b.hero_image ? `<img src="${b.hero_image}" alt="${esc(title)}" loading="eager" style="width:100%;border-radius:16px;margin:8px 0 26px;aspect-ratio:16/9;object-fit:cover" />\n` : "";
  const videoBlock = b.video_id ? `\n<div style="position:relative;aspect-ratio:16/9;border-radius:16px;overflow:hidden;margin:26px 0"><iframe src="https://player.vimeo.com/video/${b.video_id}?dnt=1" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>\n` : "";
  const content =
`---
import Base from '../../../../layouts/Base.astro';
import { localePath } from '../../../../i18n.js';
const lang = "${lang}";
const p = (s) => localePath(lang, s);
const title = {"${lang}":${JSON.stringify(title + " | Viven")}};
const description = {"${lang}":${JSON.stringify(desc)}};
---
<Base lang={lang} slug="blog/${slug}" active="blog" singleLang={true} langUrls={{"${lang}":"/${lang}/blog/${slug}/"}} title={title} description={description}>
  <script type="application/ld+json" slot="jsonld" set:html={${JSON.stringify(jsonld)}}></` + `script>
<section class="page-hero post-hero"><div class="wrap"><div class="post-wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href={p("")}>Home</a> <a href={p("blog")}>Blog</a> <span>${esc(title)}</span></nav>
  <span class="eyebrow">${esc(String(b.eyebrow || "Industry insight"))}</span>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(String(b.lead || desc))}</p>
</div></div></section>
<section class="sec" style="padding-top:40px"><div class="wrap"><div class="post-wrap post-body reveal">
${heroImg}${body}${videoBlock}
</div></div></section>
</Base>`;
  return { path: `src/pages/${lang}/blog/${slug}/index.astro`, content, url };
}

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const id = u.searchParams.get("id"), t = u.searchParams.get("t");
    if (!id || !t) return json({ error: "faltan id/t" }, 400);
    const { data: b } = await service.from("blogs").select("*").eq("id", id).maybeSingle();
    if (!b) return json({ error: "borrador no encontrado" }, 404);
    if (!b.approve_token || b.approve_token !== t) return json({ error: "token inválido" }, 403);
    if (b.status === "published" && b.published_url) return Response.redirect(b.published_url, 302);

    const { path, content, url } = buildAstro(b);
    const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
    const gh = { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "viven-dashboard", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" };
    let sha: string | undefined;
    const g = await fetch(api + "?ref=main", { headers: gh });
    if (g.ok) sha = (await g.json()).sha;
    const put = await fetch(api, { method: "PUT", headers: gh, body: JSON.stringify({ message: "blog (email-approve): " + b.title, content: encodeBase64(content), branch: "main", ...(sha ? { sha } : {}) }) });
    if (!put.ok) return json({ error: "GitHub " + put.status + ": " + (await put.text()).slice(0, 200) }, 500);

    await service.from("blogs").update({ status: "published", published_at: new Date().toISOString(), published_url: url, approve_token: null }).eq("id", id);
    // página HTML mínima de confirmación (el deploy tarda ~2 min)
    return new Response(`<!doctype html><meta charset="utf-8"><title>Publicado ✓</title><body style="font-family:sans-serif;background:#0f1826;color:#f4f6fb;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1>🚀 Publicado</h1><p>${b.title}</p><p style="color:#9aa6bd">El deploy tarda ~2 minutos.</p><p><a href="${url}" style="color:#ddf98f">${url}</a></p></div>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
