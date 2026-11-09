import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { scopeFor } from '@/lib/scope'
import { countFilteredThreads, countFolders, countFoldersCached, countQuietUnreadMessages, inboxFiltersFor } from '@/lib/mailbox'

/**
 * Counts come from the durable cache, which every write that moves mail clears. An extra
 * in-process copy used to sit in front of it, and nothing could reach in to drop it: a
 * delete cleared the shared row and this map went on answering with figures from before
 * it for another twenty seconds, per running instance.
 */
async function cachedCounts(owner: string | null, fresh: boolean) {
  return fresh ? countFolders(owner ?? undefined) : countFoldersCached(owner)
}

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  // Counts describe the signed-in mailbox, matching what the list will actually show.
  const account = await resolveAccount(req)
  const fresh = new URL(req.url).searchParams.get('fresh') === '1'
  const owner = scopeFor(account, new URL(req.url).searchParams.get('mailbox'))
  const filters = await inboxFiltersFor(account.email || 'local@dev')
  const [counts, filtered, quietMessages] = await Promise.all([
    cachedCounts(owner, fresh),
    countFilteredThreads(owner, filters),
    countQuietUnreadMessages(owner, filters),
  ])
  // The cache is per mailbox and the rules are per person, so the rules come off afterwards.
  // Mail an advanced rule holds out never counts as unread in the Inbox (the sidebar badge
  // included), so a mailbox full of DMARC reports does not read as forty-five unread.
  const conversations = counts.conversations && {
    ...counts.conversations,
    inbox: Math.max(0, counts.conversations.inbox - filtered.total),
    unread: Math.max(0, counts.conversations.unread - filtered.unread - filtered.quietUnread),
  }
  return NextResponse.json({
    ok: true,
    counts: { ...counts, unread: Math.max(0, counts.unread - quietMessages), conversations, filtered },
  })
}
