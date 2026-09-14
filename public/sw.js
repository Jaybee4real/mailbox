self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

// Present but deliberately does not respond: installability needs a fetch handler, and a
// mailbox must never be served from a cache. Every request falls through to the network.
self.addEventListener('fetch', () => {})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const open = clients.find(client => client.url.includes('/mail'))
      if (open) return open.focus()
      return self.clients.openWindow(event.notification.data?.url || '/mail')
    }),
  )
})

// Web Push, sent by the inbound webhook for the mailbox this device registered.
self.addEventListener('push', event => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = { title: 'New mail', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || 'New mail', {
        body: payload.body || '',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: payload.tag || 'mailbox',
        data: { url: payload.url || '/mail' },
      }),
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then(clients => clients.forEach(client => client.postMessage({ type: 'mail:new' }))),
    ]),
  )
})
