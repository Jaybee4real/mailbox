import { createHash } from 'node:crypto'
import { BRAND } from './brand'
import { clientIp, nativeAppDevice } from './client-context'
import { nativeClient } from './turnstile'

export type SecurityEvent = { level: 2 | 3; kind: string; detail: string; account?: string; bodyFields?: string[] }

const REPORT_TIMEOUT_MS = 3000
const CONTEXT_FIELDS = 40
const CONTEXT_VALUE_LENGTH = 500
const SECRET_PARAM = /token|key|code|secret|pass|auth|sig|session|otp|jwt|nonce|ticket|hash/i

const redactQuery = (search: URLSearchParams) =>
  [...search].map(([name, value]) => `${name}=${SECRET_PARAM.test(name) ? '[redacted]' : value}`).join('&')

const withoutQuery = (value: string | null) => {
  if (!value) return null
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split('?')[0]
  }
}

export function reportContext(req: Request, event: SecurityEvent): Record<string, string> {
  const url = new URL(req.url)
  const header = (name: string) => req.headers.get(name)
  const appVersion = [process.env.NEXT_PUBLIC_APP_VERSION, process.env.NEXT_PUBLIC_BUILD_NUMBER && `build ${process.env.NEXT_PUBLIC_BUILD_NUMBER}`, process.env.NEXT_PUBLIC_BUILD_SHA?.slice(0, 7)]
    .filter(Boolean)
    .join(' · ')
  const fields: Array<[string, string | null | undefined]> = [
    ['Method', req.method],
    ['Host', header('host') ?? url.host],
    ['Query', url.search ? redactQuery(url.searchParams) : null],
    ['Origin', header('origin')],
    ['Referer', withoutQuery(header('referer'))],
    ['Accept-Language', header('accept-language')],
    ['X-Forwarded-For', header('x-forwarded-for')],
    ['CF-Connecting-IP', header('cf-connecting-ip')],
    ['CF-IPCountry', header('cf-ipcountry')],
    ['CF-Ray', header('cf-ray')],
    ['Request ID', header('x-request-id')],
    ['Tenant', BRAND.name],
    ['App version', appVersion],
    ['Attempted account', event.account],
    ['Body fields', event.bodyFields?.length ? event.bodyFields.join(', ') : null],
    ['Device', nativeClient(req) ? [nativeAppDevice(header('x-mail-device'), header('user-agent')), header('x-mail-device')].filter(Boolean).join(' · ') : null],
  ]
  const context: Record<string, string> = {}
  for (const [name, value] of fields) {
    const text = value?.trim()
    if (text && Object.keys(context).length < CONTEXT_FIELDS) context[name] = text.slice(0, CONTEXT_VALUE_LENGTH)
  }
  return context
}

const digest = (value: string) => createHash('sha256').update(value.trim().toLowerCase()).digest('hex')

function watchList(): Set<string> {
  return new Set((process.env.SECURITY_WATCH ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean))
}

export function watchListSize(): number {
  return watchList().size
}

export function isWatched(...values: Array<string | null | undefined>): boolean {
  const list = watchList()
  if (!list.size) return false
  return values.some(value => Boolean(value?.trim()) && list.has(digest(value!)))
}

export function reportSecurityEvent(req: Request, event: SecurityEvent): Promise<void> {
  const url = process.env.SECURITY_EVENTS_URL?.trim()
  const token = process.env.SECURITY_EVENTS_TOKEN?.trim()
  if (!url || !token) return Promise.resolve()
  const requestUrl = new URL(req.url)
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      product: 'vela-mail',
      level: event.level,
      kind: event.kind,
      detail: `${event.detail} (${req.headers.get('host') ?? requestUrl.host})`,
      source: clientIp(req) ?? 'unknown',
      path: requestUrl.pathname,
      userAgent: req.headers.get('user-agent')?.slice(0, 512) ?? '',
      context: reportContext(req, event),
    }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  })
    .then(response => {
      if (!response.ok) console.warn('[security-events]', `report answered ${response.status}`)
    })
    .catch(err => console.warn('[security-events]', err instanceof Error ? err.message : err))
}
