import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { readMobileSession } from '@/lib/mobile-session'
import { sendNativePush } from '@/lib/push'
export const runtime = 'nodejs'
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const session = await readMobileSession(req)
  if (!session) return NextResponse.json({ ok: false, error: 'Sign in from Vela Mail.' }, { status: 400 })
  const delivered = await sendNativePush(account.email, { title: 'Notifications work', body: 'New mail will show up like this.' }, String(session.id))
  if (!delivered) return NextResponse.json({ ok: false, error: process.env.VELA_FIREBASE_SERVICE_ACCOUNT ? 'This device is not registered for notifications. Turn them on again.' : 'Push is not set up on this mailbox yet.' }, { status: 409 })
  return NextResponse.json({ ok: true, delivered })
}
