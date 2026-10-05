import { BRAND } from './brand'
import webpush from 'web-push'
import { deletePushSubscription, listPushSubscriptions } from './mailbox'
import { mobilePushRecipients, setMobilePush } from './mobile-session'
import { sendFcm } from './fcm'

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
  const nativeCount = await sendNativePush(owner, payload).catch(() => 0)
  if (!configure()) return nativeCount
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
  return delivered + nativeCount
}

async function sendNativePush(owner: string, payload: PushPayload): Promise<number> {
  const devices = await mobilePushRecipients(owner)
  if (!devices.length) return 0
  let delivered = 0
  for (let offset = 0; offset < devices.length; offset += 10) {
    await Promise.all(devices.slice(offset, offset + 10).map(async device => {
      const result = await sendFcm(String(device.push_token), {
        title: device.previews ? payload.title : `${BRAND.name} Mail`,
        body: device.previews ? payload.body : 'You have new mail.',
      }, { domain: BRAND.domain, email: owner, url: payload.url ?? '/mail' }).catch(() => 'failed')
      if (result === 'sent') delivered += 1
      if (result === 'unregistered') await setMobilePush(owner, String(device.id), null)
    }))
  }
  return delivered
}
