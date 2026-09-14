import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { mailAuthGuard } from '@/lib/dev-auth'
import { getInboundAttachments } from '@/lib/mailbox'
import { getObject, putObject } from '@/lib/r2'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Copies the files on a received message into the outgoing space, so they can be
 * forwarded.
 *
 * The send route will only attach keys under `outgoing/`, which is what stops a caller
 * naming any object in the bucket. Rather than widen that, the copy happens here: the
 * key is read from the message itself, never from the request, so the only files that
 * can be copied are the ones actually on a message this caller may read.
 */
export async function POST(req: Request) {
  const guard = await mailAuthGuard(req)
  if (guard) return guard

  let body: { id?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid request.' }, { status: 400 })
  }

  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ ok: false, error: 'Which message?' }, { status: 400 })

  const held = await getInboundAttachments(id).catch(() => [])
  const copied: Array<{ filename: string; size: number; contentType?: string; key: string }> = []

  for (const entry of held) {
    const sourceKey = typeof entry.key === 'string' ? entry.key : ''
    if (!sourceKey) continue

    const object = await getObject(sourceKey)
    if (!object) continue
    const bytes = Buffer.from(await object.arrayBuffer())

    const filename = String(entry.filename ?? 'attachment')
    const safe = filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120)
    const key = `outgoing/${randomBytes(9).toString('hex')}/${safe}`
    const contentType = typeof entry.contentType === 'string' ? entry.contentType : undefined
    if (!(await putObject(key, bytes, contentType))) continue

    copied.push({ filename, size: bytes.length, contentType, key })
  }

  return NextResponse.json({ ok: true, attachments: copied })
}
