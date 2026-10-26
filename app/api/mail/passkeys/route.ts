import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { getAccount } from '@/lib/mailbox'
import { completeRegistration, listPasskeys, removePasskey } from '@/lib/passkeys'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { signInBody } from '@/lib/signin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status })

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const stored = account.email ? await getAccount(account.email) : null
  return NextResponse.json({ ok: true, passkeys: await listPasskeys(account.email), needsPassword: Boolean(stored?.hasPassword) },
    { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const limited = rateLimit(clientKey(req, 'passkey-add'), 20, 15 * 60 * 1000)
  if (limited) return limited
  const account = await resolveAccount(req)
  if (!account.email) return fail('Not signed in.', 401)
  const passkey = await completeRegistration(account.email, body?.challenge, body?.response, body?.name)
  if (!passkey) return fail('That passkey could not be added. Try again.')
  return NextResponse.json({ ok: true, passkey })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const { body, refused } = await signInBody(req)
  if (refused) return refused
  const account = await resolveAccount(req)
  const id = typeof body?.id === 'string' ? body.id : new URL(req.url).searchParams.get('id') ?? ''
  if (!account.email || !id) return fail('Choose a passkey to remove.')
  if (!(await removePasskey(account.email, id))) return fail('That passkey was already removed.', 404)
  return NextResponse.json({ ok: true })
}
