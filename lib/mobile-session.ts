import { createHash, randomBytes } from 'node:crypto'
import { tursoQuery } from './turso'

const digest = (token: string) => createHash('sha256').update(token).digest('hex')
const APP_COLUMNS = ['app_version', 'app_build', 'app_update', 'app_platform', 'os_version'] as const
const SEEN_EVERY_MS = 60 * 60 * 1000

export type AppInfo = { app_version: string; app_build: string; app_update: string; app_platform: string; os_version: string }

export function readAppInfo(req: Request): AppInfo | null {
  const raw = req.headers.get('x-vela-app')
  if (!raw || raw.length > 400) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const clean = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/[^\w .()+-]/g, '').slice(0, 32)
  return {
    app_version: clean(parsed.version),
    app_build: clean(parsed.build),
    app_update: clean(parsed.update),
    app_platform: clean(parsed.platform),
    os_version: clean(parsed.os),
  }
}
let schema: Promise<unknown> | undefined
async function ready() {
  schema ??= tursoQuery(`CREATE TABLE IF NOT EXISTS mail_mobile_sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    fingerprint TEXT NOT NULL, device TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT NOT NULL, push_token TEXT, previews INTEGER DEFAULT 0
  )`)
    .then(() => tursoQuery('ALTER TABLE mail_mobile_sessions ADD COLUMN push_kind TEXT').catch(() => {}))
    .then(() => Promise.all(APP_COLUMNS.map(column => tursoQuery(`ALTER TABLE mail_mobile_sessions ADD COLUMN ${column} TEXT`).catch(() => {}))))
    .catch(error => { schema = undefined; throw error })
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
  const app = readAppInfo(req)
  const changed = app && APP_COLUMNS.some(column => String(row[column] ?? '') !== app[column])
  const stale = Date.now() - Date.parse(String(row.last_used_at)) > SEEN_EVERY_MS
  if (changed || stale) {
    const values = changed ? APP_COLUMNS.map(column => app[column]) : APP_COLUMNS.map(column => (row[column] == null ? null : String(row[column])))
    await tursoQuery(
      `UPDATE mail_mobile_sessions SET last_used_at = ?, ${APP_COLUMNS.map(column => `${column} = ?`).join(', ')} WHERE id = ?`,
      [new Date().toISOString(), ...values, String(row.id)],
    ).catch(() => {})
  }
  return { id: String(row.id), email: String(row.email), fingerprint: String(row.fingerprint) }
}
export async function mobileDevices(email: string) {
  await ready()
  return tursoQuery(`SELECT id, device, created_at, last_used_at, expires_at, push_token IS NOT NULL AS notifications, ${APP_COLUMNS.join(', ')} FROM mail_mobile_sessions WHERE email = ? AND expires_at > ? ORDER BY created_at DESC`, [email, Date.now()])
}
export async function mobileDevicesByAccount(): Promise<Map<string, Array<Record<string, unknown>>>> {
  await ready()
  const rows = await tursoQuery(`SELECT email, device, created_at, last_used_at, ${APP_COLUMNS.join(', ')} FROM mail_mobile_sessions WHERE expires_at > ? ORDER BY last_used_at DESC`, [Date.now()])
  const byEmail = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    const email = String(row.email)
    byEmail.set(email, [...(byEmail.get(email) ?? []), row])
  }
  return byEmail
}
export async function revokeMobileDevice(email: string, id: string) {
  await ready()
  await tursoQuery('DELETE FROM mail_mobile_sessions WHERE email = ? AND id = ?', [email, id])
}
export async function setMobilePush(email: string, id: string, token: string | null, previews = false, kind: string | null = null) {
  await ready()
  await tursoQuery('UPDATE mail_mobile_sessions SET push_token = ?, previews = ?, push_kind = ? WHERE email = ? AND id = ?', [token, previews, token ? kind : null, email, id])
}
export async function mobilePushRecipients(email: string) {
  await ready()
  return tursoQuery('SELECT id, push_token, previews, push_kind FROM mail_mobile_sessions WHERE email = ? AND push_token IS NOT NULL AND expires_at > ?', [email, Date.now()])
}
