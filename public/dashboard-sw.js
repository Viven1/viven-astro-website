/* Service worker del Viven CRM: recibe Web Push, abre el dashboard al tocar,
   y cachea el shell para que la app instale y abra rápido (incluso offline). */
/* OJO: este numero se bumpea EN CADA TANDA DE DEPLOYS del dashboard.
   El aviso "hay una version nueva" del dashboard se dispara con 'controllerchange',
   que solo ocurre si se instala un SW distinto. Si este archivo no cambia, el
   navegador no instala nada, el aviso no aparece nunca y las pestanas abiertas
   (y la app del Dock) siguen corriendo el JS viejo sin sintoma. Paso de verdad el
   12 ago 2026: 8 deploys seguidos y Sebastian veia la version anterior — tocaba
   'Ver / editar lista' y no pasaba nada porque su pagina no tenia el fix. */
var CACHE = 'viven-crm-v180';  // v180: 27 ago 2026 — borrar proyecto, código a cualquier contacto

/* Al instalar se guarda el HTML **y los archivos que ese HTML pide**. Antes solo se
   guardaba '/dashboard/', y el bundle recién entraba a la cache la primera vez que el
   navegador lo pedia con red. O sea: se instalaba la version nueva, `activate` borraba la
   cache anterior, y si el siguiente arranque era sin señal quedaba el HTML sin su
   JavaScript — pantalla en blanco. Justo en el set, que es donde no hay señal y donde
   Sebastian mira el tablero.
   Los nombres llevan hash y cambian en cada deploy, asi que no se pueden poner a mano: se
   lee el HTML y se sacan de ahi. Si algo falla, la instalacion sigue igual — es mejor un
   offline incompleto que un service worker que no instala. */
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return fetch('/dashboard/', { cache: 'reload' }).then(function (res) {
        return c.put('/dashboard/', res.clone()).then(function () { return res.text(); });
      }).then(function (html) {
        var urls = [];
        var re = /(?:src|href)="(\/(?:_astro|assets)\/[^"]+\.(?:js|css|woff2))"/g, m;
        while ((m = re.exec(html))) if (urls.indexOf(m[1]) < 0) urls.push(m[1]);
        return Promise.all(urls.map(function (u) {
          return c.add(u).catch(function () { });   // uno que falle no tira la instalacion
        }));
      });
    }).catch(function () { })
     .then(function () { return self.skipWaiting(); })
  );
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // navegación al dashboard: red primero (siempre fresco), cache si estás offline
  if (e.request.mode === 'navigate' && url.pathname.indexOf('/dashboard') === 0) {
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('/dashboard/', copy); });
      return res;
    }).catch(function () { return caches.match('/dashboard/'); }));
    return;
  }

  /* EL BUNDLE Y EL CSS. Sin esto el SW guardaba el HTML del dashboard y nada más:
     offline abría la página y el <script> de 850 KB no estaba, así que quedaba en
     blanco. Peor que un cartel de "sin conexión", porque parece que la app se rompió.
     Sebastián mira el tablero EN EL SET, donde no hay señal.
     Va red-primero: el bundle cambia en cada deploy y servir uno viejo sería el bug de
     "8 deploys y sigue viendo la versión anterior" que ya pasó el 12 ago. */
  if (/^\/_astro\/.*\.(js|css)$/.test(url.pathname) || url.pathname === '/assets/site.css') {
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () { return caches.match(e.request); }));
    return;
  }

  // iconos/manifest de la app: cache-first
  if (url.pathname.indexOf('/assets/crm-') === 0 || url.pathname === '/dashboard.webmanifest') {
    e.respondWith(caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      });
    }));
  }
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data.json(); } catch (err) { d = { title: 'Viven CRM', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Viven CRM', {
    body: d.body || '',
    icon: '/assets/crm-icon.png',
    badge: '/assets/crm-icon.png',
    data: { url: d.url || '/dashboard/' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/dashboard/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (ws) {
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i];
      if (w.url.indexOf('/dashboard') > -1) {
        // navegar la ventana existente al item (ej. /dashboard/?lead=12) y enfocarla
        if ('navigate' in w) return w.navigate(url).then(function (c) { return (c || w).focus(); }).catch(function () { return w.focus(); });
        if ('focus' in w) return w.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});

