import { NextResponse } from 'next/server'
import { signinOptions } from '@/lib/passkeys'
import { clientKey, rateLimit } from '@/lib/rate-limit'
import { signInBody } from '@/lib/signin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { refused } = await signInBody(req)
  if (refused) return refused
  const limited = rateLimit(clientKey(req, 'passkey-options'), 60, 15 * 60 * 1000)
  if (limited) return limited
  return NextResponse.json({ ok: true, ...(await signinOptions()) }, { headers: { 'Cache-Control': 'no-store' } })
}
