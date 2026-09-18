import { NextResponse } from 'next/server'
import { consumeToken, getAccount, markRecoveryVerified } from '@/lib/mailbox'
import { publicOrigin } from '@/lib/public-url'
import { clientKey, rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Opened from the recovery inbox itself, so proving the address is the whole point and no
 * session is required. It only flips a flag: the token cannot set a password.
 */
export async function GET(req: Request) {
  const limited = rateLimit(clientKey(req, 'verify-recovery'), 20, 15 * 60 * 1000)
  if (limited) return limited

  const token = new URL(req.url).searchParams.get('token')?.trim() ?? ''
  const home = `${publicOrigin(req)}/mail`
  if (!token) return NextResponse.redirect(`${home}?recovery=invalid`, 303)

  const email = await consumeToken(token, 'verify-recovery')
  if (!email) return NextResponse.redirect(`${home}?recovery=invalid`, 303)

  const account = await getAccount(email)
  if (!account?.recoveryEmail) return NextResponse.redirect(`${home}?recovery=invalid`, 303)

  const done = await markRecoveryVerified(email, account.recoveryEmail)
  return NextResponse.redirect(`${home}?recovery=${done ? 'verified' : 'invalid'}`, 303)
}
