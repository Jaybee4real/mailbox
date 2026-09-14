import { brandSlug } from './brand'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

// promisify picks the 3-arg overload; this deployment passes scrypt options too.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number },
) => Promise<Buffer>

const KEY_LENGTH = 64
const COST = 16384

/**
 * Stored form is `scrypt$<cost>$<salt-hex>$<key-hex>`. Anything else is read as one of the
 * bare SHA-256 digests this app wrote before, so existing passwords keep working and get
 * rewritten to scrypt the next time their owner successfully signs in.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(plain, salt, KEY_LENGTH, { N: COST })
  return `scrypt$${COST}$${salt.toString('hex')}$${key.toString('hex')}`
}

export function isLegacyHash(stored: string): boolean {
  return /^[a-f0-9]{64}$/i.test(stored)
}

function equals(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false

  if (isLegacyHash(stored)) {
    const digest = createHash('sha256').update(plain).digest()
    return equals(digest, Buffer.from(stored, 'hex'))
  }

  const [scheme, cost, salt, key] = stored.split('$')
  if (scheme !== 'scrypt' || !cost || !salt || !key) return false

  try {
    const derived = (await scryptAsync(plain, Buffer.from(salt, 'hex'), KEY_LENGTH, {
      N: Number(cost),
    }))
    return equals(derived, Buffer.from(key, 'hex'))
  } catch {
    return false
  }
}

/** Rejects the passwords an attacker tries first, without imposing character-class theatre. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters'
  if (password.length > 200) return 'Password must be under 200 characters'

  const lowered = password.toLowerCase()
  const localPart = email.trim().toLowerCase().split('@')[0]
  if (lowered === email.trim().toLowerCase()) return 'Password cannot be your email address'
  if (localPart && lowered.includes(localPart)) return 'Password cannot contain your address'
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character'

  const WEAK = ['password', '12345678', 'qwerty', 'letmein', 'changeme', brandSlug]
  if (WEAK.some(entry => lowered.includes(entry))) return 'Password is too easy to guess'

  return null
}
