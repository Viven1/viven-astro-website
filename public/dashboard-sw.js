/* Service worker del Viven CRM: recibe Web Push y abre el dashboard al tocar. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

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
      if (ws[i].url.indexOf('/dashboard') > -1 && 'focus' in ws[i]) return ws[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
