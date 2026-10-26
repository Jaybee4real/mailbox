'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { startRegistration } from '@simplewebauthn/browser'
import { useConfirm } from './ConfirmDialog'
import { usePasskeyDevice } from './passkey-support'
import styles from './page.module.css'

type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null; synced: boolean }

const JSON_HEADERS = { 'Content-Type': 'application/json' }

function deviceLabel(): string {
  const agent = navigator.userAgent
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser'
  const system = /iPhone|iPad/.test(agent) ? 'iPhone' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : ''
  return system ? `${browser} on ${system}` : browser
}

type PasskeyList = { passkeys: Passkey[]; needsPassword: boolean }

async function fetchPasskeys(): Promise<PasskeyList | null> {
  const response = await fetch('/api/mail/passkeys', { cache: 'no-store' }).catch(() => null)
  const data = await response?.json().catch(() => null)
  return data?.ok ? { passkeys: data.passkeys, needsPassword: Boolean(data.needsPassword) } : null
}

const dateLabel = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

type Props = {
  addRequest?: number
  onCount?: (count: number) => void
}

export default function PasskeySettings({ addRequest = 0, onCount }: Props) {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null)
  const [needsPassword, setNeedsPassword] = useState(true)
  const [adding, setAdding] = useState(false)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null)
  const supported = usePasskeyDevice()
  const confirm = useConfirm()
  const sectionRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const apply = useCallback((data: PasskeyList | null) => {
    if (!data) return
    setPasskeys(data.passkeys)
    setNeedsPassword(data.needsPassword)
    onCount?.(data.passkeys.length)
  }, [onCount])
  const load = useCallback(async () => apply(await fetchPasskeys()), [apply])

  useEffect(() => {
    let alive = true
    void fetchPasskeys().then(data => alive && apply(data))
    return () => {
      alive = false
    }
  }, [apply])

  useEffect(() => {
    if (!addRequest || !supported) return
    const opening = window.setTimeout(() => {
      setAdding(true)
      setMessage(null)
    }, 0)
    const settling = window.setTimeout(() => {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      firstFieldRef.current?.focus({ preventScroll: true })
    }, 420)
    return () => {
      window.clearTimeout(opening)
      window.clearTimeout(settling)
    }
  }, [addRequest, supported])

  const add = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const started = await fetch('/api/mail/passkeys/options', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ password }) })
      const options = await started.json().catch(() => ({}))
      if (!options.ok) throw new Error(options.error || 'Passkeys are not available right now.')
      const response = await startRegistration({ optionsJSON: options.options })
      const saved = await fetch('/api/mail/passkeys', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ challenge: options.challenge, response, name: name.trim() || deviceLabel() }),
      })
      const data = await saved.json().catch(() => ({}))
      if (!data.ok) throw new Error(data.error || 'That passkey could not be added.')
      setAdding(false)
      setPassword('')
      setName('')
      setMessage({ text: 'Passkey added. Next time, sign in with it instead of your password.', bad: false })
      await load()
    } catch (error) {
      const declined = error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')
      setMessage({ text: declined ? 'No passkey was added.' : error instanceof Error ? error.message : 'That passkey could not be added.', bad: !declined })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (passkey: Passkey) => {
    const agreed = await confirm({
      title: 'Remove this passkey?',
      body: <><strong>{passkey.name}</strong> will stop signing you in. You can add it again later.</>,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!agreed) return
    setBusy(true)
    setMessage(null)
    const response = await fetch('/api/mail/passkeys', { method: 'DELETE', headers: JSON_HEADERS, body: JSON.stringify({ id: passkey.id }) }).catch(() => null)
    const data = await response?.json().catch(() => null)
    setBusy(false)
    if (!data?.ok) setMessage({ text: data?.error || 'That passkey could not be removed.', bad: true })
    await load()
  }

  return (
    <div className={styles.securitySection} ref={sectionRef}>
      <p className={styles.pwHeading}>Passkeys</p>
      <p className={styles.settingsProse}>
        Sign in with Face ID, Touch ID, a fingerprint or your device PIN instead of your password. A passkey also counts as
        two-step sign-in, and it only works on this mailbox&apos;s own website and the Vela Mail app, so it cannot be phished.
      </p>

      {passkeys?.map(passkey => (
        <div key={passkey.id} className={styles.factorRow}>
          <div className={styles.factorText}>
            <span className={styles.factorName}>{passkey.name}</span>
            <span className={styles.settingsNote}>
              Added {dateLabel(passkey.createdAt)}
              {passkey.lastUsedAt ? ` · last used ${dateLabel(passkey.lastUsedAt)}` : ' · not used yet'}
              {passkey.synced ? ' · synced' : ''}
            </span>
          </div>
          <button type="button" className={styles.linkBtn} disabled={busy} onClick={() => void remove(passkey)}>Remove</button>
        </div>
      ))}
      {passkeys?.length === 0 && <p className={styles.settingsNote}>No passkeys yet.</p>}

      {supported === null ? null : !supported ? (
        <p className={styles.settingsNote}>
          This device cannot hold a passkey. It needs Face ID, Touch ID, Windows Hello, a fingerprint reader or a screen
          lock in a browser such as Safari, Chrome or Edge. You can add one from your phone or in the Vela Mail app.
        </p>
      ) : adding ? (
        <div className={styles.factorSetup}>
          <label className={styles.settingsField}>
            <span>Name</span>
            <input value={name} onChange={event => setName(event.target.value)} placeholder={deviceLabel()} maxLength={60} />
          </label>
          {needsPassword && (
            <label className={styles.settingsField}>
              <span>Your password</span>
              <input ref={firstFieldRef} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
            </label>
          )}
          <div className={styles.factorActions}>
            <button type="button" className={styles.pwSubmit} disabled={busy || (needsPassword && !password)} onClick={() => void add()}>
              {busy ? 'Waiting for your device…' : 'Create passkey'}
            </button>
            <button type="button" className={styles.linkBtn} onClick={() => { setAdding(false); setPassword(''); setMessage(null) }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className={styles.pwSubmit} disabled={busy} onClick={() => { setAdding(true); setMessage(null) }}>
          Add a passkey
        </button>
      )}
      {message && (
        <p className={`${styles.settingsNote} ${message.bad ? styles.msgBad : ''}`} role={message.bad ? 'alert' : 'status'}>{message.text}</p>
      )}
    </div>
  )
}
