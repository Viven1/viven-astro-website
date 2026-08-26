/* Service worker del Viven CRM: recibe Web Push, abre el dashboard al tocar,
   y cachea el shell para que la app instale y abra rápido (incluso offline). */
/* OJO: este numero se bumpea EN CADA TANDA DE DEPLOYS del dashboard.
   El aviso "hay una version nueva" del dashboard se dispara con 'controllerchange',
   que solo ocurre si se instala un SW distinto. Si este archivo no cambia, el
   navegador no instala nada, el aviso no aparece nunca y las pestanas abiertas
   (y la app del Dock) siguen corriendo el JS viejo sin sintoma. Paso de verdad el
   12 ago 2026: 8 deploys seguidos y Sebastian veia la version anterior — tocaba
   'Ver / editar lista' y no pasaba nada porque su pagina no tenia el fix. */
var CACHE = 'viven-crm-v79';   // v79: 26 ago 2026 — facturar al cliente desde el proyecto, y las fechas dejan de salir un día antes

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(['/dashboard/']); }).then(function () { return self.skipWaiting(); }));
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
