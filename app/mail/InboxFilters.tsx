'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './page.module.css'
import MailSelect from './MailSelect'
import { INBOX_FILTER_KINDS, normalizeInboxFilters, type InboxFilter, type InboxFilterKind } from '@/lib/inbox-filters'

const FILTER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
  </svg>
)

const labelOf = (kind: InboxFilterKind) => INBOX_FILTER_KINDS.find(option => option.kind === kind)?.label ?? kind

export default function InboxFilters({
  filters,
  counts,
  showing,
  onShowingChange,
  onFiltersChange,
}: {
  filters: InboxFilter[]
  counts: { total: number; unread: number } | null
  showing: boolean
  onShowingChange: (showing: boolean) => void
  onFiltersChange: (filters: InboxFilter[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<InboxFilterKind>('senderPrefix')
  const [value, setValue] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (wrapRef.current?.contains(target) || target.closest('[role="listbox"]')) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const total = counts?.total ?? 0
  const unread = counts?.unread ?? 0
  const placeholder = INBOX_FILTER_KINDS.find(option => option.kind === kind)?.placeholder ?? ''

  const addRule = () => {
    const next = normalizeInboxFilters([...filters, { kind, value }])
    if (next.length === filters.length) return
    onFiltersChange(next)
    setValue('')
  }

  const summary = total
    ? `${total.toLocaleString()} filtered out of your Inbox${unread ? `, ${unread.toLocaleString()} unread` : ''}`
    : 'Filtered out of your Inbox'

  return (
    <div className={styles.filterWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.filterChip} ${showing ? styles.filterChipOn : ''}`}
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-label={summary}
        title={summary}
      >
        {FILTER_ICON}
        <span className={styles.filterChipLabel}>Filtered</span>
        {total > 0 && (
          <span className={styles.filterChipCount}>
            {total.toLocaleString()}
            {unread > 0 && <span className={styles.filterChipUnread}>{unread.toLocaleString()} new</span>}
          </span>
        )}
      </button>
      {open && (
        <div className={styles.filterMenu} role="dialog" aria-label="Filtered out of your Inbox">
          <div className={styles.filterMenuHead}>
            <span>Filtered out of your Inbox</span>
            <span className={styles.filterMenuHint}>Matching mail skips the Inbox and never notifies. Nothing is deleted.</span>
          </div>
          <button
            type="button"
            className={styles.filterMenuView}
            onClick={() => {
              onShowingChange(!showing)
              setOpen(false)
            }}
          >
            {showing ? 'Back to Inbox' : 'Show filtered mail'}
            {!showing && total > 0 && (
              <span className={styles.filterChipCount}>
                {total.toLocaleString()}
                {unread > 0 && <span className={styles.filterChipUnread}>{unread.toLocaleString()} new</span>}
              </span>
            )}
          </button>
          <div className={styles.filterRules}>
            {filters.length === 0 && <div className={styles.filterEmpty}>No rules. Everything reaches your Inbox.</div>}
            {filters.map(filter => (
              <div key={`${filter.kind}:${filter.value}`} className={styles.filterRule}>
                <span className={styles.filterRuleKind}>{labelOf(filter.kind)}</span>
                <span className={styles.filterRuleValue}>{filter.value}</span>
                <button
                  type="button"
                  className={styles.filterRuleRemove}
                  aria-label={`Remove ${labelOf(filter.kind).toLowerCase()} ${filter.value}`}
                  onClick={() => onFiltersChange(filters.filter(entry => entry !== filter))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <form
            className={styles.filterAdd}
            onSubmit={event => {
              event.preventDefault()
              addRule()
            }}
          >
            <MailSelect
              value={kind}
              options={INBOX_FILTER_KINDS.map(option => ({ value: option.kind, label: option.label }))}
              ariaLabel="Rule type"
              buttonClassName={styles.filterAddKind}
              onChange={next => setKind(next as InboxFilterKind)}
            />
            <input
              className={styles.filterAddValue}
              value={value}
              placeholder={placeholder}
              aria-label="Rule value"
              onChange={event => setValue(event.target.value)}
            />
            <button type="submit" className={styles.filterAddBtn} disabled={!value.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
