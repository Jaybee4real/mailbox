'use client'

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import { WebAuthnAbortService, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser'
import styles from './page.module.css'
import { readPause, type Pause } from './pause'

type Props = {
  onSignedIn: (email: string) => void
  onError: (message: string) => void
  onPaused?: (pause: Pause) => void
  disabled?: boolean
}

class PausedError extends Error {
  pause: Pause
  constructor(pause: Pause) {
    super(pause.message || 'Too many attempts. Try again shortly.')
    this.pause = pause
  }
}

const pausedBy = (response: Response, body: unknown) => {
  const pause = readPause(response.status, response.headers.get('retry-after'), body)
  if (pause) throw new PausedError(pause)
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function signInWithPasskey(useBrowserAutofill: boolean): Promise<string> {
  const started = await fetch('/api/mail/login/passkey/options', { method: 'POST', headers: JSON_HEADERS, body: '{}' })
  const options = await started.json().catch(() => ({}))
  pausedBy(started, options)
  if (!options.ok) throw new Error(options.error || 'Passkeys are not available right now. Try again in a moment.')
  const response = await startAuthentication({ optionsJSON: options.options, useBrowserAutofill })
  const finished = await fetch('/api/mail/login/passkey', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ challenge: options.challenge, response }),
  })
  const data = await finished.json().catch(() => ({}))
  pausedBy(finished, data)
  if (!data.ok || typeof data.email !== 'string') throw new Error(data.error || 'That passkey could not sign you in.')
  return data.email
}

const subscribeNever = () => () => {}

const cancelled = (error: unknown) => error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')

export default function PasskeySignIn({ onSignedIn, onError, onPaused, disabled }: Props) {
  const supported = useSyncExternalStore(subscribeNever, browserSupportsWebAuthn, () => false)
  const [busy, setBusy] = useState(false)
  const signedIn = useEffectEvent((email: string) => onSignedIn(email))
  const failed = useEffectEvent((error: unknown) => {
    if (error instanceof PausedError && onPaused) onPaused(error.pause)
    else if (!cancelled(error)) onError(error instanceof Error ? error.message : String(error))
  })

  useEffect(() => {
    if (!supported) return
    let alive = true
    void browserSupportsWebAuthnAutofill().then(autofill => {
      if (!autofill || !alive) return
      signInWithPasskey(true)
        .then(email => alive && signedIn(email))
        .catch(error => alive && failed(error))
    })
    return () => {
      alive = false
      WebAuthnAbortService.cancelCeremony()
    }
  }, [supported])

  if (!supported) return null
  return (
    <>
      <div className={styles.loginOr} aria-hidden="true"><span>or</span></div>
      <button
        type="button"
        className={styles.loginPasskeyBtn}
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true)
          try {
            onSignedIn(await signInWithPasskey(false))
          } catch (error) {
            if (error instanceof PausedError && onPaused) onPaused(error.pause)
            else if (!cancelled(error)) onError(error instanceof Error ? error.message : 'That passkey could not sign you in.')
          } finally {
            setBusy(false)
          }
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m10.7 12.3 8.6-8.6" />
          <path d="m17 6 2.5 2.5" />
          <path d="m14.5 8.5 2.5 2.5" />
        </svg>
        {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </button>
    </>
  )
}
