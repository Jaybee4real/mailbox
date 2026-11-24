import { createHash } from 'node:crypto'
import { clientIp } from './client-context'

export type SecurityEvent = { level: 2 | 3; kind: string; detail: string }

const REPORT_TIMEOUT_MS = 3000

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
    }),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  })
    .then(() => undefined)
    .catch(err => console.warn('[security-events]', err instanceof Error ? err.message : err))
}
