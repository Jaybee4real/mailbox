'use client'

import { useCallback, useEffect, useState } from 'react'
import { CLIENT_BRAND, LS } from '@/lib/brand.client'
import { formatWait, loadPause, savePause, scopeWords, secondsLeft, type Pause, type PauseFlow } from './pause'
import styles from './page.module.css'

const PREFIX = LS('')

const browserStore = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return
    let timer = 0
    const tick = () => {
      const current = Date.now()
      setNow(current)
      window.clearTimeout(timer)
      if (current < until) timer = window.setTimeout(tick, (until - current) % 1000 || 1000)
    }
    const catchUp = () => {
      if (document.visibilityState === 'visible') tick()
    }
    timer = window.setTimeout(tick, 0)
    document.addEventListener('visibilitychange', catchUp)
    window.addEventListener('focus', catchUp)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', catchUp)
      window.removeEventListener('focus', catchUp)
    }
  }, [until])
  return until ? secondsLeft(until, now) : 0
}

export function usePause(flow: PauseFlow) {
  const [pause, setPause] = useState<Pause | null>(() => loadPause(browserStore(), PREFIX, flow))
  const [announcement, setAnnouncement] = useState('')
  const start = useCallback((next: Pause) => {
    setPause(next)
    savePause(browserStore(), PREFIX, flow, next)
    setAnnouncement(`Paused. You can try again in ${formatWait(secondsLeft(next.blockedUntil, Date.now()))}.`)
  }, [flow])
  const end = useCallback(() => {
    setPause(null)
    savePause(browserStore(), PREFIX, flow, null)
    setAnnouncement('You can try again now.')
  }, [flow])
  return { pause, start, end, announcement }
}

export function PauseAnnouncer({ text }: { text: string }) {
  return (
    <span className={styles.srOnly} role="status" aria-live="polite">
      {text}
    </span>
  )
}

export default function RequestPause({ pause, onEnd }: { pause: Pause; onEnd: () => void }) {
  const remaining = useCountdown(pause.blockedUntil)
  useEffect(() => {
    if (remaining <= 0) onEnd()
  }, [remaining, onEnd])

  const wait = formatWait(remaining)
  return (
    <div className={styles.pausePanel}>
      <p className={styles.pauseTitle}>Let&apos;s take a short pause</p>
      <p className={styles.pauseBody}>
        We&apos;ve had a lot of requests from {scopeWords(pause.scope)}, so we&apos;ve paused new ones to keep your account safe. You can try again in {wait}.
      </p>
      <p className={styles.pauseHint}>Trying again before then makes the wait longer.</p>
      <button type="button" className={styles.loginBtn} disabled>
        Try again in {wait}
      </button>
      <a className={styles.pauseSupport} href={`mailto:${CLIENT_BRAND.supportEmail}`}>
        Contact support
      </a>
    </div>
  )
}
