export type PauseScope = 'device' | 'account' | 'ip'
export type PauseFlow = 'signin' | 'code' | 'reset'
export type Pause = { scope: PauseScope; blockedUntil: number; message: string }

const SCOPE_WORDS: Record<PauseScope, string> = {
  device: 'this device',
  ip: 'your network',
  account: 'your account',
}

export const scopeWords = (scope: PauseScope): string => SCOPE_WORDS[scope] ?? SCOPE_WORDS.device

export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds))
  if (whole < 10) return 'less than a minute'
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export const secondsLeft = (until: number, now: number): number => Math.max(0, Math.ceil((until - now) / 1000))

export function readPause(status: number, retryAfterHeader: string | null, body: unknown, now = Date.now()): Pause | null {
  if (status !== 429) return null
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const scope: PauseScope = data.scope === 'account' || data.scope === 'device' || data.scope === 'ip' ? data.scope : 'ip'
  const until = Date.parse(String(data.blocked_until ?? ''))
  const retrySeconds = Number(data.retry_after ?? retryAfterHeader)
  const blockedUntil = Number.isFinite(until) && until > now
    ? until
    : now + (Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds : 60) * 1000
  return { scope, blockedUntil, message: typeof data.error === 'string' ? data.error : '' }
}

export function readThrottle(body: unknown, now = Date.now()): number | null {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const seconds = Number(data.retry_after)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return now + seconds * 1000
}

type PauseStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const storageKey = (prefix: string, flow: PauseFlow) => `${prefix}pause_${flow}`

export function savePause(store: PauseStore | null, prefix: string, flow: PauseFlow, pause: Pause | null): void {
  try {
    if (!store) return
    if (pause) store.setItem(storageKey(prefix, flow), JSON.stringify(pause))
    else store.removeItem(storageKey(prefix, flow))
  } catch {}
}

export function loadPause(store: PauseStore | null, prefix: string, flow: PauseFlow, now = Date.now()): Pause | null {
  try {
    const raw = store?.getItem(storageKey(prefix, flow))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Pause>
    if (typeof parsed.blockedUntil !== 'number' || parsed.blockedUntil <= now) {
      store?.removeItem(storageKey(prefix, flow))
      return null
    }
    const scope: PauseScope = parsed.scope === 'account' || parsed.scope === 'ip' ? parsed.scope : 'device'
    return { scope, blockedUntil: parsed.blockedUntil, message: typeof parsed.message === 'string' ? parsed.message : '' }
  } catch {
    return null
  }
}
