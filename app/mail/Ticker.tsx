'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import styles from './page.module.css'

export const TICKER_SPOTS = [
  { group: 'Mail list', spots: [['listFrom', 'Sender'], ['listSubject', 'Subject'], ['listSnippet', 'Preview']] },
  { group: 'Conversation', spots: [['threadFrom', 'Sender'], ['threadSnippet', 'Preview']] },
  { group: 'Reader', spots: [['readerFrom', 'From'], ['readerTo', 'To and Cc']] },
  { group: 'Attachments', spots: [['attachName', 'File names in the row'], ['attachChip', 'File names in the composer']] },
  { group: 'Reply bar', spots: [['replyRecipients', 'Recipients']] },
] as const

export type TickerSpot = (typeof TICKER_SPOTS)[number]['spots'][number][0]
export type TickerSettings = Partial<Record<TickerSpot, boolean>>

const SPOT_NAMES = new Set<string>(TICKER_SPOTS.flatMap(group => group.spots.map(([spot]) => spot)))

export function tickerSettingsFrom(raw: unknown): TickerSettings {
  const kept: TickerSettings = {}
  if (raw && typeof raw === 'object') {
    for (const [spot, value] of Object.entries(raw)) {
      if (SPOT_NAMES.has(spot) && typeof value === 'boolean') kept[spot as TickerSpot] = value
    }
  }
  return kept
}

/**
 * One line of text that, when it does not fit, glides back and forth instead of ending in
 * an ellipsis. Measured on mount and whenever the host or its text changes size.
 */
export default function Ticker({ className, title, enabled = true, children }: { className?: string; title?: string; enabled?: boolean; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const outer = host.current
    const inner = text.current
    if (!outer || !inner) return
    if (!enabled) {
      delete outer.dataset.ticker
      outer.style.removeProperty('--ticker-shift')
      return
    }
    const measure = () => {
      const shift = inner.scrollWidth - outer.clientWidth
      if (shift > 4) {
        outer.dataset.ticker = 'on'
        outer.style.setProperty('--ticker-shift', `${shift}px`)
        outer.style.setProperty('--ticker-duration', `${Math.min(18, Math.max(6, shift / 20))}s`)
        outer.style.setProperty('--ticker-delay', `-${(inner.textContent?.length ?? 0) % 7}s`)
      } else {
        delete outer.dataset.ticker
        outer.style.removeProperty('--ticker-shift')
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [children, enabled])
  return (
    <span ref={host} className={`${className ?? ''} ${styles.tickerHost}`} title={title}>
      <span ref={text} className={styles.tickerText}>{children}</span>
    </span>
  )
}
