/**
 * R2 over the S3 API, signed with SigV4 by hand.
 *
 * No SDK: @aws-sdk/client-s3 is megabytes for the three operations this needs, and
 * every dependency here is one more thing to vet. Node's crypto already has
 * everything SigV4 wants.
 *
 * Objects are written private. A recipient never touches the bucket directly —
 * they come through the app, which checks the password and then hands out a
 * presigned URL that expires. A world-readable bucket with a password page in
 * front of it protects nothing, because the object URL is the whole secret.
 */

import { createHash, createHmac } from 'node:crypto'

const SERVICE = 's3'
// R2 ignores the region but SigV4 requires one in the scope; AWS S3 needs the real one.
const REGION = process.env.R2_REGION ?? process.env.S3_REGION ?? 'auto'

type Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }

function config(): Config {
  const endpoint = process.env.R2_S3_ENDPOINT
  const bucket = process.env.R2_BUCKET
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('R2_S3_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be configured')
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), bucket, accessKeyId, secretAccessKey }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest()

/** Each path segment is encoded, but the slashes between them are not. */
function encodeKey(key: string): string {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function signingKey(secret: string, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), REGION), SERVICE), 'aws4_request')
}

/**
 * A URL that carries its own authorisation and stops working when it expires.
 * `method` is PUT for an upload, GET for a download.
 */
export function presign(
  key: string,
  method: 'PUT' | 'GET' | 'DELETE',
  expiresInSeconds = 900,
  extraQuery: Record<string, string> = {},
): string {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = config()
  const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`)

  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.min(Math.max(expiresInSeconds, 1), 604800)),
    'X-Amz-SignedHeaders': 'host',
    ...extraQuery,
  }

  // SigV4 requires the query sorted by key, with both halves percent-encoded.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(name => `${encodeURIComponent(name)}=${encodeURIComponent(query[name])}`)
    .join('&')

  const canonicalRequest = [
    method,
    `/${bucket}/${encodeKey(key)}`,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join('\n')

  const signature = createHmac('sha256', signingKey(secretAccessKey, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex')

  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** Deletes an object. Used when an upload is abandoned or a share is revoked. */
export async function deleteObject(key: string): Promise<boolean> {
  // The method is signed, so the URL must be presigned for DELETE itself.
  const response = await fetch(presign(key, 'DELETE', 60), { method: 'DELETE' }).catch(() => null)
  return Boolean(response?.ok)
}

/**
 * Whether the object is actually in the bucket. A share row can outlive its object:
 * an upload that failed after the record was written, or a key removed from the
 * bucket directly. Without this the recipient is redirected to R2 and reads a raw
 * NoSuchKey XML document, which tells them nothing and looks broken.
 */
export async function objectExists(key: string): Promise<boolean> {
  // A ranged GET rather than a HEAD: the method is part of the signature, so a
  // URL signed for GET is refused when sent as HEAD. One byte is enough to tell
  // a present object (206) from an absent one (404).
  const response = await fetch(presign(key, 'GET', 60), {
    headers: { range: 'bytes=0-0' },
  }).catch(() => null)
  return response?.status === 206 || response?.status === 200
}

/** Writes bytes to the bucket. Returns false rather than throwing so one failed file cannot lose a message. */
export async function putObject(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<boolean> {
  let reason = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(presign(key, 'PUT', 900), {
        method: 'PUT',
        headers: contentType ? { 'content-type': contentType } : {},
        body: body as BodyInit,
      })
      if (response.ok) return true
      reason = `HTTP ${response.status}`
      if (response.status < 500) break
    } catch (err) {
      reason = String((err as { cause?: unknown })?.cause ?? err)
    }
  }
  console.warn(`[r2] put failed for ${key}: ${reason}`)
  return false
}

/** Streams an object back out, for serving through our own domain instead of a bucket URL. */
export async function getObject(key: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(presign(key, 'GET', 300))
      if (response.ok) return response
      if (response.status < 500) return null
    } catch (err) {
      if (attempt) console.warn(`[r2] get failed for ${key}: ${String((err as { cause?: unknown })?.cause ?? err)}`)
    }
  }
  return null
}
