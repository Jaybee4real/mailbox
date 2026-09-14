import { NextResponse } from 'next/server'
import { mailAuthGuard, resolveAccount } from '@/lib/dev-auth'
import { deleteStash, readStash, upsertStash } from '@/lib/mailbox'

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

export async function GET(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  const kind = new URL(req.url).searchParams.get('kind') ?? ''
  if (!KINDS.has(kind)) return NextResponse.json({ ok: false, error: 'Unknown kind' }, { status: 400 })
  const items = await readStash(await ownerOf(req), kind)
  return NextResponse.json({ ok: true, items })
}

export async function PUT(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard
  let body: { kind?: string; id?: string; data?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.kind || !KINDS.has(body.kind) || !body.id) {
    return NextResponse.json({ ok: false, error: 'kind and id are required' }, { status: 400 })
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
  await deleteStash(await ownerOf(req), kind, id)
  return NextResponse.json({ ok: true })
}
