import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { listAccounts } from '@/lib/mailbox'
import { readsAllInboxes } from '@/lib/scope'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)

  if (!readsAllInboxes(account)) {
    const address = account.address
    return NextResponse.json({
      ok: true,
      all: false,
      mailboxes: address ? [{ address, name: account.name ?? address }] : [],
    })
  }

  const accounts = await listAccounts()
  const mailboxes = accounts
    .filter(entry => entry.address && entry.status === 'active')
    .map(entry => ({ address: entry.address as string, name: entry.name || entry.email }))
  return NextResponse.json({ ok: true, all: true, mailboxes })
}
