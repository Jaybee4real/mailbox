'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import styles from './page.module.css'

export type ConfirmRequest = {
  title: string
  body?: ReactNode
  /** Defaults to "Continue". */
  confirmLabel?: string
  cancelLabel?: string
  /** Paints the confirm button as destructive. */
  danger?: boolean
}

type Pending = ConfirmRequest & { resolve: (value: boolean) => void }

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<boolean>>(async () => false)

/** Replaces window.confirm, which cannot be styled and looks like the browser, not the app. */
export function useConfirm() {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback(
    (request: ConfirmRequest) => new Promise<boolean>(resolve => setPending({ ...request, resolve })),
    [],
  )

  const settle = useCallback(
    (value: boolean) => {
      setPending(current => {
        current?.resolve(value)
        return null
      })
    },
    [],
  )

  // Escape cancels and Enter confirms, matching what the native dialog did.
  useEffect(() => {
    if (!pending) return
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); settle(false) }
      if (event.key === 'Enter') { event.preventDefault(); settle(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, settle])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className={styles.confirmScrim} onClick={() => settle(false)}>
          <div
            className={styles.confirmCard}
            role="alertdialog"
            aria-modal="true"
            aria-label={pending.title}
            onClick={event => event.stopPropagation()}
          >
            <p className={styles.confirmTitle}>{pending.title}</p>
            {pending.body && <div className={styles.confirmBody}>{pending.body}</div>}
            <div className={styles.confirmActions}>
              <button type="button" className={styles.confirmCancel} onClick={() => settle(false)}>
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={confirmRef}
                type="button"
                className={`${styles.confirmGo} ${pending.danger ? styles.confirmDanger : ''}`}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? 'Continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
