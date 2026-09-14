'use client'

import { useEffect, useState } from 'react'
import styles from './page.module.css'

const VERBS = [
  'Waking the mailbox',
  'Checking your access',
  'Verifying credentials',
  'Opening the vault',
  'Counting what arrived',
  'Almost there',
]

export default function AccessCheck() {
  const [verbIndex, setVerbIndex] = useState(0)

  useEffect(() => {
    if (verbIndex >= VERBS.length - 1) return
    const timer = setTimeout(() => setVerbIndex(current => current + 1), verbIndex === 0 ? 900 : 1500)
    return () => clearTimeout(timer)
  }, [verbIndex])

  return (
    <div className={styles.loginWrap}>
      <div className={styles.accessCheck}>
        <div className={styles.accessStage}>
          <span className={styles.accessMark} aria-hidden="true" />
          <svg className={styles.accessRing} viewBox="0 0 100 100" aria-hidden="true">
            <circle className={styles.accessRingTrack} cx="50" cy="50" r="45" />
            <circle className={styles.accessRingArc} cx="50" cy="50" r="45" />
          </svg>
        </div>
        <p className={styles.accessVerb} key={verbIndex} role="status" aria-live="polite">
          {VERBS[verbIndex]}
          <span className={styles.accessDots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </p>
      </div>
    </div>
  )
}
