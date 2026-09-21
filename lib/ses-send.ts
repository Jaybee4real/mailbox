import { createHash, createHmac } from 'node:crypto'

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest()

export function sesConfigured(): boolean {
  return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY)
}

/**
 * `blindCopies` are envelope recipients only. A Bcc header inside the MIME would be handed
 * to everyone the message reaches, so the address is named to SES instead of written down
 * where the recipient can read it.
 */
export async function sesSendRaw(
  raw: string,
  region = process.env.AWS_SES_REGION ?? 'eu-north-1',
  blindCopies: string[] = [],
): Promise<string | null> {
  const id = process.env.SES_ACCESS_KEY_ID
  const secret = process.env.SES_SECRET_ACCESS_KEY
  if (!id || !secret) throw new Error('SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY must be configured')

  const host = `email.${region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'
  const body = JSON.stringify({
    Content: { Raw: { Data: Buffer.from(raw, 'utf8').toString('base64') } },
    ...(blindCopies.length ? { Destination: { BccAddresses: blindCopies } } : {}),
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
