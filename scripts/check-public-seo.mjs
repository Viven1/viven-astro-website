// Check the generated public site, so a green build also means usable SEO links.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('dist');
const site = 'https://www.viven.ch';
const normalize = (url) => decodeURI(url).normalize('NFC');
const htmlByUrl = new Map();
function page(url) {
  const key = normalize(url);
  if (htmlByUrl.has(key)) return htmlByUrl.get(key);
  const path = resolve(root, '.' + decodeURIComponent(new URL(key).pathname), 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) return null;
  const html = readFileSync(path, 'utf8');
  htmlByUrl.set(key, html);
  return html;
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}
function alternates(html) {
  return [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attributes(m[0]))
    .filter((a) => a.rel === 'alternate' && a.hreflang && a.hreflang !== 'x-default');
}
const sitemap = readFileSync(resolve(root, 'sitemap-0.xml'), 'utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const problems = [];
for (const url of urls) {
  const html = page(url);
  if (!html) { problems.push(`${url}: generated page missing`); continue; }
  if ([...html.matchAll(/<main\b/g)].length !== 1) problems.push(`${url}: expected one main landmark`);
  if (/<a\b[^>]*href=["'][^"']*(?:\{p\(|<a\b)/.test(html)) problems.push(`${url}: unrendered template in a link`);
  for (const { hreflang, href } of alternates(html)) {
    if (!href.startsWith(site + '/')) { problems.push(`${url}: unexpected alternate ${href}`); continue; }
    const target = page(href);
    if (!target) { problems.push(`${url}: alternate missing: ${href}`); continue; }
    const targetLang = attributes(target.match(/<html\b[^>]*>/)?.[0] || '').lang;
    if (targetLang !== hreflang) problems.push(`${url}: ${hreflang} points to ${targetLang}`);
    if (!alternates(target).some((a) => normalize(a.href) === normalize(url))) {
      problems.push(`${url}: alternate has no return link: ${href}`);
    }
    if (/\/blog\/[^/]+\/$/.test(url) && /\/blog\/$/.test(href)) problems.push(`${url}: blog index is not an article translation`);
  }
}
for (const route of ['/en/case-studies/', '/es/casos-de-exito/']) {
  if (!urls.includes(site + route)) problems.push(`${route}: missing from sitemap`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`✓ public SEO: ${urls.length} pages, reciprocal language links, main landmarks and no broken template links`);
