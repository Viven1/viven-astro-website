// ============================================================
//  i18n — URLs por idioma: /en/ · /de/ · /es/
//  Fuente única para rutas, hreflang y etiquetas del chrome (header/footer).
// ============================================================
export const LANGS = ['en', 'de', 'es'];
export const DEFAULT_LANG = 'en';
export const SITE = 'https://www.viven.ch';

// getStaticPaths compartido: genera las 3 variantes de idioma de una página.
export function langPaths() {
  return LANGS.map((lang) => ({ params: { lang } }));
}

// URL de una página (slug '' = home) en un idioma dado.
export function localePath(lang, slug) {
  return slug ? `/${lang}/${slug}/` : `/${lang}/`;
}

// Alternates hreflang para el <head> de un slug.
export function hreflangs(slug) {
  const alts = LANGS.map((lang) => ({ lang, href: SITE + localePath(lang, slug) }));
  alts.push({ lang: 'x-default', href: SITE + localePath(DEFAULT_LANG, slug) });
  return alts;
}

// Elegir el valor del idioma actual de un objeto {en,de,es} (fallback en).
export function pick(dict, lang) {
  return (dict && (dict[lang] ?? dict[DEFAULT_LANG])) || '';
}

// Etiquetas del header/footer, server-rendered en el idioma correcto.
export const T = {
  home:        { en: 'Home', de: 'Home', es: 'Inicio' },
  services:    { en: 'Services', de: 'Leistungen', es: 'Servicios' },
  brand:       { en: 'Brand Videos', de: 'Markenfilme', es: 'Videos de marca' },
  product:     { en: 'Product Videos', de: 'Produktvideos', es: 'Videos de producto' },
  employer:    { en: 'Employer Branding', de: 'Employer Branding', es: 'Employer Branding' },
  howto:       { en: 'How-To & Tutorials', de: 'How-To & Tutorials', es: 'Tutoriales y How-To' },
  social:      { en: 'Social Media Videos', de: 'Social-Media-Videos', es: 'Videos para redes sociales' },
  corporate:   { en: 'Corporate & Events', de: 'Corporate & Events', es: 'Corporativo y eventos' },
  allServices: { en: 'All services →', de: 'Alle Leistungen →', es: 'Todos los servicios →' },
  projects:    { en: 'Projects', de: 'Projekte', es: 'Proyectos' },
  blog:        { en: 'Blog', de: 'Blog', es: 'Blog' },
  tools:       { en: 'Tools & guides', de: 'Tools & Leitfäden', es: 'Herramientas y guías' },
  why:         { en: 'Why Viven', de: 'Warum Viven', es: 'Por qué Viven' },
  faq:         { en: 'FAQ', de: 'FAQ', es: 'FAQ' },
  contact:     { en: 'Contact', de: 'Kontakt', es: 'Contacto' },
  cta:         { en: 'Start a project', de: 'Projekt starten', es: 'Iniciar proyecto' },
  menu:        { en: 'Menu', de: 'Menü', es: 'Menú' },
  footerTag:   {
    en: 'Viven AG — the video production company trusted by leading brands across Switzerland and beyond.',
    de: 'Viven AG — die Videoproduktion, der führende Marken in der Schweiz und darüber hinaus vertrauen.',
    es: 'Viven AG — la productora de video en la que confían marcas líderes en Suiza y más allá.'
  },
  company:     { en: 'Company', de: 'Unternehmen', es: 'Empresa' },
  follow:      { en: 'Follow', de: 'Folgen', es: 'Síguenos' },
  rights:      { en: 'All rights reserved.', de: 'Alle Rechte vorbehalten.', es: 'Todos los derechos reservados.' },
  madeIn:      { en: 'Made in Switzerland', de: 'Made in Switzerland', es: 'Hecho en Suiza' },
  privacy:     { en: 'Privacy Policy', de: 'Datenschutz', es: 'Privacidad' },
  terms:       { en: 'Terms', de: 'AGB', es: 'Términos' },
  socialMediaShort: { en: 'Social Media Videos', de: 'Social-Media-Videos', es: 'Videos para redes' }
};

/* El texto de cada idioma vivía SOLO en atributos data-de/data-es y lo cambiaba
   el navegador con JS. Para una persona funciona; para Google no: la página que
   indexa es la que llega del servidor, y esa estaba en inglés incluso en /de/ y
   /es/. Medido en agosto 2026: las 12 páginas de servicio alemanas y españolas
   servían inglés, y el 93% de nuestras impresiones eran de búsquedas en inglés.
   L() escribe el idioma correcto en el HTML desde el build. Los atributos se
   quedan igual, porque el selector de idioma del cliente los sigue usando. */
export const L = (lang, en, de, es) => (lang === 'de' ? (de || en) : lang === 'es' ? (es || en) : en);
