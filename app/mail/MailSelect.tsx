'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './page.module.css'

export function anchoredMenuStyle(anchor: HTMLElement): React.CSSProperties {
  const rect = anchor.getBoundingClientRect()
  const base: React.CSSProperties = { position: 'fixed', left: rect.left, minWidth: rect.width }
  const openUpward = rect.bottom > window.innerHeight - 260
  return openUpward
    ? { ...base, bottom: window.innerHeight - rect.top + 6 }
    : { ...base, top: rect.bottom + 6 }
}

export const CHEVRON = (
  <svg className={styles.selectChevron} viewBox="0 0 12 8" fill="none" aria-hidden>
    <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export default function MailSelect({
  value,
  options,
  onChange,
  ariaLabel,
  buttonClassName,
  placeholder = 'Select',
  editable = false,
  optionStyle,
  prefix,
  compact = false,
  title,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  ariaLabel: string
  buttonClassName?: string
  placeholder?: string
  /** Typed values are accepted too: committed on Enter or when the field loses focus. */
  editable?: boolean
  optionStyle?: (value: string) => React.CSSProperties
  /** A quiet glyph before the value, so three selects in a row can be told apart. */
  prefix?: React.ReactNode
  /** Closed, show only the glyph; the value stays in the title and the menu. */
  compact?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const [typed, setTyped] = useState<string | null>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const anchorRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find(option => option.value === value)
  const toggle = () => {
    if (!open && anchorRef.current) setMenuStyle(anchoredMenuStyle(anchorRef.current))
    setOpen(prev => !prev)
  }
  const commitTyped = () => {
    if (typed !== null && typed !== (current?.label ?? value)) onChange(typed.trim())
    setTyped(null)
  }

  return (
    <span className={styles.select} ref={wrapRef}>
      {editable ? (
        <span ref={anchorRef as React.RefObject<HTMLSpanElement>} className={`${styles.selectBtn} ${styles.selectEditable} ${buttonClassName ?? ''}`} title={title}>
          {prefix && <span className={styles.selectGlyph} aria-hidden>{prefix}</span>}
          <input
            className={styles.selectInput}
            aria-label={ariaLabel}
            value={typed ?? current?.label ?? value}
            placeholder={placeholder}
            onFocus={() => { if (!open) toggle() }}
            onChange={event => setTyped(event.target.value)}
            onBlur={commitTyped}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitTyped()
                setOpen(false)
              }
            }}
          />
          <button type="button" className={styles.selectChevronBtn} aria-haspopup="listbox" aria-expanded={open} aria-label={`${ariaLabel} options`} onMouseDown={event => event.preventDefault()} onClick={toggle}>
            {CHEVRON}
          </button>
        </span>
      ) : (
        <button
          ref={anchorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          className={`${styles.selectBtn} ${buttonClassName ?? ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={compact ? `${ariaLabel}: ${current?.label ?? placeholder}` : ariaLabel}
          title={title ?? (compact ? `${ariaLabel}: ${current?.label ?? placeholder}` : undefined)}
          onClick={toggle}
        >
          {prefix && <span className={styles.selectGlyph} aria-hidden>{prefix}</span>}
          {!compact && <span style={optionStyle && current?.value ? optionStyle(current.value) : undefined}>{current?.label ?? placeholder}</span>}
          {CHEVRON}
        </button>
      )}
      {open && (
        <div className={styles.selectMenu} style={menuStyle} role="listbox">
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`${styles.selectOption} ${option.value === value ? styles.selectOptionOn : ''}`}
              style={optionStyle ? optionStyle(option.value) : undefined}
              onMouseDown={event => event.preventDefault()}
              onClick={() => {
                setTyped(null)
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
