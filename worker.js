// Worker: intercepta TODO (run_worker_first:true en wrangler.jsonc) por dos motivos:
//
// 1) apex→www, CUALQUIER path (2026-07-28, hallazgo del Coverage de GSC que
//    revisó Sebastián): antes solo existía una redirect-rule de Cloudflare
//    para "/" exacto — viven.ch/en/blog/x servía 200 con el MISMO contenido
//    que www.viven.ch/en/blog/x (el canonical ya apuntaba bien a www, así que
//    Google no indexaba el duplicado, pero igual gastaba crawl budget y
//    contaminaba el reporte de Coverage con cientos de "Crawled - currently
//    not indexed"). Ahora CUALQUIER request a viven.ch (sin www) 301 a
//    www.viven.ch conservando path+query.
// 2) "/" en www: redirige al idioma del visitante EN EL SERVIDOR — antes la
//    raíz era una página puente client-side y se veía un flash antes del
//    redirect (reporte de Sebastián). Preferencia: cookie viven-lang (la
//    setea site.js al navegar) > Accept-Language > EN.
//
// 302+no-store en ambos: nunca cachear (el host/idioma pueden cambiar).
// Todo lo demás va directo a los assets estáticos.
//
// 3) URLs retiradas → 301 a lo que las reemplaza (mapa RETIRED). Se agrega una
//    entrada acá cada vez que se borra una página QUE YA ESTUVO PUBLICADA, para
//    que no quede un 404 ni se pierda lo que haya juntado en buscadores.
//    Con no-store como el resto: si algún día se reusa esa URL, ningún browser
//    se queda pegado con el redirect viejo cacheado.

