import { createHash, randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { BRAND } from './brand'
import { tursoQuery } from './turso'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const MAX_NAME_LENGTH = 60
const MAX_PASSKEYS = 20

export const VELA_IOS_APP_IDS = (process.env.VELA_IOS_APP_IDS ?? '4243C6RH8A.africa.novacraft.velamail')
  .split(',').map(value => value.trim()).filter(Boolean)
export const VELA_ANDROID_PACKAGE = process.env.VELA_ANDROID_PACKAGE?.trim() || 'africa.novacraft.velamail'
// The Play app-signing key and the private upload key. The debug keystore is public, so it is never trusted here.
export const VELA_ANDROID_CERTS = (process.env.VELA_ANDROID_CERT_SHA256
  ?? 'AC:EF:96:D7:AD:40:9A:9C:37:9C:A9:DA:93:C4:81:82:BA:DE:26:78:6E:D5:9D:B9:BB:78:2B:6F:78:BD:47:B8,6B:11:8D:FD:5A:4E:66:34:92:DD:DA:9C:5F:03:1B:5B:E7:4B:96:EF:12:54:7C:8E:1D:52:D0:8C:0B:D9:74:FC')
  .split(',').map(value => value.trim().toUpperCase()).filter(value => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value))

export function relyingParty(publicUrl = BRAND.publicUrl, androidCerts = VELA_ANDROID_CERTS) {
  const url = new URL(publicUrl)
  return {
    id: url.hostname,
    origins: [url.origin, ...androidCerts.map(androidOrigin)],
  }
}

export function androidOrigin(fingerprint: string): string {
  return `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ''), 'hex').toString('base64url')}`
}

export function userHandle(email: string): Uint8Array<ArrayBuffer> {
  const bytes = createHash('sha256').update(`vela-passkey:${email.trim().toLowerCase()}`).digest()
  return new Uint8Array(bytes)
}

let schema: Promise<unknown> | undefined
async function ready() {
  schema ??= tursoQuery(`CREATE TABLE IF NOT EXISTS mail_passkeys (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT, device_type TEXT, backed_up INTEGER NOT NULL DEFAULT 0, aaguid TEXT,
    name TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
  )`)
    .then(() => tursoQuery('CREATE INDEX IF NOT EXISTS mail_passkeys_email ON mail_passkeys (email)'))
    .then(() => tursoQuery(`CREATE TABLE IF NOT EXISTS mail_passkey_challenges (
      id TEXT PRIMARY KEY, email TEXT, purpose TEXT NOT NULL, challenge TEXT NOT NULL, expires_at INTEGER NOT NULL
    )`))
    .catch(error => { schema = undefined; throw error })
  await schema
}

type Purpose = 'register' | 'signin'

async function storeChallenge(purpose: Purpose, challenge: string, email: string | null): Promise<string> {
  await ready()
  const id = randomBytes(18).toString('base64url')
  await tursoQuery('DELETE FROM mail_passkey_challenges WHERE expires_at <= ?', [Date.now()])
  await tursoQuery('INSERT INTO mail_passkey_challenges (id, email, purpose, challenge, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, email, purpose, challenge, Date.now() + CHALLENGE_TTL_MS])
  return id
}

async function takeChallenge(id: unknown, purpose: Purpose): Promise<{ email: string | null; challenge: string } | null> {
  if (typeof id !== 'string' || !/^[\w-]{24}$/.test(id)) return null
  await ready()
  const rows = await tursoQuery('DELETE FROM mail_passkey_challenges WHERE id = ? AND purpose = ? RETURNING email, challenge, expires_at', [id, purpose])
  const row = rows[0]
  if (!row || Number(row.expires_at) <= Date.now()) return null
  return { email: row.email == null ? null : String(row.email), challenge: String(row.challenge) }
}

export type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; synced: boolean }

export async function listPasskeys(email: string): Promise<Passkey[]> {
  await ready()
  const rows = await tursoQuery('SELECT id, name, created_at, last_used_at, backed_up FROM mail_passkeys WHERE email = ? ORDER BY created_at DESC', [email.toLowerCase()])
  return rows.map(row => ({
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastUsedAt: row.last_used_at == null ? null : String(row.last_used_at),
    synced: Number(row.backed_up) === 1,
  }))
}

