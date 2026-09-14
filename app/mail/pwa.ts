'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

type InstallPrompt = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const standalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true)

const subscribeStandalone = (notify: () => void) => {
  const query = window.matchMedia('(display-mode: standalone)')
  query.addEventListener('change', notify)
  window.addEventListener('appinstalled', notify)
  return () => {
    query.removeEventListener('change', notify)
    window.removeEventListener('appinstalled', notify)
  }
}

const PERMISSION_EVENT = 'mailbox-notification-permission'
const readPermission = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
const subscribePermission = (notify: () => void) => {
  window.addEventListener(PERMISSION_EVENT, notify)
  return () => window.removeEventListener(PERMISSION_EVENT, notify)
}

/**
 * Chrome only fires beforeinstallprompt once per page load and refuses to let it be
 * replayed later, so the event is captured and held rather than requested on click.
 */
export function useInstall() {
  const [deferred, setDeferred] = useState<InstallPrompt | null>(null)
  const [accepted, setAccepted] = useState(false)
  const installed = useSyncExternalStore(subscribeStandalone, standalone, () => false) || accepted

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }

    const onPrompt = (event: Event) => {
      event.preventDefault()
      setDeferred(event as InstallPrompt)
    }
    const onInstalled = () => {
      setAccepted(true)
      setDeferred(null)
    }

    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = useCallback(async () => {
    if (!deferred) return 'unavailable'
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    if (outcome === 'accepted') setAccepted(true)
    setDeferred(null)
    return outcome
  }, [deferred])

  return { canInstall: Boolean(deferred), installed, install }
}

const serverKey = (base64: string): ArrayBuffer => {
  const padded = base64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64.length % 4)) % 4)
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0)).buffer
}

/** Registers this device for pushes to the signed-in mailbox. Harmless to repeat. */
export async function subscribePush(headers: Record<string, string>): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      const keyResponse = await fetch('/api/mail/push', { headers })
      const { publicKey } = (await keyResponse.json()) as { publicKey?: string }
      if (!publicKey) return false
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey(publicKey) })
    }
    const saved = await fetch('/api/mail/push', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    })
    return saved.ok
  } catch {
    return false
  }
}

export async function unsubscribePush(headers: Record<string, string>): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return
    await fetch(`/api/mail/push?endpoint=${encodeURIComponent(subscription.endpoint)}`, { method: 'DELETE', headers })
    await subscription.unsubscribe()
  } catch {
    // Nothing to undo.
  }
}

export function useNotifications(enabled: boolean) {
  const permission = useSyncExternalStore(subscribePermission, readPermission, () => 'default' as const)
  const seen = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  const request = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'unsupported' as const
    const result = await Notification.requestPermission()
    window.dispatchEvent(new Event(PERMISSION_EVENT))
    return result
  }, [])

  /**
   * The first pass only records what is already in the mailbox: without it, opening the
   * app would fire a notification for every unread message sitting there.
   */
  const announce = useCallback(
    (items: Array<{ id: string; from: string; subject: string; read: boolean }>) => {
      if (!primed.current) {
        items.forEach(item => seen.current.add(item.id))
        primed.current = true
        return
      }

      const fresh = items.filter(item => !seen.current.has(item.id))
      fresh.forEach(item => seen.current.add(item.id))

      if (!enabled || permission !== 'granted' || typeof Notification === 'undefined') return
      if (document.visibilityState === 'visible') return

      const unread = fresh.filter(item => !item.read)
      if (unread.length === 0) return

      // An installed PWA on Android refuses `new Notification()` outright — it
      // only allows the service worker to raise one. Prefer the registration and
      // fall back to the constructor on desktop browsers without one.
      const show = async (title: string, options: NotificationOptions) => {
        try {
          const registration = await navigator.serviceWorker?.ready
          if (registration?.showNotification) {
            await registration.showNotification(title, options)
            return
          }
        } catch {
          // Fall through to the constructor.
        }
        try {
          new Notification(title, options)
        } catch {
          // Nothing more to try; a refused notification must not break polling.
        }
      }

      if (unread.length === 1) {
        void show(unread[0].from || 'New mail', {
          body: unread[0].subject || '(no subject)',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: unread[0].id,
        })
        return
      }

      void show(`${unread.length} new messages`, {
        body: unread.map(item => item.subject || '(no subject)').slice(0, 3).join('\n'),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: 'mailbox-batch',
      })
    },
    [enabled, permission],
  )

  return { permission, request, announce }
}
