import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30
const DIGITS = 6

export const CHALLENGE_TTL_MS = 10 * 60 * 1000
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000
export const EMAIL_RESEND_MS = 60 * 1000
export const MAX_CODE_ATTEMPTS = 5

export type SecondFactor = 'authenticator' | 'email'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(randomBytes(20))

/** RFC 6238 with the parameters every authenticator app assumes: SHA-1, 30 seconds, six digits. */
export function totpAt(secret: string, timeMs: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / STEP_SECONDS)))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 15
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return String(number).padStart(DIGITS, '0')
}

const sameCode = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right))

/** One step either side, for a phone clock that has drifted or a code typed as it rolled over. */
export function verifyTotp(secret: string, code: string, nowMs = Date.now()): boolean {
  const typed = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(typed) || !secret) return false
  return [-1, 0, 1].some(step => sameCode(totpAt(secret, nowMs + step * STEP_SECONDS * 1000), typed))
}

export function otpauthUri(account: string, issuer: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}

export const newEmailCode = () => String(randomInt(0, 10 ** DIGITS)).padStart(DIGITS, '0')

/** Bound to the challenge, so a code read from one sign-in cannot finish another. */
export const hashEmailCode = (challengeId: string, code: string) =>
  createHash('sha256').update(`${challengeId}:${code.replace(/\s+/g, '')}`).digest('hex')

export const newChallengeId = () => randomBytes(24).toString('base64url')

/** k•••@gmail.com — enough to recognise, not enough to learn the address from. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split('@')
  if (!domain) return address
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`
}

/** A readable name for the device a sign-in came from. */
export function describeDevice(userAgent: string): string {
  const agent = userAgent || ''
  const browser =
    /Edg\//.test(agent) ? 'Edge'
    : /OPR\/|Opera/.test(agent) ? 'Opera'
    : /Firefox\//.test(agent) ? 'Firefox'
    : /Chrome\//.test(agent) ? 'Chrome'
    : /Safari\//.test(agent) ? 'Safari'
    : /curl|python|node|axios|Go-http/i.test(agent) ? 'Script'
    : 'Browser'
  const system =
    /iPhone|iPad/.test(agent) ? 'iOS'
    : /Android/.test(agent) ? 'Android'
    : /Mac OS X|Macintosh/.test(agent) ? 'macOS'
    : /Windows/.test(agent) ? 'Windows'
    : /Linux/.test(agent) ? 'Linux'
    : ''
  return system ? `${browser} on ${system}` : browser
}
