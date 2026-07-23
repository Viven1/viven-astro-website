// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Sitemap AUTOMÁTICO en cada build (antes era public/sitemap.xml a mano y
// perdía páginas — llegó a faltar el 30% del sitio, incluidos posts pilares).
// Excluidas: páginas privadas/funcionales y las LP noindex.
const SITEMAP_EXCLUDE = [
  '/dashboard/', '/proposal/', '/portal/', '/lp/',
  '/book/', '/brief/', '/thank-you/', '/danke/', '/gracias/',
];

// https://astro.build/config
export default defineConfig({
  site: 'https://www.viven.ch',
  integrations: [
    sitemap({
      filter: (page) => !SITEMAP_EXCLUDE.some((seg) => new URL(page).pathname.includes(seg)),
    }),
  ],
});
