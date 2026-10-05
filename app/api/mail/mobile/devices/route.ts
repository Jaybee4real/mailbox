import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { mobileDevices, readMobileSession, revokeMobileDevice, setMobilePush } from '@/lib/mobile-session'
export const runtime = 'nodejs'
export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  return NextResponse.json({ ok: true, devices: await mobileDevices(account.email), currentId: (await readMobileSession(req))?.id })
}
export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ ok: false, error: 'A device is required.' }, { status: 400 })
  await revokeMobileDevice(account.email, id)
  return NextResponse.json({ ok: true })
}
export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const session = await readMobileSession(req)
  if (!session) return NextResponse.json({ ok: false, error: 'Sign in from Vela Mail.' }, { status: 400 })
  let body: { token?: string | null; previews?: boolean; provider?: string }
  try { body = await req.json() } catch { return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 }) }
  if (body.token && (body.provider !== 'fcm' || !/^[\w:-]{20,4096}$/.test(body.token))) return NextResponse.json({ ok: false, error: 'Invalid FCM token.' }, { status: 400 })
  await setMobilePush(account.email, session.id, body.token ?? null, body.previews === true)
  return NextResponse.json({ ok: true })
}
