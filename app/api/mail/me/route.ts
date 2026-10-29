import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { usingDefaultPassword } from '@/lib/mailbox'
import { listPasskeys } from '@/lib/passkeys'
import { BRAND } from '@/lib/brand'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const defaultPassword = account.email ? await usingDefaultPassword(account.email) : false
  const passkeys = account.email ? await listPasskeys(account.email).then(list => list.length, () => null) : null
  return NextResponse.json({ ok: true, ...account, defaultPassword, passkeys, trackOpens: BRAND.trackOpensDefault })
}
