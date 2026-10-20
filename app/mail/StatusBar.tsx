'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConfirm } from './ConfirmDialog'
import styles from './page.module.css'

type Link = 'online' | 'slow' | 'busy' | 'offline' | 'down' | 'back' | 'restored'

const SLOW_MS = 8000
const CHECK_AT_MS = 3000
const PROBE_FAST_MS = 2500
const SHOW_AFTER_MS = 2000
const BACK_FOR_MS = 2500
const PROBE_EVERY_MS = 5000
const VERSION_EVERY_MS = 3 * 60 * 1000
const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530])
const BUILD = process.env.NEXT_PUBLIC_BUILD_TIME ?? null

type Check = { done: boolean; result?: Probe }
type Tracked = { path: string; started: number; ended?: number; server?: boolean; check?: Check }
type Signal = 'ok' | 'network' | 'gateway' | 'slow' | 'slow-done'
type Listener = (signal: Signal, request: Tracked) => void
const listeners = new Set<Listener>()
let plainFetch: typeof fetch | null = null

/**
 * The bar listens to the page's own requests rather than navigator.onLine, which stays true
 * on a router that has lost its internet. A request that never got an answer means the
 * reader's connection; a gateway error means Cloudflare was reached and our server was not.
 */
function observeRequests() {
  if (plainFetch || typeof window === 'undefined') return
  plainFetch = window.fetch.bind(window)
  const original = plainFetch
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ours = url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)
    if (!ours) return original(input, init)
    const request: Tracked = { path: new URL(url, window.location.origin).pathname, started: Date.now() }
    const emit = (signal: Signal) => listeners.forEach(listener => listener(signal, request))
    let slow = false
    const checkTimer = window.setTimeout(() => {
      request.check = startCheck()
    }, CHECK_AT_MS)
    const timer = window.setTimeout(() => {
      slow = true
      emit('slow')
    }, SLOW_MS)
    try {
      const response = await original(input, init)
      emit(GATEWAY.has(response.status) ? 'gateway' : 'ok')
      return response
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') emit('network')
      throw err
    } finally {
      window.clearTimeout(checkTimer)
      window.clearTimeout(timer)
      request.ended = Date.now()
      if (slow) emit('slow-done')
      if (request.server) reportSlow(request)
    }
  }
}

function reportSlow(request: Tracked) {
  try {
    const body = JSON.stringify({ path: request.path, ms: (request.ended ?? Date.now()) - request.started })
    navigator.sendBeacon?.('/api/mail/slow-report', new Blob([body], { type: 'application/json' }))
  } catch {}
}

type Probe = { reached: 'ok' | 'gateway' | 'network' | 'timeout'; ms: number; build: string | null }

let sharedCheck: { check: Check; at: number } | null = null

/** Times a tiny request beside a slow one. One check serves every request slowed at once. */
function startCheck(): Check {
  if (sharedCheck && Date.now() - sharedCheck.at < 4000) return sharedCheck.check
  const check: Check = { done: false }
  sharedCheck = { check, at: Date.now() }
  void probe().then(result => {
    check.done = true
    check.result = result
  })
  return check
}

async function probe(): Promise<Probe> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 5000)
  const started = Date.now()
  try {
    const response = await (plainFetch ?? fetch)('/api/version', { cache: 'no-store', signal: controller.signal })
    const ms = Date.now() - started
    if (GATEWAY.has(response.status)) return { reached: 'gateway', ms, build: null }
    const data = response.ok ? ((await response.json().catch(() => null)) as { build?: string | null } | null) : null
    return { reached: 'ok', ms, build: data?.build ?? null }
  } catch {
    return { reached: controller.signal.aborted ? 'timeout' : 'network', ms: Date.now() - started, build: null }
  } finally {
    window.clearTimeout(timer)
  }
}

