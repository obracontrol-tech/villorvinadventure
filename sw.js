// VillorvinAdventure — Service Worker (v1.0)
const CACHE = 'va-v3-6-0';                 // la app (se renueva con cada versión)
const MAPS = 'va-offline-map';           // zonas guardadas por el ciclista (no se borran al actualizar)
const VIEW = 'va-map-view';              // mapa ya visto (se recorta solo)
const LIBS = 'va-libs';                  // librerías externas (mapa, Firebase, letras)
const KEEP = [CACHE, MAPS, VIEW, LIBS];
const CORE = ['./', './index.html', './pro.html', './manifest.json', './va-logo.png', './va-icon.png', './va-icon-192.png'];
const VIEW_MAX = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => !KEEP.includes(n)).map(n => caches.delete(n)))).then(() => self.clients.claim()));
});

let trimming = false;
async function trimView() {
  if (trimming) return; trimming = true;
  try { const c = await caches.open(VIEW); const keys = await c.keys(); if (keys.length > VIEW_MAX) { for (const k of keys.slice(0, keys.length - VIEW_MAX + 500)) await c.delete(k); } }
  finally { trimming = false; }
}
async function fromCaches(req) {
  return (await caches.match(req, { cacheName: MAPS })) || (await caches.match(req, { cacheName: VIEW }));
}
// Mapa: primero lo guardado; si no, red y se guarda en "visto"
async function tileFirst(req) {
  const hit = await fromCaches(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok) { const c = await caches.open(VIEW); c.put(req, r.clone()); if (Math.random() < 0.05) trimView(); }
  return r;
}
// Estilo y TileJSON: red primero (versión nueva del mapa), guardado si no hay conexión
async function netFirstMap(req) {
  try { const r = await fetch(req); if (r.ok) { const c = await caches.open(VIEW); c.put(req, r.clone()); } return r; }
  catch (e) { const hit = await fromCaches(req); if (hit) return hit; throw e; }
}
async function libFirst(req) {
  const hit = await caches.match(req, { cacheName: LIBS });
  if (hit) { fetch(req).then(r => { if (r.ok) caches.open(LIBS).then(c => c.put(req, r)); }).catch(() => {}); return hit; }
  const r = await fetch(req); if (r.ok) { const c = await caches.open(LIBS); c.put(req, r.clone()); } return r;
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname === 'tiles.openfreemap.org') {
    const isData = /\.(pbf|png|jpg|webp|json)$/.test(u.pathname) && !u.pathname.startsWith('/styles/');
    e.respondWith(isData ? tileFirst(req) : netFirstMap(req)); return;
  }
  if (u.hostname === 'server.arcgisonline.com') { e.respondWith(tileFirst(req)); return; }
  if (u.hostname === 'unpkg.com' || (u.hostname === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) || u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(libFirst(req)); return;
  }
  if (u.origin !== location.origin) return;
  // La app: red primero (siempre la última versión); caché si no hay conexión
  e.respondWith(
    // v442: 'no-cache' obliga a pedir siempre la última versión (evita que el móvil muestre una versión vieja)
    fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok && !/[?&](code|state)=/.test(u.search)) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); } return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// Al tocar un aviso: abrir (o traer al frente) VillorvinAdventure
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    let url = (e.notification.data && e.notification.data.url) || './';
    // v3.0: al tocarlo, la app marca el aviso como visto
    const pk = e.notification.data && e.notification.data.p;
    if (pk && /^[A-Za-z0-9_-]{1,100}$/.test(pk)) url += (url.includes('#') ? '&' : '#') + 'p=' + pk;
    try { if (new URL(url, self.location).origin !== self.location.origin) url = './'; } catch (_) { url = './'; }
    for (const c of cs) { if ('focus' in c) { if (url !== './' && 'navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});

// Notificaciones push (Firebase Cloud Messaging): avisos del pelotón con la app cerrada
self.addEventListener('push', e => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; } catch (err) { d = { title: 'VillorvinAdventure', body: e.data ? e.data.text() : '' }; }
  const urgent = d.urgent === '1';
  // v5.14.4: avisos sin emojis (más limpios y algunos relojes no los muestran)
  const noEmo = s => String(s || '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, '').replace(/\s{2,}/g, ' ').trim();
  const title = noEmo(d.title) || 'VillorvinAdventure';
  // v3.0: avisos de la organización → el móvil confirma que le ha llegado (recibo firmado por el servidor)
  const ackP = d.p && d.u && d.s ? fetch('https://villorvinadventure-push.pedrosaborrego.workers.dev', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 'ack', p: d.p, u: d.u, s: d.s }) }).catch(() => {}) : null;
  e.waitUntil(Promise.all([ackP, self.registration.showNotification(title, {
    body: noEmo(d.body),
    icon: 'va-icon-192.png',
    badge: 'va-icon-192.png',
    // v5.13.6: cada aviso urgente es una notificación NUEVA (no actualiza la anterior). Muchos relojes
    // (FitCloudPro y similares) no reenvían las notificaciones que solo se actualizan.
    tag: urgent ? (d.tag || 'villorvin') + '-' + Date.now() : (d.tag || 'villorvin'),
    renotify: true,
    requireInteraction: urgent,
    vibrate: urgent ? [800, 200, 800, 200, 800, 200, 800] : [200, 100, 200],
    data: { url: d.url || './', p: d.p || '' }
  })]));
});
