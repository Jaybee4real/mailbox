import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { usingDefaultPassword } from '@/lib/mailbox'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const defaultPassword = account.email ? await usingDefaultPassword(account.email) : false
  return NextResponse.json({ ok: true, ...account, defaultPassword })
}