function useLink(): { link: Link; retry: () => Promise<boolean> } {
  const [link, setLink] = useState<Link>('online')
  const recheckRef = useRef<() => Promise<boolean>>(async () => false)
  const failures = useRef({ network: 0, gateway: 0 })
  const pending = useRef({ network: 0, server: 0 })
  const state = useRef<Link>('online')

  useEffect(() => {
    observeRequests()
    let backTimer = 0
    const set = (next: Link) => {
      if (state.current === next) return
      const from = state.current
      state.current = next
      if (next === 'online' && (from === 'offline' || from === 'down')) {
        const flash: Link = from === 'offline' ? 'back' : 'restored'
        state.current = flash
        setLink(flash)
        window.dispatchEvent(new Event('mailbox:back-online'))
        window.clearTimeout(backTimer)
        backTimer = window.setTimeout(() => {
          if (state.current === flash) {
            state.current = 'online'
            setLink('online')
          }
        }, BACK_FOR_MS)
        return
      }
      setLink(next)
    }
    const outage = () => state.current === 'offline' || state.current === 'down'
    const settleSlow = () => {
      if (outage()) return
      const next = pending.current.network > 0 ? 'slow' : pending.current.server > 0 ? 'busy' : null
      if (next) set(next)
      else if (state.current === 'slow' || state.current === 'busy') set('online')
    }
    const answered = () => {
      failures.current = { network: 0, gateway: 0 }
      if (outage()) set('online')
    }
    const failed = (kind: 'network' | 'gateway') => {
      failures.current[kind] += 1
      if (kind === 'network' && (failures.current.network >= 2 || !navigator.onLine)) set('offline')
      if (kind === 'gateway' && failures.current.gateway >= 2 && state.current !== 'offline') set('down')
    }
    const listener: Listener = (signal, request) => {
      if (signal === 'ok') {
        answered()
        settleSlow()
      } else if (signal === 'network' || signal === 'gateway') {
        failed(signal)
      } else if (signal === 'slow') {
        // A check still out after five seconds is itself the answer: the network is slow.
        const result = request.check?.done ? request.check.result : undefined
        if (result?.reached === 'network' || result?.reached === 'gateway') return failed(result.reached)
        request.server = result?.reached === 'ok' && result.ms < PROBE_FAST_MS
        pending.current[request.server ? 'server' : 'network'] += 1
        settleSlow()
      } else if (request.server !== undefined) {
        const lane = request.server ? 'server' : 'network'
        pending.current[lane] = Math.max(0, pending.current[lane] - 1)
        settleSlow()
      }
    }
    listeners.add(listener)
    const recheck = async () => {
      const result = await probe()
      if (result.reached === 'ok') answered()
      else failed(result.reached === 'gateway' ? 'gateway' : 'network')
      return result.reached === 'ok'
    }
    recheckRef.current = recheck
    const onOffline = () => set('offline')
    const onOnline = () => {
      void recheck()
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => {
      if (outage()) void recheck()
    }, PROBE_EVERY_MS)
    if (!navigator.onLine) set('offline')
    return () => {
      listeners.delete(listener)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
      window.clearInterval(timer)
      window.clearTimeout(backTimer)
    }
  }, [])

  // An outage shorter than this never shows. A slow request has already waited SLOW_MS.
  const [lasting, setLasting] = useState<Link | null>(null)
  useEffect(() => {
    if (link === 'back' || link === 'restored') return
    const outage = link === 'offline' || link === 'down'
    const timer = window.setTimeout(() => setLasting(link === 'online' ? null : link), outage ? SHOW_AFTER_MS : 0)
    return () => window.clearTimeout(timer)
  }, [link])
  const retry = useCallback(() => recheckRef.current(), [])
  const shown =
    link === 'online'
      ? link
      : link === 'back'
        ? (lasting === 'offline' ? 'back' : 'online')
        : link === 'restored'
          ? (lasting === 'down' ? 'restored' : 'online')
          : link === 'slow' || link === 'busy' || lasting === link
            ? link
            : 'online'
  return { link: shown, retry }
}

function useNewVersion(): string | null {
  const [newer, setNewer] = useState<string | null>(null)
  useEffect(() => {
    if (!BUILD) return
    let stopped = false
    const check = async () => {
      if (stopped) return
      const { build } = await probe()
      if (build && build !== BUILD) setNewer(build)
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, VERSION_EVERY_MS)
    const onWake = () => void check()
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('mailbox:back-online', onWake)
    void check()
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('mailbox:back-online', onWake)
    }
  }, [])
  return newer
}

