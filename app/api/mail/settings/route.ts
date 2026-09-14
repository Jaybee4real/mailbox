import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { getSettings, setSettings } from '@/lib/mailbox'

export const runtime = 'nodejs'

/**
 * The authenticated identity, not the x-dev-email header: once a session cookie can carry
 * the credential, the header is just a caller-supplied string and would let one signed-in
 * accessor read and overwrite another's settings.
 */
async function ownerOf(req: Request): Promise<string> {
  const account = await resolveAccount(req)
  return account.email || 'local@dev'
}

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const settings = await getSettings(await ownerOf(req))
  return NextResponse.json({ ok: true, settings })
}

export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  await setSettings(await ownerOf(req), body)
  return NextResponse.json({ ok: true })
}
