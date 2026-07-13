// Supabase Edge Function: blog-approve
// PUBLICAR DESDE EL EMAIL: GET ?id=<blog>&t=<approve_token> → arma el .astro
// (misma plantilla que el dashboard, + hero image y video si los trae), lo
// commitea a GitHub (Cloudflare deploya) y redirige al artículo live.
// El token es de un solo uso por borrador — sin token válido no publica nadie.
//
// Deploy:  supabase functions deploy blog-approve --no-verify-jwt
// Secrets: GITHUB_TOKEN, GITHUB_REPO (los mismos de publish-blog)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding/base64";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GH_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const REPO = Deno.env.get("GITHUB_REPO") || "Viven1/viven-astro-website";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

function buildAstro(b: Record<string, unknown>, sibs: Record<string, string> = {}): { path: string; content: string; url: string } {
  const lang = String(b.lang || "en");
  const slug = String(b.slug || "");
  const title = String(b.title || "");
  const desc = String(b.description || "");
  const url = `https://www.viven.ch/${lang}/blog/${slug}/`;
  const body = String(b.body_html || "").replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, (_m, s: string, a: string) => `<a href={p("${s.trim()}")}>${a.trim()}</a>`);
  const faq = Array.isArray(b.faq) ? b.faq as { q: string; a: string }[] : [];
  const faqSchema = faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } }));
  const jsonld = JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "BlogPosting", mainEntityOfPage: { "@type": "WebPage", "@id": url }, headline: title, description: desc, inLanguage: lang, author: { "@type": "Person", name: "Sofia Treviño" }, publisher: { "@id": "https://www.viven.ch/#organization" }, url, datePublished: new Date().toISOString(), ...(b.hero_image ? { image: "https://www.viven.ch" + b.hero_image } : {}) },
    { "@type": "BreadcrumbList", itemListElement: [ { "@type": "ListItem", position: 1, name: "Home", item: "https://www.viven.ch/" }, { "@type": "ListItem", position: 2, name: "Blog", item: "https://www.viven.ch/blog/" }, { "@type": "ListItem", position: 3, name: title, item: url } ] },
    ...(faqSchema.length ? [{ "@type": "FAQPage", mainEntity: faqSchema }] : []),
  ] });
  const esc = (x: string) => x.replace(/</g, "");
  const heroImg = b.hero_image ? `<img src="${b.hero_image}" alt="${esc(title)}" loading="eager" style="width:100%;border-radius:16px;margin:8px 0 26px;aspect-ratio:16/9;object-fit:cover" />\n` : "";
  const videoBlock = b.video_id ? `\n<div style="position:relative;aspect-ratio:16/9;border-radius:16px;overflow:hidden;margin:26px 0"><iframe src="https://player.vimeo.com/video/${b.video_id}?dnt=1" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>\n` : "";
  const MONTHS: Record<string, string[]> = { en: ["January","February","March","April","May","June","July","August","September","October","November","December"], de: ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"], es: ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"] };
  const dNow = new Date(); const mName = (MONTHS[lang] || MONTHS.en)[dNow.getMonth()];
  const dateStr = lang === "de" ? `${dNow.getDate()}. ${mName} ${dNow.getFullYear()}` : lang === "es" ? `${dNow.getDate()} de ${mName} de ${dNow.getFullYear()}` : `${mName} ${dNow.getDate()}, ${dNow.getFullYear()}`;
  const relHeading = lang === "de" ? "Das könnte dich auch interessieren" : lang === "es" ? "Esto también te puede interesar" : "Related reading";
  const moreLbl = lang === "de" ? "Weiterlesen →" : lang === "es" ? "Leer más →" : "Read more →";
  const galH = lang === "de" ? "Sehen Sie unsere Arbeiten" : lang === "es" ? "Mira nuestro trabajo" : "See our work";
  const content =