const ICONS = {
  offline: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M2 2l20 20" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M5 12.86a10 10 0 0 1 5.17-2.69" />
      <path d="M19 12.86a10 10 0 0 0-2.01-1.53" />
      <path d="M2 8.82a15 15 0 0 1 4.18-2.65" />
      <path d="M22 8.82a15 15 0 0 0-11.29-3.76" />
      <circle cx="12" cy="20" r="0.6" />
    </svg>
  ),
  slow: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 3a9 9 0 1 0 9 9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  busy: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 2h12" />
      <path d="M6 22h12" />
      <path d="M7 2v4a5 5 0 0 0 10 0V2" />
      <path d="M7 22v-4a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01" />
      <path d="M7 16.5h.01" />
      <path d="M11 16.5h6" />
    </svg>
  ),
  back: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  restored: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  update: (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  ),
}

const COPY: Record<Exclude<Link, 'online'>, { title: string; detail: string }> = {
  offline: { title: 'You are offline', detail: 'Mail already loaded stays readable. You can send again once you reconnect.' },
  down: { title: 'Mailbox not responding', detail: 'Your connection is fine. We keep retrying the mail server.' },
  slow: { title: 'Slow connection', detail: 'Still working on it. This can take a little longer than usual.' },
  busy: { title: 'Taking longer than usual', detail: 'Your connection is fine. The mailbox is still working on it.' },
  back: { title: 'Back online', detail: 'Bringing your mail up to date.' },
  restored: { title: 'Mailbox is responding again', detail: 'Bringing your mail up to date.' },
}

export default function StatusBar() {
  const { link, retry } = useLink()
  const newer = useNewVersion()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<'checking' | 'failed' | null>(null)
  const confirm = useConfirm()
  const ref = useRef<HTMLDivElement | null>(null)
  const update = Boolean(newer && newer !== dismissed)
  const visible = link !== 'online' || update

  useLayoutEffect(() => {
    const root = document.documentElement
    const node = ref.current
    if (!node) {
      root.style.setProperty('--status-offset', '0px')
      return
    }
    const measure = () => root.style.setProperty('--status-offset', `${node.offsetHeight}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      observer.disconnect()
      root.style.setProperty('--status-offset', '0px')
    }
  }, [visible])

  if (!visible) return null

  const refresh = async () => {
    if (document.querySelector('[data-composing]')) {
      const agreed = await confirm({
        title: 'Refresh now?',
        body: 'The message you are writing is saved in Drafts, and you can open it again after the refresh.',
        confirmLabel: 'Refresh',
      })
      if (!agreed) return
    }
    window.location.reload()
  }

  const tryAgain = async () => {
    setRetrying('checking')
    const [ok] = await Promise.all([retry(), new Promise(resolve => window.setTimeout(resolve, 900))])
    if (ok) return setRetrying(null)
    setRetrying('failed')
    window.setTimeout(() => setRetrying(current => (current === 'failed' ? null : current)), 1800)
  }

  return (
    <div className={styles.statusBars} ref={ref}>
      {link !== 'online' && (
        <div className={`${styles.statusBar} ${styles[`status_${link}`]}`} role="status" aria-live="polite">
          <span className={styles.statusIcon}>{ICONS[link]}</span>
          <span className={styles.statusText}>
            <strong>{COPY[link].title}</strong>
            <span>{COPY[link].detail}</span>
          </span>
          {(link === 'offline' || link === 'down') && (
            <button type="button" className={styles.statusGhost} onClick={tryAgain} disabled={retrying === 'checking'}>
              {retrying === 'checking' ? 'Checking…' : retrying === 'failed' ? (link === 'down' ? 'Still not responding' : 'Still offline') : 'Try again'}
            </button>
          )}
        </div>
      )}
      {update && (
        <div className={`${styles.statusBar} ${styles.status_update}`} role="status">
          <span className={styles.statusIcon}>{ICONS.update}</span>
          <span className={styles.statusText}>
            <strong>Update ready</strong>
            <span>A newer version of the mailbox is available.</span>
          </span>
          <span className={styles.statusActions}>
            <button type="button" className={styles.statusGhost} onClick={() => setDismissed(newer)}>
              Later
            </button>
            <button type="button" className={styles.statusPrimary} onClick={refresh}>
              Refresh
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
