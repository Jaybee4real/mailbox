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
  /** Asks for a value as well, replacing window.prompt. */
  field?: { label: string; type?: 'text' | 'password'; placeholder?: string; initial?: string }
}

type Settled = { ok: boolean; value: string }
type Pending = ConfirmRequest & { resolve: (value: Settled) => void }

const ConfirmContext = createContext<(request: ConfirmRequest) => Promise<Settled>>(async () => ({ ok: false, value: '' }))

/** Replaces window.confirm, which cannot be styled and looks like the browser, not the app. */
export function useConfirm() {
  const ask = useContext(ConfirmContext)
  return useCallback(async (request: ConfirmRequest) => (await ask(request)).ok, [ask])
}

/** Replaces window.prompt. Resolves to null when dismissed, so a blank answer stays meaningful. */
export function usePrompt() {
  const ask = useContext(ConfirmContext)
  return useCallback(
    async (request: ConfirmRequest & { field: NonNullable<ConfirmRequest['field']> }) => {
      const settled = await ask(request)
      return settled.ok ? settled.value : null
    },
    [ask],
  )
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)

  const confirm = useCallback(
    (request: ConfirmRequest) => new Promise<Settled>(resolve => {
      setDraft(request.field?.initial ?? '')
      setReveal(false)
      setPending({ ...request, resolve })
    }),
    [],
  )

  const settle = useCallback(
    (ok: boolean) => {
      setPending(current => {
        current?.resolve({ ok, value: draft })
        return null
      })
    },
    [draft],
  )

  // Escape cancels and Enter confirms, matching what the native dialog did.
  useEffect(() => {
    if (!pending) return
    if (pending.field) fieldRef.current?.focus()
    else confirmRef.current?.focus()
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
            {pending.field && (
              <label className={styles.confirmField}>
                <span>{pending.field.label}</span>
                <div className={styles.pwWrap}>
                  <input
                    ref={fieldRef}
                    className={styles.confirmInput}
                    type={pending.field.type === 'password' && !reveal ? 'password' : 'text'}
                    autoComplete={pending.field.type === 'password' ? 'new-password' : 'off'}
                    placeholder={pending.field.placeholder}
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                  />
                  {pending.field.type === 'password' && (
                    <button type="button" className={styles.pwToggle} onClick={() => setReveal(show => !show)}>
                      {reveal ? 'Hide' : 'Show'}
                    </button>
                  )}
                </div>
              </label>
            )}
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
