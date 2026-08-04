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

const RETIRED = {
  // 2026-08-03: se generaron dos traducciones ES del mismo artículo y las dos
  // quedaron publicadas. Queda la que traduce fiel el título EN.
  '/es/blog/videos-formacion-corporativa-formatos-efectivos/':
    '/es/blog/videos-capacitacion-corporativa-formatos-efectivos/',
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
    const retiredTo = RETIRED[url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'];
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