export async function removePasskey(email: string, id: string): Promise<boolean> {
  await ready()
  const rows = await tursoQuery('DELETE FROM mail_passkeys WHERE email = ? AND id = ? RETURNING id', [email.toLowerCase(), id])
  return rows.length > 0
}

export async function removeAllPasskeys(email: string): Promise<void> {
  await ready()
  await tursoQuery('DELETE FROM mail_passkeys WHERE email = ?', [email.toLowerCase()])
}

export async function registrationOptions(account: { email: string; address: string | null; name: string | null }) {
  await ready()
  const email = account.email.toLowerCase()
  const existing = await tursoQuery('SELECT id, transports FROM mail_passkeys WHERE email = ?', [email])
  if (existing.length >= MAX_PASSKEYS) return null
  const rp = relyingParty()
  const options = await generateRegistrationOptions({
    rpName: BRAND.name,
    rpID: rp.id,
    userName: account.address ?? email,
    userDisplayName: account.name || account.address || email,
    userID: userHandle(email),
    attestationType: 'none',
    excludeCredentials: existing.map(row => ({ id: String(row.id), transports: parseTransports(row.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  return { challenge: await storeChallenge('register', options.challenge, email), options }
}

export async function completeRegistration(email: string, challengeId: unknown, response: unknown, name: unknown): Promise<Passkey | null> {
  const stored = await takeChallenge(challengeId, 'register')
  if (!stored || stored.email !== email.toLowerCase() || !isResponse(response)) return null
  const rp = relyingParty()
  const result = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: stored.challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    requireUserVerification: true,
  }).catch(() => null)
  if (!result?.verified || !result.registrationInfo) return null
  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = result.registrationInfo
  const label = cleanName(name) || 'Passkey'
  const now = new Date().toISOString()
  await tursoQuery(`INSERT INTO mail_passkeys (id, email, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, [
    credential.id, email.toLowerCase(), Buffer.from(credential.publicKey).toString('base64url'), credential.counter,
    JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0, aaguid, label, now,
  ])
  return { id: credential.id, name: label, createdAt: now, lastUsedAt: null, synced: credentialBackedUp }
}

export async function signinOptions() {
  const options = await generateAuthenticationOptions({ rpID: relyingParty().id, userVerification: 'required', allowCredentials: [] })
  return { challenge: await storeChallenge('signin', options.challenge, null), options }
}

export async function completeSignin(challengeId: unknown, response: unknown): Promise<string | null> {
  const stored = await takeChallenge(challengeId, 'signin')
  if (!stored || !isResponse(response)) return null
  const credentialId = (response as AuthenticationResponseJSON).id
  const [row] = await tursoQuery('SELECT * FROM mail_passkeys WHERE id = ?', [credentialId])
  if (!row) return null
  const email = String(row.email)
  const handle = (response as AuthenticationResponseJSON).response.userHandle
  if (handle && handle !== Buffer.from(userHandle(email)).toString('base64url')) return null
  const rp = relyingParty()
  const result = await verifyAuthenticationResponse({
    response: response as AuthenticationResponseJSON,
    expectedChallenge: stored.challenge,
    expectedOrigin: rp.origins,
    expectedRPID: rp.id,
    requireUserVerification: true,
    credential: {
      id: String(row.id),
      publicKey: new Uint8Array(Buffer.from(String(row.public_key), 'base64url')),
      counter: Number(row.counter ?? 0),
      transports: parseTransports(row.transports),
    },
  }).catch(() => null)
  if (!result?.verified) return null
  await tursoQuery('UPDATE mail_passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
    [result.authenticationInfo.newCounter, new Date().toISOString(), credentialId])
  return email
}

function parseTransports(value: unknown): AuthenticatorTransport[] | undefined {
  try {
    const list = JSON.parse(String(value ?? '[]'))
    return Array.isArray(list) && list.length ? list : undefined
  } catch {
    return undefined
  }
}

function isResponse(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { response?: unknown }).response === 'object')
}

export function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH) : ''
}
