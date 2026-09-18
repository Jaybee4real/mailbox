import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { createResetToken, getAccount } from '@/lib/mailbox'
import { publicOrigin } from '@/lib/public-url'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

const RESET_TTL_MS = 30 * 60 * 1000

/**
 * The way out of the loop for somebody with no recovery address: an admin, who can already
 * read every mailbox here, mints the link and hands it over. Nothing is emailed — the point
 * is that this person cannot receive email.
 */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const actor = await resolveAccount(req)
  if (actor.role !== 'admin') {
    return NextResponse.json({ ok: false, error: 'Admin access required' }, { status: 403 })
  }
  const limited = rateLimit(clientKey(req, 'reset-link'), 20, 60 * 60 * 1000)
  if (limited) return limited

  let body: { email?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const account = email ? await getAccount(email) : null
  if (!account) return NextResponse.json({ ok: false, error: 'No such account' }, { status: 404 })

  const token = randomBytes(32).toString('hex')
  await createResetToken(email, token, Date.now() + RESET_TTL_MS)
  return NextResponse.json({
    ok: true,
    email,
    url: `${publicOrigin(req)}/mail/reset?token=${token}`,
    expiresInMinutes: RESET_TTL_MS / 60000,
  })
}
