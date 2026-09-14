'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import styles from '../page.module.css'

function ResetForm() {
  const params = useSearchParams()
  const token = params.get('token') ?? ''
  const invite = params.get('invite') === '1'
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'done'>('idle')
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (password.length < 10) {
      setError('Password must be at least 10 characters')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setStatus('saving')
    try {
      const response = await fetch('/api/mail/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await response.json()
      if (data.ok) {
        setStatus('done')
      } else {
        setError(data.error ?? 'Could not reset password')
        setStatus('idle')
      }
    } catch {
      setError('Network error — try again')
      setStatus('idle')
    }
  }

  if (!token) {
    return (
      <div className={styles.loginCard}>
        <div className={styles.loginBrand}>
          <span className={styles.brandMark} role="img" aria-label="Metro Peril" />
          <h1 className={styles.loginTitle}>Reset link needed</h1>
        </div>
        <p className={styles.loginSub}>This page needs a reset token. Request a fresh link from the sign-in screen.</p>
        <Link className={styles.loginBtn} href="/mail" style={{ textAlign: 'center' }}>
          Back to sign in
        </Link>
      </div>
    )
  }

  if (status === 'done') {
    return (
      <div className={styles.loginCard}>
        <div className={styles.loginBrand}>
          <span className={styles.brandMark} role="img" aria-label="Metro Peril" />
          <h1 className={styles.loginTitle}>{invite ? "You're all set" : 'Password updated'}</h1>
        </div>
        <p className={styles.loginSub}>
          {invite ? 'Your mailbox is ready. Sign in with your new password.' : 'Your new password is set. Sign in with it now.'}
        </p>
        <Link className={styles.loginBtn} href="/mail" style={{ textAlign: 'center' }}>
          Go to sign in
        </Link>
      </div>
    )
  }

  return (
    <form className={styles.loginCard} onSubmit={submit}>
      <div className={styles.loginBrand}>
        <span className={styles.brandMark} role="img" aria-label="Metro Peril" />
        <h1 className={styles.loginTitle}>{invite ? 'Welcome to Metro Peril Mail' : 'Set a new password'}</h1>
      </div>
      <p className={styles.loginSub}>
        {invite ? 'Create a password to activate your mailbox and sign in.' : 'Choose a new password for your Metro Peril Mail account.'}
      </p>
      <label className={styles.loginField}>
        <span>New password</span>
        <div className={styles.pwWrap}>
          <input
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete="new-password"
            required
          />
          <button type="button" className={styles.pwToggle} onClick={() => setShowPassword(show => !show)}>
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </label>
      <label className={styles.loginField}>
        <span>Confirm password</span>
        <input
          type={showPassword ? 'text' : 'password'}
          value={confirm}
          onChange={event => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      {error && <p className={styles.loginError}>{error}</p>}
      <button type="submit" className={styles.loginBtn} disabled={status === 'saving'}>
        {status === 'saving' ? 'Saving…' : invite ? 'Create password' : 'Save password'}
      </button>
    </form>
  )
}

export default function ResetPage() {
  return (
    <div className={styles.loginWrap}>
      <Suspense fallback={<p className={styles.loginSub}>Loading…</p>}>
        <ResetForm />
      </Suspense>
    </div>
  )
}
