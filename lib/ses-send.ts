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

/** A signed call to the SES v2 API; the path arrives URI-encoded and is encoded again to sign, as AWS requires. */
export async function sesRequest(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  payload?: unknown,
  region = process.env.AWS_SES_REGION ?? 'eu-north-1',
): Promise<{ status: number; text: string }> {
  const id = process.env.SES_ACCESS_KEY_ID
  const secret = process.env.SES_SECRET_ACCESS_KEY
  if (!id || !secret) throw new Error('SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY must be configured')

  const host = `email.${region}.amazonaws.com`
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const stamp = amzDate.slice(0, 8)
  const payloadHash = sha256(body)

  const [pathname, query = ''] = path.split('?')
  const canonicalPath = pathname.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const canonicalQuery = query
    .split('&')
    .filter(Boolean)
    .map(pair => pair.split('=').map(part => encodeURIComponent(decodeURIComponent(part))).join('='))
    .sort()
    .join('&')
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${stamp}/${region}/ses/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

  let key = hmac(`AWS4${secret}`, stamp)
  for (const part of [region, 'ses', 'aws4_request']) key = hmac(key, part)
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex')

  const response = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    ...(body ? { body } : {}),
  })
  return { status: response.status, text: await response.text() }
}

const sesMessage = (text: string) => {
  try {
    const parsed = JSON.parse(text) as { message?: string; Message?: string }
    return parsed.message ?? parsed.Message ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}

export async function sesSendRaw(
  raw: string,
  region = process.env.AWS_SES_REGION ?? 'eu-north-1',
  recipients: SesRecipients,
): Promise<string | null> {
  const { status, text } = await sesRequest('POST', '/v2/email/outbound-emails', {
    Content: { Raw: { Data: Buffer.from(raw, 'utf8').toString('base64') } },
    Destination: sesDestination(recipients),
  }, region)
  if (status >= 300) throw new Error(`SES send failed (HTTP ${status}): ${sesMessage(text)}`)
  return (JSON.parse(text) as { MessageId?: string }).MessageId ?? null
}

/** Lifts SES's own account-wide block, which otherwise keeps dropping mail an admin unblocked here. */
export async function sesUnsuppress(address: string): Promise<void> {
  const { status, text } = await sesRequest('DELETE', `/v2/email/suppression/addresses/${encodeURIComponent(address)}`)
  if (status >= 300 && status !== 404) throw new Error(`SES kept the address blocked (HTTP ${status}): ${sesMessage(text)}`)
}

/** Every address on SES's account-wide suppression list. */
export async function sesSuppressed(): Promise<Array<{ address: string; reason: string; at: string }>> {
  const found: Array<{ address: string; reason: string; at: string }> = []
  let token = ''
  do {
    const { status, text } = await sesRequest('GET', `/v2/email/suppression/addresses${token ? `?NextToken=${encodeURIComponent(token)}` : ''}`)
    if (status >= 300) throw new Error(`SES suppression list unreadable (HTTP ${status}): ${sesMessage(text)}`)
    const page = JSON.parse(text) as { SuppressedDestinationSummaries?: Array<{ EmailAddress: string; Reason: string; LastUpdateTime: number | string }>; NextToken?: string }
    for (const entry of page.SuppressedDestinationSummaries ?? []) {
      const seconds = Number(entry.LastUpdateTime)
      found.push({ address: entry.EmailAddress, reason: entry.Reason, at: new Date(Number.isFinite(seconds) ? seconds * 1000 : String(entry.LastUpdateTime)).toISOString() })
    }
    token = page.NextToken ?? ''
  } while (token)
  return found
}
