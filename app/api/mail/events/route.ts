import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { readEvents } from '@/lib/mailbox'
import { readsAllInboxes } from '@/lib/scope'
import { sentOwners } from '@/lib/sent-access'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const account = await resolveAccount(req)
  const events = await readEvents()
  if (readsAllInboxes(account)) return NextResponse.json({ ok: true, events })
  const scope = account.address?.trim().toLowerCase()
  if (!scope) return NextResponse.json({ ok: true, events: [] })
  const owners = await sentOwners(events.map(event => event.emailId))
  return NextResponse.json({ ok: true, events: events.filter(event => owners[event.emailId] === scope) })
}
