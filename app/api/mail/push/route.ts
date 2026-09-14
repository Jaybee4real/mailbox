import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { deletePushSubscription, savePushSubscription, type PushSubscriptionRow } from '@/lib/mailbox'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  return NextResponse.json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY ?? null })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const owner = account.address ?? account.email
  if (!owner) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Partial<PushSubscriptionRow>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
  const p256dh = typeof body.keys?.p256dh === 'string' ? body.keys.p256dh : ''
  const auth = typeof body.keys?.auth === 'string' ? body.keys.auth : ''
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
    return NextResponse.json({ ok: false, error: 'That is not a push subscription.' }, { status: 400 })
  }
  await savePushSubscription(owner, { endpoint, keys: { p256dh, auth } })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const endpoint = new URL(req.url).searchParams.get('endpoint') ?? ''
  if (endpoint) await deletePushSubscription(endpoint)
  return NextResponse.json({ ok: true })
}
