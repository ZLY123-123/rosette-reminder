let badgeQueue = Promise.resolve();
let lastBadge;

function rememberBadge(badge) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('reminder-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('badge');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('badge', 'readwrite');
      const store = transaction.objectStore('badge');
      const previous = store.get('latest');
      let newest;
      previous.onsuccess = () => {
        newest = previous.result?.revision > badge.revision ? previous.result : badge;
        store.put(newest, 'latest');
      };
      transaction.oncomplete = () => { db.close(); resolve(newest); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  });
}

function applyBadge(badge) {
  if (!Number.isSafeInteger(badge?.count) || badge.count < 0 ||
      !Number.isSafeInteger(badge.revision) || badge.revision < 0) return Promise.resolve();
  badgeQueue = badgeQueue.catch(() => {}).then(async () => {
    const saved = await rememberBadge(badge).catch(() => badge);
    const latest = lastBadge?.revision > saved.revision ? lastBadge : saved;
    if (lastBadge?.revision === latest.revision && lastBadge?.count === latest.count) return;
    if (latest.count > 0) await self.navigator.setAppBadge?.(latest.count);
    else await self.navigator.clearAppBadge?.();
    lastBadge = latest;
  });
  return badgeQueue.catch(() => {});
}

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type === 'badge') event.waitUntil(applyBadge(event.data.badge));
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch {}
  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || 'ROSETTE · 新提醒', {
      body: data.body || '打开工作台查看提醒。',
      tag: data.id || 'reminder-generic', icon: new URL('icon-192.png', self.registration.scope).href, data: { id: data.id }
    }),
    applyBadge(data.badge)
  ]));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  const destination = new URL(self.registration.scope);
  if (typeof id === 'string') destination.hash = 'notice=' + encodeURIComponent(id);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope)) {
        try {
          const navigated = await client.navigate(destination.href);
          if (navigated) return await navigated.focus();
        } catch {}
      }
    }
    return self.clients.openWindow(destination.href);
  })());
});
