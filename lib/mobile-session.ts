import { createHash, randomBytes } from 'node:crypto'
import { tursoQuery } from './turso'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
let schema: Promise<unknown> | undefined
async function ready() {
  schema ??= tursoQuery(`CREATE TABLE IF NOT EXISTS mail_mobile_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    fingerprint TEXT NOT NULL, device TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, push_token TEXT, previews INTEGER DEFAULT 0
  )`).catch(error => { schema = undefined; throw error })
  await schema
}
export async function issueMobileSession(email: string, fingerprint: string, device = 'Vela Mail') {
  await ready()
  const token = `vm_${randomBytes(32).toString('base64url')}`
  const id = randomBytes(16).toString('hex')
  const now = new Date().toISOString()
  await tursoQuery('DELETE FROM mail_mobile_sessions WHERE expires_at <= ?', [Date.now()])
  await tursoQuery('INSERT INTO mail_mobile_sessions (id, token_hash, email, fingerprint, device, expires_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, digest(token), email.toLowerCase(), fingerprint, device.slice(0, 100), Date.now() + 30 * 86400000, now, now])
  return token
}
export async function readMobileSession(req: Request) {
  const token = req.headers.get('authorization')?.match(/^Bearer (vm_[\w-]{43})$/)?.[1]
  if (!token) return null
  await ready()
  const [row] = await tursoQuery('SELECT * FROM mail_mobile_sessions WHERE token_hash = ? AND expires_at > ?', [digest(token), Date.now()])
  if (!row) return null
  return { id: String(row.id), email: String(row.email), fingerprint: String(row.fingerprint) }
}
export async function mobileDevices(email: string) {
  await ready()
  return tursoQuery('SELECT id, device, created_at, last_used_at, expires_at, push_token IS NOT NULL AS notifications FROM mail_mobile_sessions WHERE email = ? AND expires_at > ? ORDER BY created_at DESC', [email, Date.now()])
}
export async function revokeMobileDevice(email: string, id: string) {
  await ready()
  await tursoQuery('DELETE FROM mail_mobile_sessions WHERE email = ? AND id = ?', [email, id])
}
export async function setMobilePush(email: string, id: string, token: string | null, previews = false) {
  await ready()
  await tursoQuery('UPDATE mail_mobile_sessions SET push_token = ?, previews = ? WHERE email = ? AND id = ?', [token, previews, email, id])
}
export async function mobilePushRecipients(email: string) {
  await ready()
  return tursoQuery('SELECT id, push_token, previews FROM mail_mobile_sessions WHERE email = ? AND push_token IS NOT NULL AND expires_at > ?', [email, Date.now()])
}
