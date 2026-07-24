// Worker mínimo: SOLO intercepta "/" (run_worker_first en wrangler.jsonc) y
// redirige al idioma del visitante EN EL SERVIDOR — antes la raíz era una
// página puente client-side y se veía un flash antes del redirect (reporte
// de Sebastián). Preferencia: cookie viven-lang (la setea site.js al navegar)
// > Accept-Language > EN. 302 + no-store: el idioma puede cambiar, nunca
// cachear el redirect. Todo lo demás va directo a los assets estáticos.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
