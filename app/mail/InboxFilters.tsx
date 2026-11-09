'use client'

import { useEffect, useRef, useState } from 'react'
import styles from './page.module.css'
import MailSelect from './MailSelect'
import { INBOX_FILTER_KINDS, LIST_SHOWS, normalizeInboxFilters, type InboxFilter, type InboxFilterKind, type ListShow } from '@/lib/inbox-filters'

const FILTER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
  </svg>
)

const labelOf = (kind: InboxFilterKind) => INBOX_FILTER_KINDS.find(option => option.kind === kind)?.label ?? kind

/** One rule-adding row; the Advanced section has its own, so a rule lands where it was added. */
function AddRule({ advanced, onAdd }: { advanced: boolean; onAdd: (rule: InboxFilter) => boolean }) {
  const [kind, setKind] = useState<InboxFilterKind>('senderPrefix')
  const [value, setValue] = useState('')
  const placeholder = INBOX_FILTER_KINDS.find(option => option.kind === kind)?.placeholder ?? ''
  return (
    <form
      className={styles.filterAdd}
      onSubmit={event => {
        event.preventDefault()
        if (onAdd(advanced ? { kind, value, advanced } : { kind, value })) setValue('')
      }}
    >
      <MailSelect
        value={kind}
        options={INBOX_FILTER_KINDS.map(option => ({ value: option.kind, label: option.label }))}
        ariaLabel={advanced ? 'Advanced rule type' : 'Rule type'}
        buttonClassName={styles.filterAddKind}
        onChange={next => setKind(next as InboxFilterKind)}
      />
      <input
        className={styles.filterAddValue}
        value={value}
        placeholder={placeholder}
        aria-label={advanced ? 'Advanced rule value' : 'Rule value'}
        onChange={event => setValue(event.target.value)}
      />
      <button type="submit" className={styles.filterAddBtn} disabled={!value.trim()}>
        Add
      </button>
    </form>
  )
}

export default function InboxFilters({
  filters,
  counts,
  showing,
  onShowingChange,
  onFiltersChange,
  show,
  onShowChange,
}: {
  filters: InboxFilter[]
  counts: { total: number; unread: number } | null
  showing: boolean
  onShowingChange: (showing: boolean) => void
  onFiltersChange: (filters: InboxFilter[]) => void
  show: ListShow
  onShowChange: (show: ListShow) => void
}) {
  const [open, setOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
  const ordinary = filters.filter(filter => !filter.advanced)
  const advanced = filters.filter(filter => filter.advanced)
  const showLabel = LIST_SHOWS.find(option => option.show === show)?.label ?? 'All'

  const addRule = (rule: InboxFilter) => {
    const next = normalizeInboxFilters([...filters, rule])
    if (next.length === filters.length) return false
    onFiltersChange(next)
    return true
  }

  const ruleRow = (filter: InboxFilter) => (
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
  )

  const summary = total
    ? `${total.toLocaleString()} filtered out of your Inbox${unread ? `, ${unread.toLocaleString()} unread` : ''}`
    : 'Filtered out of your Inbox'

  return (
    <div className={styles.filterWrap} ref={wrapRef}>
      <button
        type="button"
        className={`${styles.filterChip} ${showing || show !== 'all' ? styles.filterChipOn : ''}`}
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
        aria-label={summary}
        title={summary}
      >
        {FILTER_ICON}
        <span className={styles.filterChipLabel}>{show === 'all' ? 'Filtered' : showLabel}</span>
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
            <span>Show</span>
          </div>
          <div className={styles.filterShow} role="radiogroup" aria-label="Show">
            {LIST_SHOWS.map(option => (
              <button
                key={option.show}
                type="button"
                role="radio"
                aria-checked={show === option.show}
                className={`${styles.filterShowOption} ${show === option.show ? styles.filterShowOptionOn : ''}`}
                onClick={() => onShowChange(option.show)}
              >
                {option.label}
              </button>
            ))}
          </div>
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
            {ordinary.length === 0 && (
              <div className={styles.filterEmpty}>
                {advanced.length ? 'No rules of your own. Only the Advanced ones apply.' : 'No rules. Everything reaches your Inbox.'}
              </div>
            )}
            {ordinary.map(ruleRow)}
          </div>
          <AddRule advanced={false} onAdd={addRule} />
          <button
            type="button"
            className={styles.filterAdvancedToggle}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(current => !current)}
          >
            <span aria-hidden className={`${styles.filterAdvancedCaret} ${advancedOpen ? styles.filterAdvancedCaretOpen : ''}`}>›</span>
            Advanced
            {advanced.length > 0 && <span className={styles.filterAdvancedCount}>{advanced.length}</span>}
          </button>
          {advancedOpen && (
            <div className={styles.filterAdvanced}>
              <span className={styles.filterMenuHint}>
                For machine mail like DMARC reports. It is filtered the same way and never counts as unread in your Inbox.
              </span>
              <div className={styles.filterRules}>
                {advanced.length === 0 && <div className={styles.filterEmpty}>No advanced rules.</div>}
                {advanced.map(ruleRow)}
              </div>
              <AddRule advanced onAdd={addRule} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
