import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export const PIN_PATTERN = /^\d{6}$/
export const PIN_MAX_ATTEMPTS = 5

function pepper(): string {
  const secret = process.env.MAIL_SESSION_SECRET?.trim()
  if (!secret) throw new Error('MAIL_SESSION_SECRET is not set')
  return secret
}

export function hashPin(pin: string, salt = randomBytes(16).toString('hex')): string {
  const keyed = createHmac('sha256', `pin:${pepper()}`).update(pin).digest()
  const hash = scryptSync(keyed, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  const [scheme, salt, hash] = String(stored ?? '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash || !PIN_PATTERN.test(pin)) return false
  const candidate = Buffer.from(hashPin(pin, salt).split('$')[2], 'hex')
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}
