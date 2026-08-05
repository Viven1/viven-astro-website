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
    const retiredTo = RETIRED[lookup.endsWith('/') ? lookup : lookup + '/'];
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
