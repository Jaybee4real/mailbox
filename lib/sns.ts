import { createPublicKey, createVerify } from 'node:crypto'

export type SnsEnvelope = {
  Type: string
  MessageId?: string
  TopicArn?: string
  Subject?: string
  Message?: string
  Timestamp?: string
  Token?: string
  SubscribeURL?: string
  SignatureVersion?: string
  Signature?: string
  SigningCertURL?: string
}

const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
}

/** A certificate from anywhere but AWS proves nothing about who signed the message. */
export function awsSnsUrl(raw: string, suffix: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.pathname.endsWith(suffix) && /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)
  } catch {
    return false
  }
}

const certCache = new Map<string, string>()

async function fetchCert(url: string): Promise<string> {
  const cached = certCache.get(url)
  if (cached) return cached
  const response = await fetch(url)
  if (!response.ok) throw new Error(`certificate fetch failed (${response.status})`)
  const pem = await response.text()
  certCache.set(url, pem)
  return pem
}

/**
 * True only for a message AWS signed for `topicArn`. The topic is not optional: any AWS
 * account can create a topic, subscribe this URL to it and send messages SNS signs
 * perfectly well, so a valid signature alone says nothing about whose topic it came from.
 */
export async function verifySns(envelope: SnsEnvelope, topicArn: string | undefined): Promise<boolean> {
  if (!topicArn || envelope.TopicArn !== topicArn) return false
  if (!envelope.Signature || !envelope.SigningCertURL || !awsSnsUrl(envelope.SigningCertURL, '.pem')) return false
  const fields = SIGNED_FIELDS[envelope.Type]
  if (!fields) return false
  let canonical = ''
  for (const field of fields) {
    const value = (envelope as Record<string, unknown>)[field]
    if (value !== undefined && value !== null) canonical += `${field}\n${String(value)}\n`
  }
  try {
    const verifier = createVerify(envelope.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
    verifier.update(canonical, 'utf8')
    verifier.end()
    return verifier.verify(createPublicKey(await fetchCert(envelope.SigningCertURL)), Buffer.from(envelope.Signature, 'base64'))
  } catch {
    return false
  }
}
