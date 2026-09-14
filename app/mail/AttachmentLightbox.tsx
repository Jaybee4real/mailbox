'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './page.module.css'

export type PreviewItem = { filename: string; url: string; size?: number; contentType?: string }

export type AttachmentKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'other'

/**
 * The extension decides, and the declared type answers when it cannot: a file saved as
 * `scan` or `Document (1)` still previews if the sender said what it was.
 */
export function attachmentKind(filename: string, contentType?: string): AttachmentKind {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'tif', 'tiff'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv', '3gp'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'oga'].includes(ext)) return 'audio'
  if (['txt', 'csv', 'tsv', 'json', 'xml', 'md', 'log', 'yml', 'yaml', 'ics', 'ini', 'conf', 'sql', 'srt', 'vtt'].includes(ext)) {
    return 'text'
  }

  const type = (contentType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') return 'text'
  return 'other'
}

/**
 * The same URL serves the preview and the download button, and it defaults to telling the
 * browser to save. Anything rendered here asks for the inline form instead, or a PDF opens
 * the save dialog the moment the viewer appears.
 */
function inlineUrl(url: string): string {
  if (!url.startsWith('/api/mail/')) return url
  return `${url}${url.includes('?') ? '&' : '?'}inline=1`
}

export function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ZOOM_STEP = 0.25
const ZOOM_MIN = 0.25
const ZOOM_MAX = 6

export default function AttachmentLightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: PreviewItem[]
  index: number
  onIndex: (next: number) => void
  onClose: () => void
}) {
  const item = items[index]
  const kind = item ? attachmentKind(item.filename, item.contentType) : 'other'
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [textBody, setTextBody] = useState<string | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setRotation(0)
    setOffset({ x: 0, y: 0 })
  }, [])

  // Adjusting state during render when the prop changes, rather than in an effect,
  // so the old zoom and text never paint against the new item.
  const [seenItem, setSeenItem] = useState(item)
  if (item !== seenItem) {
    setSeenItem(item)
    reset()
    setTextBody(null)
  }

  useEffect(() => {
    if (!item || attachmentKind(item.filename) !== 'text') return
    let stale = false
    fetch(item.url)
      .then(response => response.text())
      .then(body => {
        if (!stale) setTextBody(body.slice(0, 200_000))
      })
      .catch(() => {
        if (!stale) setTextBody('(could not load preview)')
      })
    return () => {
      stale = true
    }
  }, [item])

  const step = useCallback((delta: number) => setZoom(current => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current + delta))), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && items.length > 1) onIndex((index + 1) % items.length)
      else if (event.key === 'ArrowLeft' && items.length > 1) onIndex((index - 1 + items.length) % items.length)
      else if (event.key === '+' || event.key === '=') step(ZOOM_STEP)
      else if (event.key === '-') step(-ZOOM_STEP)
      else if (event.key === '0') reset()
      else if (event.key.toLowerCase() === 'r') setRotation(current => (current + 90) % 360)
      else if (event.key.toLowerCase() === 'f') {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else shellRef.current?.requestFullscreen?.().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, onClose, onIndex, step, reset])

  if (!item) return null

  const onPointerDown = (event: React.PointerEvent) => {
    if (kind !== 'image' || zoom <= 1) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setOffset({ x: drag.ox + (event.clientX - drag.x), y: drag.oy + (event.clientY - drag.y) })
  }
  const onPointerUp = () => {
    dragRef.current = null
  }

  const body = (() => {
    if (kind === 'image') {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.lbImage}
          src={item.url}
          alt={item.filename}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom}) rotate(${rotation}deg)`,
            cursor: zoom > 1 ? 'grab' : 'default',
          }}
        />
      )
    }
    if (kind === 'pdf') return <iframe className={styles.lbFrame} src={inlineUrl(item.url)} title={item.filename} />
    if (kind === 'video') return <video className={styles.lbMedia} src={inlineUrl(item.url)} controls autoPlay={false} />
    if (kind === 'audio') return <audio className={styles.lbAudio} src={inlineUrl(item.url)} controls />
    if (kind === 'text') return <pre className={styles.lbText}>{textBody ?? 'Loading…'}</pre>
    // Nothing here can render a spreadsheet or a Word file, but the browser may be able
    // to, and opening it is a different action from saving it.
    return (
      <div className={styles.lbFallback}>
        <p>This file can&apos;t be shown here.</p>
        <a className={styles.lbDownload} href={inlineUrl(item.url)} target="_blank" rel="noopener noreferrer">
          Open in a new tab
        </a>
        <a className={styles.lbDownloadAlt} href={item.url} target="_blank" rel="noopener noreferrer">
          Download {item.filename}
        </a>
      </div>
    )
  })()

  return (
    <div className={styles.lbScrim} onClick={onClose} role="dialog" aria-modal="true" aria-label={item.filename}>
      <div className={styles.lbShell} ref={shellRef} onClick={event => event.stopPropagation()}>
        <div className={styles.lbBar}>
          <div className={styles.lbTitle}>
            <span className={styles.lbName} title={item.filename}>{item.filename}</span>
            {item.size ? <span className={styles.lbSize}>{formatSize(item.size)}</span> : null}
            {items.length > 1 && <span className={styles.lbCount}>{index + 1} / {items.length}</span>}
          </div>
          <div className={styles.lbTools}>
            {kind === 'image' && (
              <>
                <button onClick={() => step(-ZOOM_STEP)} title="Zoom out (−)" aria-label="Zoom out">−</button>
                <button onClick={() => step(ZOOM_STEP)} title="Zoom in (+)" aria-label="Zoom in">+</button>
                <button onClick={reset} title="Reset (0)" aria-label="Reset zoom">{Math.round(zoom * 100)}%</button>
                <button onClick={() => setRotation(current => (current + 90) % 360)} title="Rotate (R)" aria-label="Rotate">⟳</button>
              </>
            )}
            <button
              onClick={() => {
                if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
                else shellRef.current?.requestFullscreen?.().catch(() => {})
              }}
              title="Fullscreen (F)"
              aria-label="Fullscreen"
            >
              ⛶
            </button>
            <a href={item.url} target="_blank" rel="noopener noreferrer" title="Download" aria-label="Download">↓</a>
            <button onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
          </div>
        </div>
        <div
          className={`${styles.lbStage} ${kind === 'image' ? styles.lbStagePan : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={event => {
            if (kind === 'image' && (event.ctrlKey || event.metaKey)) step(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
          }}
        >
          {items.length > 1 && (
            <button
              className={`${styles.lbNav} ${styles.lbPrev}`}
              onClick={() => onIndex((index - 1 + items.length) % items.length)}
              aria-label="Previous attachment"
            >
              ‹
            </button>
          )}
          {body}
          {items.length > 1 && (
            <button
              className={`${styles.lbNav} ${styles.lbNext}`}
              onClick={() => onIndex((index + 1) % items.length)}
              aria-label="Next attachment"
            >
              ›
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
