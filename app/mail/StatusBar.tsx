'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConfirm } from './ConfirmDialog'
import styles from './page.module.css'

type Link = 'online' | 'slow' | 'offline' | 'back'

const SLOW_MS = 8000
const SHOW_AFTER_MS = 2000
const BACK_FOR_MS = 2500
const PROBE_EVERY_MS = 5000
const VERSION_EVERY_MS = 3 * 60 * 1000
const UNREACHABLE = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530])
const BUILD = process.env.NEXT_PUBLIC_BUILD_TIME ?? null

type Listener = (event: 'ok' | 'fail' | 'slow' | 'slow-done') => void
const listeners = new Set<Listener>()
let plainFetch: typeof fetch | null = null

/**
 * Every request the page makes already says whether the server can be reached, so the bar
 * listens to those rather than to navigator.onLine, which stays true on a router that has
 * lost its internet. Patched once per page; the probe uses the unpatched fetch.
 */
function observeRequests() {
  if (plainFetch || typeof window === 'undefined') return
  plainFetch = window.fetch.bind(window)
  const original = plainFetch
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ours = url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`)
    if (!ours) return original(input, init)
    const emit = (event: Parameters<Listener>[0]) => listeners.forEach(listener => listener(event))
    let slow = false
    const timer = window.setTimeout(() => {
      slow = true
      emit('slow')
    }, SLOW_MS)
    try {
      const response = await original(input, init)
      emit(UNREACHABLE.has(response.status) ? 'fail' : 'ok')
      return response
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') emit('fail')
      throw err
    } finally {
      window.clearTimeout(timer)
      if (slow) emit('slow-done')
    }
  }
}

async function probe(): Promise<{ ok: boolean; build: string | null }> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 5000)
  try {
    const response = await (plainFetch ?? fetch)('/api/version', { cache: 'no-store', signal: controller.signal })
    if (!response.ok) return { ok: !UNREACHABLE.has(response.status), build: null }
    const data = (await response.json().catch(() => null)) as { build?: string | null } | null
    return { ok: true, build: data?.build ?? null }
  } catch {
    return { ok: false, build: null }
  } finally {
    window.clearTimeout(timer)
  }
}

function useLink(): { link: Link; retry: () => Promise<void> } {
  const [link, setLink] = useState<Link>('online')
  const recheckRef = useRef<() => Promise<void>>(async () => {})
  const failures = useRef(0)
  const slowPending = useRef(0)
  const state = useRef<Link>('online')

  useEffect(() => {
    observeRequests()
    let backTimer = 0
    const set = (next: Link) => {
      if (state.current === next) return
      const wasDown = state.current === 'offline'
      state.current = next
      if (next === 'online' && wasDown) {
        state.current = 'back'
        setLink('back')
        window.dispatchEvent(new Event('mailbox:back-online'))
        window.clearTimeout(backTimer)
        backTimer = window.setTimeout(() => {
          if (state.current === 'back') {
            state.current = 'online'
            setLink('online')
          }
        }, BACK_FOR_MS)
        return
      }
      setLink(next)
    }
    const listener: Listener = event => {
      if (event === 'ok') {
        failures.current = 0
        if (state.current === 'offline' || (state.current === 'slow' && slowPending.current === 0)) set('online')
      } else if (event === 'fail') {
        failures.current += 1
        if (failures.current >= 2) set('offline')
      } else if (event === 'slow') {
        slowPending.current += 1
        if (state.current !== 'offline') set('slow')
      } else if (slowPending.current > 0) {
        slowPending.current -= 1
        if (slowPending.current === 0 && state.current === 'slow') set('online')
      }
    }
    listeners.add(listener)
    const recheck = async () => {
      const result = await probe()
      if (result.ok) {
        failures.current = 0
        if (state.current === 'offline') set('online')
      } else if (state.current !== 'offline') {
        failures.current += 1
        if (failures.current >= 2 || !navigator.onLine) set('offline')
      }
    }
    recheckRef.current = recheck
    const onOffline = () => set('offline')
    const onOnline = () => void recheck()
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => {
      if (state.current === 'offline') void recheck()
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

  // A blip shorter than this never shows; only the all-clear appears at once.
  const [lasting, setLasting] = useState<Link | null>(null)
  useEffect(() => {
    if (link === 'back') return
    const timer = window.setTimeout(() => setLasting(link === 'online' ? null : link), link === 'online' ? 0 : SHOW_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [link])
  const retry = useCallback(() => recheckRef.current(), [])
  const shown = link === 'online' ? link : link === 'back' ? (lasting === 'offline' ? 'back' : 'online') : lasting === link ? link : 'online'
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
  back: (
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
  slow: { title: 'Slow connection', detail: 'Still working on it. This can take a little longer than usual.' },
  back: { title: 'Back online', detail: 'Bringing your mail up to date.' },
}

export default function StatusBar() {
  const { link, retry } = useLink()
  const newer = useNewVersion()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
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
    setRetrying(true)
    await retry()
    setRetrying(false)
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
          {link === 'offline' && (
            <button type="button" className={styles.statusGhost} onClick={tryAgain} disabled={retrying}>
              {retrying ? 'Checking…' : 'Try again'}
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
