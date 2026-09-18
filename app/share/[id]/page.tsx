'use client'

import { CLIENT_BRAND } from '@/lib/brand.client'
import { use, useCallback, useEffect, useState } from 'react'
import styles from './share.module.css'

const brandStyle = { '--brand-accent': CLIENT_BRAND.accent } as React.CSSProperties

type Meta = {
  filename: string
  size: number
  contentType: string | null
  needsPassword: boolean
  expiresAt: string | null
  downloadsLeft: number | null
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Enough of a hint to set expectations before the file opens. */
function kindOf(filename: string, contentType: string | null): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  if (/^(jpg|jpeg|png|gif|webp|avif|heic|svg)$/.test(extension)) return 'Image'
  if (/^(mp4|mov|webm|mkv|avi)$/.test(extension)) return 'Video'
  if (/^(mp3|wav|m4a|aac|flac|ogg)$/.test(extension)) return 'Audio'
  if (extension === 'pdf') return 'PDF'
  if (/^(zip|rar|7z|tar|gz)$/.test(extension)) return 'Archive'
  if (/^(doc|docx|rtf|odt)$/.test(extension)) return 'Document'
  if (/^(xls|xlsx|csv|ods)$/.test(extension)) return 'Spreadsheet'
  if (/^(ppt|pptx|key|odp)$/.test(extension)) return 'Presentation'
  return contentType?.split('/')[0] ? `${contentType.split('/')[0]} file` : 'File'
}

export default function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [gone, setGone] = useState(false)
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/share/${id}`)
      .then(async response => {
        const data = await response.json().catch(() => null)
        if (cancelled) return
        if (!response.ok || !data?.ok) setGone(true)
        else setMeta(data)
      })
      .catch(() => !cancelled && setGone(true))
    return () => {
      cancelled = true
    }
  }, [id])

  const claim = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/share/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? 'That did not work.')
        return
      }
      // Ask for the headers first. A download that cannot start otherwise leaves this page
      // sitting on "Starting download…" for ever, because navigating away and failing
      // reports nothing back — which is indistinguishable from a dead button.
      try {
        const ready = await fetch(data.url, { method: 'HEAD' })
        if (!ready.ok) {
          const reason = await ready.json().catch(() => null)
          setError(reason?.error ?? 'That file could not be fetched. Ask the sender for a fresh link.')
          return
        }
      } catch {
        setError('Could not reach the file. Check your connection and try again.')
        return
      }
      setDone(true)
      // An anchor carrying `download`, not a navigation. Pointing location at a response
      // marked as an attachment is supposed to save it and stay put, and often simply does
      // nothing instead — no download, no error, no way to tell. The anchor is the path
      // browsers actually honour for a same-origin file, and it never leaves the page.
      const link = document.createElement('a')
      link.href = data.url
      link.download = data.filename ?? ''
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }, [id, password])

  // The browser gives no signal that a download began, so if this page is still here and
  // still saying so a while later, say plainly that it may not have worked.
  useEffect(() => {
    if (!done) return
    const timer = window.setTimeout(() => {
      setError('If nothing has downloaded, your network may be blocking it. Tell the sender.')
      setDone(false)
    }, 20000)
    return () => window.clearTimeout(timer)
  }, [done])

  if (gone) {
    return (
      <main className={styles.wrap} style={brandStyle}>
        <div className={styles.card}>
          <span className={styles.mark} aria-hidden />
          <h1 className={styles.title}>This link is no longer available</h1>
          <p className={styles.sub}>
            It may have expired, been used its allowed number of times, or been withdrawn by
            whoever sent it. Ask them for a new one.
          </p>
        </div>
      </main>
    )
  }

  if (!meta) {
    return (
      <main className={styles.wrap} style={brandStyle}>
        <div className={styles.card}>
          <span className={styles.skelMark} />
          <span className={styles.skelLine} />
          <span className={styles.skelLineShort} />
        </div>
      </main>
    )
  }

  return (
    <main className={styles.wrap} style={brandStyle}>
      <div className={styles.card}>
        <span className={styles.mark} aria-hidden />
        <p className={styles.eyebrow}>{CLIENT_BRAND.legalName}</p>
        <h1 className={styles.title}>{meta.filename}</h1>
        <p className={styles.meta}>
          {kindOf(meta.filename, meta.contentType)} · {readableSize(meta.size)}
          {meta.downloadsLeft != null && ` · ${meta.downloadsLeft} download${meta.downloadsLeft === 1 ? '' : 's'} left`}
        </p>

        {meta.needsPassword && !done && (
          <label className={styles.field}>
            <span>Password</span>
            <div className={styles.pwWrap}>
              <input
                type={reveal ? 'text' : 'password'}
                value={password}
                autoFocus
                placeholder="The password you were given"
                onChange={event => setPassword(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && password && claim()}
              />
              <button type="button" className={styles.pwToggle} onClick={() => setReveal(show => !show)}>
                {reveal ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <button
          type="button"
          className={styles.go}
          disabled={busy || done || (meta.needsPassword && !password)}
          onClick={claim}
        >
          {done ? 'Starting download…' : busy ? 'Checking…' : 'Download'}
        </button>

        {meta.expiresAt && (
          <p className={styles.foot}>
            Available until {new Date(meta.expiresAt).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </p>
        )}
      </div>
    </main>
  )
}