`---
import Base from '../../../../layouts/Base.astro';
import { localePath } from '../../../../i18n.js';
import VideoGallery from '../../../../components/VideoGallery.astro';
const lang = "${lang}";
const p = (s) => localePath(lang, s);
const title = {"${lang}":${JSON.stringify(title + " | Viven")}};
const description = {"${lang}":${JSON.stringify(desc)}};

// Related reading: 3 posts hermanos con mayor overlap de palabras del slug — se recalcula en cada build
const OWN_SLUG = "${slug}";
const REL_STOP = new Set(['the','and','with','for','your','how','what','why','video','videos','videoproduktion','videoproduccion','production','produktion','produccion','company','agentur','agency','marken','brands','marcas','schweiz','switzerland','suiza','zurich','zuerich','que','como','con','para','der','die','das','und','fuer','von','wie','ein','eine']);
const relWords = (x) => new Set(String(x).split('-').filter((w) => w.length > 2 && !REL_STOP.has(w)));
const relOwn = relWords(OWN_SLUG);
const related = Object.entries(import.meta.glob('../*/index.astro', { query: '?raw', import: 'default', eager: true }))
  .map(([rp, rraw]) => {
    const rslug = rp.split('/')[1];
    if (rslug === OWN_SLUG) return null;
    const rm = String(rraw).match(/const title = [{]"[a-z]{2}":("(?:[^"\\\\]|\\\\.)*")[}]/);
    const dm = String(rraw).match(/const description = [{]"[a-z]{2}":("(?:[^"\\\\]|\\\\.)*")[}]/);
    let rtitle = rslug, rdesc = '';
    try { if (rm) rtitle = JSON.parse(rm[1]).replace(/ \\| Viven$/, ''); if (dm) rdesc = JSON.parse(dm[1]); } catch (e) { /* archivo irregular */ }
    let score = 0; relWords(rslug).forEach((w) => { if (relOwn.has(w)) score++; });
    return { slug: rslug, title: rtitle, desc: rdesc, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 3);
---
<Base lang={lang} slug="blog/${slug}" active="blog" singleLang={true} langUrls={${JSON.stringify({ en: "/en/blog/", de: "/de/blog/", es: "/es/blog/", ...Object.fromEntries(Object.entries(sibs).map(([l, s2]) => [l, `/${l}/blog/${s2}/`])), [lang]: `/${lang}/blog/${slug}/` })}} title={title} description={description}>
  <script type="application/ld+json" slot="jsonld" set:html={${JSON.stringify(jsonld)}}></` + `script>
<section class="page-hero post-hero"><div class="wrap"><div class="post-wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href={p("")}>Home</a> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg> <a href={p("blog")}>Blog</a> <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg> <span>${esc(title)}</span></nav>
  <span class="eyebrow">${esc(String(b.eyebrow || "Industry insight"))}</span>
  <h1>${esc(title)}</h1>
  <p class="lead">${esc(String(b.lead || desc))}</p>
  <p class="post-meta"><span>Sofia Treviño</span> <span>·</span> <span>${dateStr}</span></p>
</div></div></section>
<section class="sec" style="padding-top:40px"><div class="wrap"><div class="post-wrap post-body reveal">
${heroImg}${body}${videoBlock}
</div></div></section>

<!-- ============ RELATED ============ -->
<section class="sec" style="padding-top:0">
  <div class="wrap">
    <div class="related reveal">
      <h2>${relHeading}</h2>
      <div class="related-grid">
      {related.map((r) => (
        <a href={p('blog/' + r.slug)} class="related-card reveal">
          <h3>{r.title}</h3>
          <p>{r.desc}</p>
          <span class="more">${moreLbl}</span>
        </a>
      ))}
      </div>
    </div>
  </div>
</section>

<!-- ============ CTA / FORM ============ -->
<section class="cta" id="start" style="padding-top:0">
  <div class="wrap">
    <div class="cta-card reveal">
      <div>
        <span class="eyebrow" data-en="Let's talk" data-de="Sprechen wir" data-es="Hablemos">Let's talk</span>
        <h2 data-en="Tell us what you're working on." data-de="Erzählen Sie uns von Ihrem Projekt." data-es="Contanos en qué estás trabajando.">Tell us what you're working on.</h2>
        <p class="lead" data-en="Tell us your goal — we'll come back with timing and a clear quote within 48 hours. Free, no obligation." data-de="Nennen Sie uns Ihr Ziel — wir melden uns innert 48 Stunden mit Timing und einem klaren Angebot. Kostenlos und unverbindlich." data-es="Contanos tu objetivo — volvemos en 48 horas con tiempos y un presupuesto claro. Gratis y sin compromiso.">Tell us your goal — we'll come back with timing and a clear quote within 48 hours. Free, no obligation.</p>
        <ul>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 13 4 4L19 7"/></svg><span data-en="First draft within two weeks" data-de="Erster Entwurf in zwei Wochen" data-es="Primer borrador en dos semanas">First draft within two weeks</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 13 4 4L19 7"/></svg><span data-en="One partner, brief to delivery" data-de="Ein Partner, vom Brief bis zur Auslieferung" data-es="Un partner, de principio a fin">One partner, brief to delivery</span></li>
          <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 13 4 4L19 7"/></svg><span data-en="Multilingual delivery" data-de="Mehrsprachige Auslieferung" data-es="Entrega multilingüe">Multilingual delivery</span></li>
        </ul>
      </div>
      <div>
        <div class="lead-form-mount"></div>
        <p class="form-note" data-en="We'll reply within one business day. No spam, ever." data-de="Wir antworten innerhalb eines Werktags. Kein Spam." data-es="Respondemos en un día hábil. Nunca spam.">We'll reply within one business day. No spam, ever.</p>
        <p class="book-call-note"><span data-en="Prefer to talk it through?" data-de="Lieber direkt sprechen?" data-es="¿Preferís hablarlo directamente?">Prefer to talk it through?</span> <a class="book-call" href="/book/" target="_blank" rel="noopener" data-en="Book a free 15-min call →" data-de="Gratis 15-Min-Call buchen →" data-es="Reservá una llamada gratis de 15 min →">Book a free 15-min call →</a></p>
      </div>
    </div>
  </div>
</section>

  <section class="sec blog-videos" style="padding-top:0"><div class="wrap">
    <h2 style="font-size:22px;margin-bottom:20px">${galH}</h2>
    <VideoGallery lang={lang} limit={3} seed="${slug}" />
  </div></section>
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

    const sibs: Record<string, string> = {};
    if (b.group_id) {
      const { data: sb } = await service.from("blogs").select("lang,slug").eq("group_id", b.group_id).eq("status", "published");
      (sb ?? []).forEach((r: { lang: string; slug: string }) => { if (r.lang !== b.lang) sibs[r.lang] = r.slug; });
    }
    const { path, content, url } = buildAstro(b, sibs);
    const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
    const gh = { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "viven-dashboard", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" };
    let sha: string | undefined;
    const g = await fetch(api + "?ref=main", { headers: gh });
    if (g.ok) sha = (await g.json()).sha;
    const put = await fetch(api, { method: "PUT", headers: gh, body: JSON.stringify({ message: "blog (email-approve): " + b.title, content: encodeBase64(content), branch: "main", ...(sha ? { sha } : {}) }) });
    if (!put.ok) return json({ error: "GitHub " + put.status + ": " + (await put.text()).slice(0, 200) }, 500);

    await service.from("blogs").update({ status: "published", published_at: new Date().toISOString(), published_url: url, approve_token: null }).eq("id", id);

    // sitemap + IndexNow (best effort)
    try {
      const sApi = `https://api.github.com/repos/${REPO}/contents/public/sitemap.xml`;
      const sg = await fetch(sApi + "?ref=main", { headers: gh });
      if (sg.ok) {
        const sj = await sg.json();
        const xml = new TextDecoder().decode(decodeBase64(String(sj.content).replace(/\n/g, "")));
        if (!xml.includes(url)) {
          const entry = `  <url><loc>${url}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>\n</urlset>`;
          await fetch(sApi, { method: "PUT", headers: gh, body: JSON.stringify({ message: "sitemap: + " + url, content: encodeBase64(xml.replace(/<\/urlset>\s*$/, entry)), branch: "main", sha: sj.sha }) });
        }
      }
      await fetch("https://api.indexnow.org/indexnow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: "www.viven.ch", key: "f5d336eabbd541e0ae3c7683bb4b149a", keyLocation: "https://www.viven.ch/f5d336eabbd541e0ae3c7683bb4b149a.txt", urlList: [url] }) });
    } catch (e2) { console.error("POSTPUBLISH_WARN", String(e2)); }
    // página HTML mínima de confirmación (el deploy tarda ~2 min)
    return new Response(`<!doctype html><meta charset="utf-8"><title>Publicado ✓</title><body style="font-family:sans-serif;background:#0f1826;color:#f4f6fb;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1>🚀 Publicado</h1><p>${b.title}</p><p style="color:#9aa6bd">El deploy tarda ~2 minutos.</p><p><a href="${url}" style="color:#ddf98f">${url}</a></p></div>`, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
