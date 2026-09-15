import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { getSettings, setSettings } from '@/lib/mailbox'

export const runtime = 'nodejs'

/** Not an address anyone can sign in as, so it can never collide with a person's settings. */
const COMPANY = '__company__'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const stored = await getSettings(COMPANY)
  return NextResponse.json({ ok: true, signature: typeof stored.signature === 'string' ? stored.signature : '' })
}

export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  if (account.role !== 'admin') return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
  let body: { signature?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const signature = typeof body.signature === 'string' ? body.signature : ''
  await setSettings(COMPANY, { signature })
  return NextResponse.json({ ok: true })
}
