'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import styles from './page.module.css'

/**
 * One line of text that, when it does not fit, glides back and forth instead of ending in
 * an ellipsis. Measured on mount and whenever the host or its text changes size.
 */
export default function Ticker({ className, title, children }: { className?: string; title?: string; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null)
  const text = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const outer = host.current
    const inner = text.current
    if (!outer || !inner) return
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
  }, [children])
  return (
    <span ref={host} className={`${className ?? ''} ${styles.tickerHost}`} title={title}>
      <span ref={text} className={styles.tickerText}>{children}</span>
    </span>
  )
}
