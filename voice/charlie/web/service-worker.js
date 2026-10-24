/* Charlie Service Worker - PWA离线支持 + 推送通知 */
const CACHE_NAME = 'charlie-v1';
const ASSETS = [
  '/',
  '/voice.html',
  '/manifest.json',
  '/icon.svg',
];

// 安装时缓存核心资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// 激活时清理旧缓存
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
});

// 网络优先，缓存后备
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

// 推送通知
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Charlie', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate: [200, 100, 200],
    })
  );
});
