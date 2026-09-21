import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent } from '@/lib/mailbox'
import { findMissingReceived, ingestReceived } from '@/lib/receive'

export const runtime = 'nodejs'
export const maxDuration = 300

function authorised(req: Request): boolean {
  const secret = process.env.MAINTENANCE_TOKEN
  if (!secret) return false
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (token.length !== secret.length) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  } catch {
    return false
  }
}

function sinceFrom(req: Request): Date {
  const days = Math.min(Math.max(Number(new URL(req.url).searchParams.get('days') ?? 30) || 30, 1), 90)
  return new Date(Date.now() - days * 86400_000)
}

/** What the provider received for this domain that never reached the mailbox. Read-only. */
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 403 })
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'No provider key' }, { status: 400 })
  const missing = await findMissingReceived(apiKey, sinceFrom(req))
  return NextResponse.json({ ok: true, missing })
}

/**
 * Take in the messages the provider holds and we do not — one by `?id=`, or every one
 * since `?days=`. Each goes through the same path a webhook delivery does, under the same
 * kind of claim, so a delivery arriving at the same moment cannot store a second copy.
 */
export async function POST(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 403 })
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'No provider key' }, { status: 400 })
  const url = new URL(req.url)
  const one = url.searchParams.get('id')
  // Repair works on messages already stored, so the delivery claim is deliberately not
  // consulted: it says "handled", which is exactly the state being corrected.
  const repair = url.searchParams.get('repair') === '1'
  const targets = one ? [one] : (await findMissingReceived(apiKey, sinceFrom(req))).map(item => item.id)

  const taken: Array<{ id: string; owner: string; subject: string }> = []
  const skipped: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of targets) {
    if (!repair) {
      const claim = await claimWebhookEvent(`received:${id}`)
      if (claim !== 'claimed') { skipped.push(id); continue }
    }
    try {
      const result = await ingestReceived(id, {}, repair ? 'repair' : 'store')
      if (!repair) await completeWebhookEvent(`received:${id}`)
      taken.push({ id, owner: result.owner, subject: result.subject })
    } catch (err) {
      if (!repair) await releaseWebhookEvent(`received:${id}`)
      failed.push({ id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return NextResponse.json({ ok: true, repaired: repair, taken, skipped, failed })
}
