import { BRAND } from './brand'
import webpush from 'web-push'
import { deletePushSubscription, listPushSubscriptions } from './mailbox'

export type PushPayload = { title: string; body: string; tag?: string; url?: string }

let configured = false
function configure(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return false
  if (!configured) {
    webpush.setVapidDetails(BRAND.vapidSubject, publicKey, privateKey)
    configured = true
  }
  return true
}

/** Pushes to every device the owner has registered; a device the browser has dropped is forgotten. */
export async function sendPush(owner: string, payload: PushPayload): Promise<number> {
  if (!configure()) return 0
  const subscriptions = await listPushSubscriptions(owner)
  let delivered = 0
  await Promise.all(
    subscriptions.map(async subscription => {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 3600 })
        delivered += 1
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) await deletePushSubscription(subscription.endpoint).catch(() => {})
        else console.warn('[push] send failed', status ?? err)
      }
    }),
  )
  return delivered
}
