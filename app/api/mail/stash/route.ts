import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { deleteDraftIn, deleteStash, listAccounts, readDraftsFor, readStash, upsertStash } from '@/lib/mailbox'
import { readsAllInboxes } from '@/lib/scope'

export const runtime = 'nodejs'

const KINDS = new Set(['draft', 'template'])

/**
 * The authenticated identity, not the x-dev-email header: once a session cookie can carry
 * the credential, the header is just a caller-supplied string and would let one signed-in
 * accessor read and overwrite another's drafts.
 */
async function ownerOf(req: Request): Promise<string> {
  const account = await resolveAccount(req)
  return account.email || 'local@dev'
}

async function draftMailboxes(req: Request): Promise<{ own: string; openable: string[] }> {
  const account = await resolveAccount(req)
  const own = (account.address || account.email || 'local@dev').toLowerCase()
  if (!readsAllInboxes(account)) return { own, openable: [own] }
  const addresses = (await listAccounts())
    .filter(entry => entry.status === 'active' && entry.address)
    .map(entry => entry.address!.toLowerCase())
  return { own, openable: [...new Set([own, ...addresses])] }
}

function pickMailbox(requested: string | null | undefined, scope: { own: string; openable: string[] }): string | null {
  const wanted = requested?.trim().toLowerCase()
  if (!wanted) return scope.own
  return scope.openable.includes(wanted) ? wanted : null
}

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const params = new URL(req.url).searchParams
  const kind = params.get('kind') ?? ''
  if (!KINDS.has(kind)) return NextResponse.json({ ok: false, error: 'Unknown kind' }, { status: 400 })
  if (kind === 'draft') {
    const scope = await draftMailboxes(req)
    const requested = params.get('mailbox')
    const mailboxes = !requested || requested === 'all' ? scope.openable : [pickMailbox(requested, scope)].filter((entry): entry is string => Boolean(entry))
    return NextResponse.json({ ok: true, items: await readDraftsFor(mailboxes) })
  }
  const items = await readStash(await ownerOf(req), kind)
  return NextResponse.json({ ok: true, items })
}

export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  let body: { kind?: string; id?: string; data?: unknown; mailbox?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.kind || !KINDS.has(body.kind) || !body.id) {
    return NextResponse.json({ ok: false, error: 'kind and id are required' }, { status: 400 })
  }
  if (body.kind === 'draft') {
    const scope = await draftMailboxes(req)
    const mailbox = pickMailbox(body.mailbox, scope)
    if (!mailbox) return NextResponse.json({ ok: false, error: 'You cannot save drafts in that mailbox' }, { status: 403 })
    await deleteDraftIn(scope.openable.filter(entry => entry !== mailbox), body.id)
    await upsertStash(mailbox, 'draft', body.id, body.data ?? null)
    return NextResponse.json({ ok: true, mailbox })
  }
  await upsertStash(await ownerOf(req), body.kind, body.id, body.data ?? null)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const params = new URL(req.url).searchParams
  const kind = params.get('kind') ?? ''
  const id = params.get('id') ?? ''
  if (!KINDS.has(kind) || !id) {
    return NextResponse.json({ ok: false, error: 'kind and id are required' }, { status: 400 })
  }
  if (kind === 'draft') {
    await deleteDraftIn((await draftMailboxes(req)).openable, id)
    return NextResponse.json({ ok: true })
  }
  await deleteStash(await ownerOf(req), kind, id)
  return NextResponse.json({ ok: true })
}
