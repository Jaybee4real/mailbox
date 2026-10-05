import { createSign } from 'node:crypto'

type Credentials = { project_id: string; client_email: string; private_key: string }
let cached: { token: string; expires: number; email: string } | undefined

function credentials(): Credentials | null {
  const raw = process.env.VELA_FIREBASE_SERVICE_ACCOUNT
  if (!raw) return null
  const parsed = JSON.parse(raw) as Credentials
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) throw new Error('Invalid Vela Firebase service account')
  return parsed
}
async function accessToken(account: Credentials): Promise<string> {
  if (cached && cached.email === account.client_email && cached.expires > Date.now()) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${base64({ alg: 'RS256', typ: 'JWT' })}.${base64({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }), signal: AbortSignal.timeout(10000) })
  const data = await response.json() as { access_token?: string; expires_in?: number }
  if (!response.ok || !data.access_token) throw new Error('Firebase authentication failed')
  cached = { token: data.access_token, expires: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000, email: account.client_email }
  return data.access_token
}

export async function sendFcm(token: string, notification: { title: string; body: string }, data: Record<string, string>): Promise<'sent' | 'unregistered' | 'unconfigured' | 'failed'> {
  const account = credentials()
  if (!account) return 'unconfigured'
  const bearer = await accessToken(account)
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification, data, apns: { payload: { aps: { sound: 'default' } } }, android: { priority: 'high' } } }), signal: AbortSignal.timeout(10000),
  })
  if (response.ok) return 'sent'
  const result = await response.json().catch(() => null) as { error?: { details?: { errorCode?: string }[] } } | null
  if (result?.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED')) return 'unregistered'
  if (response.status === 401) cached = undefined
  return 'failed'
}
