import { randomUUID } from 'node:crypto'
import { db, ensureMailSchema, recordContact, recordPixel, recordSentMeta, recordSentMessage } from '@/lib/mailbox'
import { sendMail, type SendPayload } from '@/lib/mail-provider'

/**
 * A message written now and carried later. Everything the send needs is prepared before it
 * is parked, so dispatch is only ever "hand this to the provider" — the tracking pixel, the
 * threading headers and the recipient list cannot drift between writing and sending.
 */
export type ScheduledSend = {
  payload: SendPayload
  owner: string
  pixelId: string | null
  subject: string
  from: string
  recipients: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  inReplyTo: string | null
  storedAttachments: Array<{ filename: string; key: string }>
}

export type ScheduledRow = {
  id: string
  owner: string
  sendAfter: string
  status: string
  subject: string
  to: string[]
  createdAt: string
  lastError: string | null
}

const parse = (value: unknown): ScheduledSend | null => {
  try {
    return JSON.parse(String(value)) as ScheduledSend
  } catch {
    return null
  }
}

export async function scheduleSend(owner: string, sendAfter: string, send: ScheduledSend): Promise<string> {
  await ensureMailSchema()
  const id = randomUUID()
  await db()`
    INSERT INTO mail_scheduled (id, owner, send_after, status, payload, created_at)
    VALUES (${id}, ${owner.toLowerCase()}, ${sendAfter}, 'pending', ${JSON.stringify(send)}, ${new Date().toISOString()})`
  return id
}

export async function listScheduled(owner: string | null): Promise<ScheduledRow[]> {
  await ensureMailSchema()
  const sql = db()
  const rows = owner
    ? await sql`SELECT * FROM mail_scheduled WHERE status = 'pending' AND lower(owner) = ${owner.toLowerCase()} ORDER BY send_after`
    : await sql`SELECT * FROM mail_scheduled WHERE status = 'pending' ORDER BY send_after`
  return rows.map(row => {
    const send = parse(row.payload)
    return {
      id: String(row.id),
      owner: String(row.owner),
      sendAfter: String(row.send_after),
      status: String(row.status),
      subject: send?.subject ?? '(no subject)',
      to: send?.recipients ?? [],
      createdAt: String(row.created_at),
      lastError: row.last_error == null ? null : String(row.last_error),
    }
  })
}

/** Cancelling is only ever the owner's to do, and only while it is still waiting. */
export async function cancelScheduled(id: string, owner: string): Promise<boolean> {
  await ensureMailSchema()
  const rows = await db()`
    UPDATE mail_scheduled SET status = 'cancelled'
    WHERE id = ${id} AND lower(owner) = ${owner.toLowerCase()} AND status = 'pending'
    RETURNING id`
  return rows.length > 0
}

/** The bookkeeping an immediate send does, so a delayed one lands in the same places. */
export async function recordSend(send: ScheduledSend, id: string | null): Promise<void> {
  await Promise.all([
    ...[...send.recipients, ...send.cc, ...send.bcc].map(address => recordContact(address, null).catch(() => {})),
    send.pixelId && id
      ? recordPixel(send.pixelId, id, send.recipients[0] ?? '', send.subject).catch(() => {})
      : Promise.resolve(),
    id ? recordSentMeta(id, send.owner, false, send.inReplyTo).catch(() => {}) : Promise.resolve(),
    id
      ? recordSentMessage({
          id,
          from: send.from,
          to: send.recipients,
          cc: send.cc,
          bcc: send.bcc,
          replyTo: send.replyTo,
          subject: send.subject,
          html: send.payload.html ?? null,
          text: send.payload.text ?? null,
          createdAt: new Date().toISOString(),
          attachments: send.storedAttachments,
        }).catch(() => {})
      : Promise.resolve(),
  ])
}

/** Moving the time is only the owner's to do, and only while it is still waiting. */
export async function rescheduleSend(id: string, owner: string, sendAfter: string): Promise<boolean> {
  await ensureMailSchema()
  const rows = await db()`
    UPDATE mail_scheduled SET send_after = ${sendAfter}
    WHERE id = ${id} AND lower(owner) = ${owner.toLowerCase()} AND status = 'pending'
    RETURNING id`
  return rows.length > 0
}

const MAX_ATTEMPTS = 5

/**
 * Hands over every message whose time has come. Each row is claimed with a conditional
 * update before it is sent, so two runners overlapping cannot send the same mail twice.
 */
export async function dispatchDue(limit = 25): Promise<{ due: number; sent: number; failed: number }> {
  await ensureMailSchema()
  const sql = db()
  const now = new Date().toISOString()
  const due = await sql`
    SELECT id, payload, attempts FROM mail_scheduled
    WHERE status = 'pending' AND send_after <= ${now}
    ORDER BY send_after LIMIT ${limit}`

  let sent = 0
  let failed = 0
  for (const row of due) {
    const id = String(row.id)
    const claimed = await sql`
      UPDATE mail_scheduled SET status = 'sending' WHERE id = ${id} AND status = 'pending' RETURNING id`
    if (!claimed.length) continue

    const send = parse(row.payload)
    if (!send) {
      await sql`UPDATE mail_scheduled SET status = 'failed', last_error = 'unreadable payload' WHERE id = ${id}`
      failed += 1
      continue
    }

    try {
      // scheduledAt is deliberately dropped: the wait already happened here.
      const { scheduledAt: _ignored, ...payload } = send.payload
      const result = await sendMail(payload)
      await recordSend(send, result?.id ?? null)
      await sql`
        UPDATE mail_scheduled SET status = 'sent', sent_id = ${result?.id ?? null}, last_error = NULL WHERE id = ${id}`
      sent += 1
    } catch (err) {
      const attempts = Number(row.attempts ?? 0) + 1
      const reason = err instanceof Error ? err.message : String(err)
      await sql`
        UPDATE mail_scheduled
        SET status = ${attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'}, attempts = ${attempts}, last_error = ${reason}
        WHERE id = ${id}`
      failed += 1
    }
  }
  return { due: due.length, sent, failed }
}
