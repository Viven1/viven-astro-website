// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { readFileSync } from 'node:fs';

// Sitemap AUTOMÁTICO en cada build (antes era public/sitemap.xml a mano y
// perdía páginas — llegó a faltar el 30% del sitio, incluidos posts pilares).
// Excluidas: páginas privadas/funcionales y las LP noindex.
const SITEMAP_EXCLUDE = [
  '/dashboard/', '/proposal/', '/portal/',
  '/book/', '/brief/', '/thank-you/', '/danke/', '/gracias/',
  '/portal/brief-preview/',  // vista previa interna del brief, no es una página del sitio
  '/abrir/',                 // puente del email a la app: interna, no es una página del sitio
];

// Cloudflare aplica estas redirecciones antes de servir los HTML generados.
// Si una ruta de origen entra al sitemap, los buscadores reciben una URL que
// inmediatamente redirige: señal contradictoria y rastreo desperdiciado.
const REDIRECT_SOURCES = new Set(
  readFileSync(new URL('./public/_redirects', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\/\S+)\s+\/\S+\s+30(?:1|2|7|8)$/)?.[1])
    .filter((path) => path && !path.includes('*') && !path.includes(':'))
    .flatMap((path) => {
      const normalized = path.endsWith('/') ? path : `${path}/`;
      return [path, normalized];
    }),
);

// https://astro.build/config
export default defineConfig({
  site: 'https://www.viven.ch',
  integrations: [
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        // La raíz es una pantalla de selección/redirección de idioma y declara
        // /en/ como canonical. Un sitemap debe listar la URL final, no esta
        // intermediaria noindex que en producción responde con redirect.
        if (pathname === '/') return false;
        if (REDIRECT_SOURCES.has(pathname)) return false;
        return !SITEMAP_EXCLUDE.some((seg) => pathname.includes(seg));
      },
    }),
  ],
});
