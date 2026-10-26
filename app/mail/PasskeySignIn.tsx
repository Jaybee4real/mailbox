'use client'

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react'
import { WebAuthnAbortService, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication } from '@simplewebauthn/browser'
import styles from './page.module.css'

type Props = {
  onSignedIn: (email: string) => void
  onError: (message: string) => void
  disabled?: boolean
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function signInWithPasskey(useBrowserAutofill: boolean): Promise<string> {
  const started = await fetch('/api/mail/login/passkey/options', { method: 'POST', headers: JSON_HEADERS, body: '{}' })
  const options = await started.json().catch(() => ({}))
  if (!options.ok) throw new Error(options.error || 'Passkeys are not available right now. Try again in a moment.')
  const response = await startAuthentication({ optionsJSON: options.options, useBrowserAutofill })
  const finished = await fetch('/api/mail/login/passkey', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ challenge: options.challenge, response }),
  })
  const data = await finished.json().catch(() => ({}))
  if (!data.ok || typeof data.email !== 'string') throw new Error(data.error || 'That passkey could not sign you in.')
  return data.email
}

const subscribeNever = () => () => {}

const cancelled = (error: unknown) => error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')

export default function PasskeySignIn({ onSignedIn, onError, disabled }: Props) {
  const supported = useSyncExternalStore(subscribeNever, browserSupportsWebAuthn, () => false)
  const [busy, setBusy] = useState(false)
  const signedIn = useEffectEvent((email: string) => onSignedIn(email))
  const failed = useEffectEvent((error: unknown) => {
    if (!cancelled(error)) onError(error instanceof Error ? error.message : String(error))
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
    <button
      type="button"
      className={styles.loginPasskeyBtn}
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true)
        try {
          onSignedIn(await signInWithPasskey(false))
        } catch (error) {
          if (!cancelled(error)) onError(error instanceof Error ? error.message : 'That passkey could not sign you in.')
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
    </button>
  )
}
