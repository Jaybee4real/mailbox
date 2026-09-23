import { createHash, createHmac } from 'node:crypto'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest()

export function sesConfigured(): boolean {
  return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY)
}

export type SesRecipients = { to: string[]; cc?: string[]; bcc?: string[] }

const addressOnly = (entry: string): string => (entry.match(/<([^>]+)>/)?.[1] ?? entry).trim()

/**
 * The envelope, spelled out in full. Once a raw message names any Destination, SES delivers
 * to that list and nothing else — the To and Cc headers inside the MIME are not added to it —
 * so naming only the blind copies sent the message to the blind copies alone. Bcc never goes
 * in the MIME, where every recipient could read it; it lives here and only here.
 */
export function sesDestination(recipients: SesRecipients) {
  const seen = new Set<string>()
  const take = (list: string[] | undefined) =>
    (list ?? []).map(addressOnly).filter(address => {
      const key = address.toLowerCase()
      if (!address || seen.has(key)) return false
      seen.add(key)
      return true
    })
  const to = take(recipients.to)
  const cc = take(recipients.cc)
  const bcc = take(recipients.bcc)
  return {
    ...(to.length ? { ToAddresses: to } : {}),
    ...(cc.length ? { CcAddresses: cc } : {}),
    ...(bcc.length ? { BccAddresses: bcc } : {}),
  }
}

export async function sesSendRaw(
  raw: string,
  region = process.env.AWS_SES_REGION ?? 'eu-north-1',
  recipients: SesRecipients,
): Promise<string | null> {
  const id = process.env.SES_ACCESS_KEY_ID
  const secret = process.env.SES_SECRET_ACCESS_KEY
  if (!id || !secret) throw new Error('SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY must be configured')

  const host = `email.${region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'
  const body = JSON.stringify({
    Content: { Raw: { Data: Buffer.from(raw, 'utf8').toString('base64') } },
    Destination: sesDestination(recipients),
  })
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const stamp = amzDate.slice(0, 8)
  const payloadHash = sha256(body)

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = ['POST', path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${stamp}/${region}/ses/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  let key = hmac(`AWS4${secret}`, stamp)
  for (const part of [region, 'ses', 'aws4_request']) key = hmac(key, part)
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex')

  const response = await fetch(`https://${host}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 200)
    try { detail = (JSON.parse(text) as { message?: string }).message ?? detail } catch {}
    throw new Error(`SES send failed (HTTP ${response.status}): ${detail}`)
  }
  return (JSON.parse(text) as { MessageId?: string }).MessageId ?? null
}
