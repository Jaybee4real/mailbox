'use client'

import { CLIENT_BRAND } from '@/lib/brand.client'
import { use, useCallback, useEffect, useState } from 'react'
import styles from './share.module.css'

const brandStyle = { '--brand-accent': CLIENT_BRAND.accent } as React.CSSProperties

type ViewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text'

type Meta = {
  filename: string
  size: number
  contentType: string | null
  needsPassword: boolean
  expiresAt: string | null
  availableAt: string | null
  pending: boolean
  canView: boolean
  canDownload: boolean
  viewKind: ViewKind | null
  downloadsLeft: number | null
  viewsLeft: number | null
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

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days) return `${plural(days, 'day')}, ${plural(hours, 'hour')}`
  if (hours) return `${plural(hours, 'hour')}, ${plural(minutes, 'minute')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const longDate = (iso: string, withTime: boolean) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  })

export default function SharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [gone, setGone] = useState(false)
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'view' | 'download' | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [viewer, setViewer] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Kept so a reader whose browser refuses the scripted download still has a plain link.
  const [fallback, setFallback] = useState('')

  const loadMeta = useCallback(() => {
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

  useEffect(() => loadMeta(), [loadMeta])

  const opensAt = meta?.pending && meta.availableAt ? new Date(meta.availableAt).getTime() : null
  useEffect(() => {
    if (!opensAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [opensAt])
  useEffect(() => {
    if (opensAt && now >= opensAt) loadMeta()
  }, [now, opensAt, loadMeta])

  const claim = useCallback(
    async (mode: 'view' | 'download') => {
      setBusy(mode)
      setError('')
      try {
        const response = await fetch(`/api/share/${id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, mode }),
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data?.ok) {
          setError(data?.error ?? 'That did not work.')
          return
        }
        if (mode === 'view') {
          setViewer(data.url)
          setMeta(current => (current && current.viewsLeft != null ? { ...current, viewsLeft: current.viewsLeft - 1 } : current))
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
        setMeta(current => (current && current.downloadsLeft != null ? { ...current, downloadsLeft: current.downloadsLeft - 1 } : current))
        // An anchor carrying `download`, not a navigation. Pointing location at a response
        // marked as an attachment is supposed to save it and stay put, and often simply does
        // nothing instead — no download, no error, no way to tell. The anchor is the path
        // browsers actually honour for a same-origin file, and it never leaves the page.
        setFallback(data.url)
        const link = document.createElement('a')
        link.href = data.url
        link.download = data.filename ?? ''
        link.rel = 'noopener'
        document.body.appendChild(link)
        link.click()
        // Removed on a later tick, never in the same one. Chromium starts the download from
        // the live element, and tearing it out synchronously cancels the fetch before it
        // begins — which looks exactly like a button that does nothing.
        window.setTimeout(() => link.remove(), 2000)
      } catch {
        setError('Could not reach the server. Try again.')
      } finally {
        setBusy(null)
      }
    },
    [id, password],
  )

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

  const viewOnly = meta.canView && !meta.canDownload
  const limits = [
    meta.viewsLeft != null && meta.canView ? `${plural(meta.viewsLeft, 'view')} left` : '',
    meta.downloadsLeft != null && meta.canDownload ? `${plural(meta.downloadsLeft, 'download')} left` : '',
  ].filter(Boolean)
  const blockSave = viewOnly ? (event: React.SyntheticEvent) => event.preventDefault() : undefined

  return (
    <main className={styles.wrap} style={brandStyle}>
      <div className={`${styles.card} ${viewer ? styles.cardWide : ''}`}>
        <span className={styles.mark} aria-hidden />
        <p className={styles.eyebrow}>{CLIENT_BRAND.legalName}</p>
        <h1 className={styles.title}>{meta.filename}</h1>
        <p className={styles.meta}>
          {kindOf(meta.filename, meta.contentType)} · {readableSize(meta.size)}
          {limits.map(limit => ` · ${limit}`)}
          {viewOnly ? ' · view only' : ''}
        </p>

        {meta.pending && meta.availableAt ? (
          <div className={styles.pending}>
            <p className={styles.pendingLabel}>Opens on {longDate(meta.availableAt, true)}</p>
            {opensAt && <p className={styles.pendingCount}>{countdown(opensAt - now)}</p>}
          </div>
        ) : viewer && meta.viewKind ? (
          <div className={styles.viewer} onContextMenu={blockSave}>
            {meta.viewKind === 'image' && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={viewer} alt={meta.filename} draggable={!viewOnly} onDragStart={blockSave} />
            )}
            {meta.viewKind === 'pdf' && <iframe src={viewOnly ? `${viewer}#toolbar=0` : viewer} title={meta.filename} />}
            {meta.viewKind === 'text' && <iframe src={viewer} title={meta.filename} />}
            {meta.viewKind === 'video' && (
              <video src={viewer} controls autoPlay playsInline disablePictureInPicture={viewOnly} controlsList={viewOnly ? 'nodownload' : undefined} />
            )}
            {meta.viewKind === 'audio' && <audio src={viewer} controls autoPlay controlsList={viewOnly ? 'nodownload' : undefined} />}
          </div>
        ) : (
          meta.needsPassword &&
          !done && (
            <label className={styles.field}>
              <span>Password</span>
              <div className={styles.pwWrap}>
                <input
                  type={reveal ? 'text' : 'password'}
                  value={password}
                  autoFocus
                  placeholder="The password you were given"
                  onChange={event => setPassword(event.target.value)}
                  onKeyDown={event => event.key === 'Enter' && password && claim(meta.canView ? 'view' : 'download')}
                />
                <button type="button" className={styles.pwToggle} onClick={() => setReveal(show => !show)}>
                  {reveal ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
          )
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}
        {fallback && (
          <p className={styles.error}>
            Or <a href={fallback} download>open the file directly</a>.
          </p>
        )}

        {!meta.pending && (
          <div className={styles.actions}>
            {meta.canView && !viewer && (
              <button
                type="button"
                className={styles.go}
                disabled={busy !== null || (meta.needsPassword && !password)}
                onClick={() => claim('view')}
              >
                {busy === 'view' ? 'Opening…' : 'View'}
              </button>
            )}
            {meta.canDownload && (
              <button
                type="button"
                className={meta.canView && !viewer ? styles.ghost : styles.go}
                disabled={busy !== null || done || (meta.needsPassword && !password)}
                onClick={() => claim('download')}
              >
                {done ? 'Starting download…' : busy === 'download' ? 'Checking…' : 'Download'}
              </button>
            )}
          </div>
        )}

        {meta.expiresAt && <p className={styles.foot}>Available until {longDate(meta.expiresAt, false)}</p>}
      </div>
    </main>
  )
}
