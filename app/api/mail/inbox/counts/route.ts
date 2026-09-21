import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { scopeFor } from '@/lib/scope'
import { countFolders, countFoldersCached } from '@/lib/mailbox'

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
  const counts = await cachedCounts(scopeFor(account, new URL(req.url).searchParams.get('mailbox')), fresh)
  return NextResponse.json({ ok: true, counts })
}
