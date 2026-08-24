#!/usr/bin/env node
/* Avisa a Bing (y a Yandex, y a cualquiera que hable IndexNow) que unas URLs
   cambiaron. Google NO usa IndexNow — a Google se le avisa reenviando el
   sitemap, que ya lo hace la function gsc-sitemap-submit todos los días.
   Bing en cambio no tenía forma de enterarse de nada: hasta hoy dependía de
   pasar solo.

   Uso:  node scripts/indexnow.mjs                 → manda todo el sitemap
         node scripts/indexnow.mjs /de/x/ /es/y/   → manda solo esas URLs

   La clave vive en public/<clave>.txt y tiene que estar publicada ANTES del
   aviso: así el buscador comprueba que quien avisa es dueño del dominio. */
import { readFileSync, readdirSync } from 'node:fs';

const HOST = 'www.viven.ch';
const clave = readdirSync('public').find((f) => /^[0-9a-f]{32}\.txt$/.test(f))?.replace('.txt', '');
if (!clave) { console.error('No encuentro la clave de IndexNow en public/'); process.exit(1); }

let urls = process.argv.slice(2).map((u) => `https://${HOST}${u.startsWith('/') ? u : '/' + u}`);
if (!urls.length) {
  const xml = readFileSync('dist/sitemap-0.xml', 'utf8');
  urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}
if (urls.length > 10000) urls = urls.slice(0, 10000);   // tope del protocolo

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: clave, keyLocation: `https://${HOST}/${clave}.txt`, urlList: urls }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} · ${urls.length} URLs`);
if (res.status >= 400) { console.error(await res.text()); process.exit(1); }