// Las claves se escriben con el carácter real (á, ü…), no percent-encoded: la
// búsqueda decodifica y normaliza a NFC antes de comparar, así una sola entrada
// cubre las dos codificaciones (%C3%BC y fu%CC%88r) y las dos formas Unicode.
const RETIRED = {
  // 2026-08-03: se generaron dos traducciones ES del mismo artículo y las dos
  // quedaron publicadas. Queda la que traduce fiel el título EN.
  '/es/blog/videos-formacion-corporativa-formatos-efectivos/':
    '/es/blog/videos-capacitacion-corporativa-formatos-efectivos/',

  // 2026-08-04: cinco posts DE tenían la diéresis en el slug. macOS los guardó
  // en forma NFD y el sitemap publicaba la NFC, así que Google recibía 404 y
  // nunca pudo indexarlos (navegando sí se llegaba: el índice usaba la NFD).
  // Pasaron a ASCII — la misma transliteración que esos slugs ya usaban en
  // "staerkere" y "verkuerzen".
  '/de/blog/so-arbeitest-du-mit-deiner-videoagentur-zusammen-für-mehr-umsatz-und-staerkere-kundenbindung/':
    '/de/blog/so-arbeitest-du-mit-deiner-videoagentur-zusammen-fuer-mehr-umsatz-und-staerkere-kundenbindung/',
  '/de/blog/stärke-die-unternehmenskommunikation-mit-corporate-videoproduktion/':
    '/de/blog/staerke-die-unternehmenskommunikation-mit-corporate-videoproduktion/',
  '/de/blog/warum-kunden-testimonial-videos-für-marken-ein-echter-gamechanger-sind/':
    '/de/blog/warum-kunden-testimonial-videos-fuer-marken-ein-echter-gamechanger-sind/',
  '/de/blog/wie-brands-mit-video-fallstudien-neue-kundinnen-überzeugen/':
    '/de/blog/wie-brands-mit-video-fallstudien-neue-kundinnen-ueberzeugen/',
  '/de/blog/wie-produktvideos-den-verkaufsprozess-für-marken-verkuerzen/':
    '/de/blog/wie-produktvideos-den-verkaufsprozess-fuer-marken-verkuerzen/',

  // 2026-08-08: URLs del sitio viejo (HubSpot) que Search Console sigue reportando
  // como 404. Eran las páginas de recursos, que vivían en /{idioma}/{slug} y hoy
  // están en /{idioma}/resources/{slug}/. Cada una va al artículo del MISMO tema;
  // donde el artículo exacto ya no existe, al más cercano de ese idioma.
  // Los `?hsLang=xx` de HubSpot quedan cubiertos solos: la búsqueda usa el pathname.
  '/de/blog/author/sofia-treviño':
    '/de/blog/',
  '/de/warum-sind-testimonial-videos-effektiv':
    '/de/resources/was-ist-die-produktion-von-testimonial-videos/',
  '/de/was-ist-die-videoproduktion-mit-drohnen':
    '/de/resources/warum-sollten-drohnenaufnahmen-in-der-videoproduktion-verwendet-werden/',
  '/de/was-ist-eine-videoproduktion':
    '/de/resources/was-geschieht-bei-der-videoproduktion/',
  '/de/was-sind-die-vorteile-von-live-streaming-veranstaltungen':
    '/de/resources/was-ist-eine-live-video-produktion/',
  '/de/welche-arten-von-animierten-videos-gibt-es':
    '/de/resources/was-ist-die-produktion-von-animierten-videos/',
  '/de/welche-branchen-nutzen-animierte-videos':
    '/de/resources/was-ist-die-produktion-von-animierten-videos/',
  '/de/wie-steigern-marketingvideos-das-engagement':
    '/de/resources/was-ist-videomarketing/',
  '/en/blog/author/sofia-treviño':
    '/en/blog/',
  '/en/what-are-the-stages-of-video-production':
    '/en/resources/video-production-process/',
  '/en/what-is-animated-video-production':
    '/en/resources/what-types-of-animated-videos-are-there/',
  '/en/what-is-video-production':
    '/en/resources/what-is-video-production/',
  '/en/what-should-be-included-in-a-testimonial-video':
    '/en/resources/what-is-testimonial-video-production/',
  '/en/why-are-testimonial-videos-effective':
    '/en/resources/what-is-testimonial-video-production/',
  '/en/why-are-videos-important-for-social-media':
    '/en/resources/what-is-social-media-video-production/',
  '/es/cuales-son-los-beneficios-de-transmitir-eventos-en-vivo':
    '/es/resources/que-es-la-produccion-de-video-en-vivo/',
  '/es/mejore-la-imagen-de-su-empresa-con-contenidos-de-video-basados-en-historias':
    '/es/resources/que-es-la-produccion-de-video-corporativo/',
  '/es/por-que-son-efectivos-los-videos-testimoniales':
    '/es/resources/que-es-la-produccion-de-videos-testimoniales/',
  '/es/que-es-la-edicion-de-video-en-postproduccion':
    '/es/resources/cuales-son-las-etapas-de-la-produccion-de-video/',
  '/es/que-es-la-produccion-de-video-animado':
    '/es/resources/por-que-utilizar-la-animacion-en-la-produccion-de-video/',
  '/es/que-es-la-produccion-de-video-con-drones':
    '/es/resources/por-que-utilizar-imagenes-de-drones-en-la-produccion-de-video/',
  '/es/que-es-la-produccion-de-video-para-eventos':
    '/es/resources/por-que-invertir-en-la-produccion-de-videos-para-eventos/',
  '/es/que-es-la-produccion-de-video-para-redes-sociales':
    '/es/resources/por-que-son-importantes-los-videos-para-las-redes-sociales/',
  '/es/que-es-la-produccion-de-videos-de-marca':
    '/es/resources/como-pueden-los-videos-de-marca-apoyar-el-marketing/',
  '/es/que-es-un-video-promocional':
    '/es/resources/que-hace-que-un-video-promocional-sea-efectivo/',
  '/terms-and-conditions-viven-ag':
    '/en/terms/',
  '/viven/author/sebastian-e-cepeda':
    '/en/blog/',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'viven.ch') {
      url.hostname = 'www.viven.ch';
      return new Response(null, {
        status: 301,
        headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
      });
    }
    let lookup = url.pathname;
    try { lookup = decodeURIComponent(lookup).normalize('NFC'); } catch (_) { /* path mal formado: se compara crudo */ }
    /* Se prueban las dos formas: las URLs del sitio viejo vienen sin barra final
       y las nuestras con ella, y una entrada tiene que servir para las dos. */
    const conBarra = lookup.endsWith('/') ? lookup : lookup + '/';
    const sinBarra = lookup.endsWith('/') ? lookup.slice(0, -1) : lookup;
    const retiredTo = RETIRED[conBarra] || RETIRED[sinBarra];
    if (retiredTo) {
      return new Response(null, {
        status: 301,
        headers: { Location: url.origin + retiredTo + url.search, 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname === '/') {
      const LANGS = ['en', 'de', 'es'];
      let lang = null;
      const cookie = request.headers.get('Cookie') || '';
      const m = cookie.match(/(?:^|;\s*)viven-lang=(\w{2})/);
      if (m && LANGS.includes(m[1])) lang = m[1];
      if (!lang) {
        const al = (request.headers.get('Accept-Language') || '').toLowerCase();
        for (const part of al.split(',')) {
          const code = part.trim().slice(0, 2);
          if (LANGS.includes(code)) { lang = code; break; }
        }
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: url.origin + '/' + (lang || 'en') + '/' + url.search,
          'Cache-Control': 'no-store',
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
