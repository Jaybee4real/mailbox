import { NextResponse } from 'next/server'
import { appendEvent, claimWebhookEvent, completeWebhookEvent, releaseWebhookEvent } from '@/lib/mailbox'
import { awsSnsUrl, verifySns, type SnsEnvelope } from '@/lib/sns'

export const runtime = 'nodejs'

type SesEvent = {
  eventType?: string
  mail?: { messageId?: string; timestamp?: string; destination?: string[]; commonHeaders?: { subject?: string } }
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; bouncedRecipients?: Array<{ emailAddress?: string; diagnosticCode?: string }> }
  complaint?: { timestamp?: string; complaintFeedbackType?: string }
  delivery?: { timestamp?: string }
  deliveryDelay?: { timestamp?: string; delayType?: string }
  reject?: { reason?: string }
  failure?: { errorMessage?: string }
}

// The same names Resend's webhooks use, so the Sent list reads either provider the same way.
const EVENT_TYPES: Record<string, string> = {
  Send: 'email.sent',
  Delivery: 'email.delivered',
  DeliveryDelay: 'email.delivery_delayed',
  Bounce: 'email.bounced',
  Complaint: 'email.complained',
  Reject: 'email.failed',
  RenderingFailure: 'email.failed',
}

/** SES delivery events, fanned out through an SNS topic this deployment pins by ARN. */
export async function POST(req: Request) {
  let envelope: SnsEnvelope
  try {
    envelope = JSON.parse(await req.text()) as SnsEnvelope
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
  }
  if (!(await verifySns(envelope, process.env.MAIL_SES_EVENTS_TOPIC_ARN))) {
    return NextResponse.json({ ok: false, error: 'Unverified' }, { status: 403 })
  }

  if (envelope.Type === 'SubscriptionConfirmation') {
    if (!envelope.SubscribeURL || !awsSnsUrl(envelope.SubscribeURL, '/')) {
      return NextResponse.json({ ok: false, error: 'Unexpected subscribe URL' }, { status: 400 })
    }
    const confirmed = await fetch(envelope.SubscribeURL).then(response => response.ok).catch(() => false)
    return NextResponse.json({ ok: confirmed })
  }
  if (envelope.Type !== 'Notification') return NextResponse.json({ ok: true, ignored: envelope.Type })

  let event: SesEvent
  try {
    event = JSON.parse(envelope.Message ?? '{}') as SesEvent
  } catch {
    return NextResponse.json({ ok: false, error: 'Notification carried no JSON' }, { status: 400 })
  }
  const type = EVENT_TYPES[event.eventType ?? '']
  const emailId = event.mail?.messageId
  if (!type || !emailId) return NextResponse.json({ ok: true, ignored: event.eventType ?? 'unknown' })

  const claimKey = `ses:${envelope.MessageId ?? ''}`
  if ((await claimWebhookEvent(claimKey)) !== 'claimed') return NextResponse.json({ ok: true, duplicate: true })

  const meta: Record<string, string> = {}
  if (event.mail?.commonHeaders?.subject) meta.subject = event.mail.commonHeaders.subject
  if (event.mail?.destination?.length) meta.to = event.mail.destination.join(', ')
  if (event.bounce) {
    meta.bounceType = [event.bounce.bounceType, event.bounce.bounceSubType].filter(Boolean).join(' / ')
    const reasons = (event.bounce.bouncedRecipients ?? [])
      .map(recipient => [recipient.emailAddress, recipient.diagnosticCode].filter(Boolean).join(': '))
      .filter(Boolean)
    if (reasons.length) meta.bounceMessage = reasons.join('; ')
  }
  if (event.complaint?.complaintFeedbackType) meta.complaint = event.complaint.complaintFeedbackType
  if (event.deliveryDelay?.delayType) meta.delayType = event.deliveryDelay.delayType
  if (event.reject?.reason) meta.failReason = event.reject.reason
  if (event.failure?.errorMessage) meta.failReason = event.failure.errorMessage

  const at = event.delivery?.timestamp ?? event.bounce?.timestamp ?? event.complaint?.timestamp
    ?? event.deliveryDelay?.timestamp ?? event.mail?.timestamp ?? new Date().toISOString()
  try {
    await appendEvent({ emailId, type, at, meta: Object.keys(meta).length ? meta : undefined })
  } catch (err) {
    await releaseWebhookEvent(claimKey)
    throw err
  }
  await completeWebhookEvent(claimKey)
  return NextResponse.json({ ok: true })
}
