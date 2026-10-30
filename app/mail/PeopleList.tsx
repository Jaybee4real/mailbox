'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import MailSelect, { anchoredMenuStyle } from './MailSelect'
import styles from './page.module.css'

export type Person = {
  email: string
  name: string | null
  address: string | null
  role: 'admin' | 'member'
  status: string
  hasPassword: boolean
  invitedBy: string | null
  twoStep?: boolean
  createdAt?: string | null
  recoveryEmail?: string | null
  apps?: Array<{ device: string; version: string; build: string; update: string; platform: string; os: string; lastUsedAt: string }>
}

type Filter = 'all' | 'admin' | 'member' | 'invited' | 'two-step-off'

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'admin', label: 'Admins' },
  { value: 'member', label: 'Members' },
  { value: 'invited', label: 'Invite not accepted' },
  { value: 'two-step-off', label: 'Two-step off' },
]

const ROLES = [
  { value: 'member', label: 'Member', hint: 'Their own mailbox only' },
  { value: 'admin', label: 'Admin', hint: 'Every mailbox and these settings' },
]

const NO_MAILBOX = 'No mailbox'

const domainOf = (person: Person) => person.address?.split('@')[1]?.toLowerCase() ?? NO_MAILBOX
const shownName = (person: Person) => person.name || person.address || person.email
const initialOf = (person: Person) => (shownName(person).trim()[0] ?? '?').toUpperCase()
const pending = (person: Person) => person.status !== 'active'

const day = (value?: string | null) => {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null
}

const PLATFORM_NAMES: Record<string, string> = { ios: 'iOS', android: 'Android' }

const ago = (value: string) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000))
  if (minutes < 60) return minutes < 2 ? 'active now' : `active ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `active ${hours} h ago`
  return `active ${Math.round(hours / 24)} days ago`
}

const appLabel = (app: NonNullable<Person['apps']>[number]) =>
  [
    app.version ? `Vela ${app.version}${app.build ? ` (${app.build})` : ''}${app.update ? ` · update ${app.update}` : ''}` : 'Vela (version not reported yet)',
    app.platform ? `${PLATFORM_NAMES[app.platform] ?? app.platform}${app.os ? ` ${app.os}` : ''}` : '',
    app.platform && /^vela mail on /i.test(app.device) ? '' : app.device,
    ago(app.lastUsedAt),
  ].filter(Boolean).join(' · ')

const matchesFilter = (person: Person, filter: Filter) => {
  if (filter === 'admin' || filter === 'member') return person.role === filter
  if (filter === 'invited') return pending(person)
  if (filter === 'two-step-off') return !pending(person) && !person.twoStep
  return true
}

export default function PeopleList({
  people,
  me,
  defaultDomain,
  domains,
  rename,
  password,
  onRole,
  onResetLink,
  onTwoStepOff,
  onRemove,
  onCopied,
}: {
  people: Person[]
  me: string | null
  defaultDomain: string
  domains: string[]
  rename: {
    target: string | null
    handle: string
    domain: string
    start: (person: Person) => void
    cancel: () => void
    setHandle: (value: string) => void
    setDomain: (value: string) => void
    save: (email: string) => void
  }
  password: {
    target: { email: string; value: string } | null
    toggle: (email: string) => void
    set: (email: string, value: string) => void
    save: () => void
    cancel: () => void
  }
  onRole: (email: string, role: 'admin' | 'member') => void
  onResetLink: (email: string) => void
  onTwoStepOff: (email: string) => void
  onRemove: (email: string) => void
  onCopied: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [closed, setClosed] = useState<string[]>([])
  const [menu, setMenu] = useState<{ email: string; style: React.CSSProperties } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const away = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setMenu(null)
      }
    }
    const scrolled = () => setMenu(null)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape, true)
    document.addEventListener('scroll', scrolled, true)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape, true)
      document.removeEventListener('scroll', scrolled, true)
    }
  }, [menu])

  const counts = useMemo(() => ({
    admins: people.filter(person => person.role === 'admin').length,
    invited: people.filter(pending).length,
    domains: new Set(people.map(domainOf)).size,
  }), [people])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const shown = people.filter(person =>
      matchesFilter(person, filter) &&
      (!needle || `${person.name ?? ''} ${person.email} ${person.address ?? ''} ${person.recoveryEmail ?? ''}`.toLowerCase().includes(needle)),
    )
    const byDomain = new Map<string, Person[]>()
    for (const person of shown) byDomain.set(domainOf(person), [...(byDomain.get(domainOf(person)) ?? []), person])
    const rank = (domain: string) => (domain === defaultDomain ? 0 : domain === NO_MAILBOX ? 2 : 1)
    return [...byDomain.entries()]
      .sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right))
      .map(([domain, members]) => ({
        domain,
        members: members.sort((left, right) =>
          Number(right.email === me) - Number(left.email === me) ||
          Number(right.role === 'admin') - Number(left.role === 'admin') ||
          shownName(left).localeCompare(shownName(right)),
        ),
      }))
  }, [people, query, filter, defaultDomain, me])

  const searching = Boolean(query.trim()) || filter !== 'all'
  const shownCount = groups.reduce((sum, group) => sum + group.members.length, 0)
  const toggleGroup = (domain: string) =>
    setClosed(current => (current.includes(domain) ? current.filter(entry => entry !== domain) : [...current, domain]))

  const openMenu = (email: string, anchor: HTMLElement) => {
    if (menu?.email === email) {
      setMenu(null)
      return
    }
    const style = anchoredMenuStyle(anchor)
    const rect = anchor.getBoundingClientRect()
    setMenu({ email, style: { ...style, left: undefined, right: window.innerWidth - rect.right, minWidth: 220 } })
  }
  const menuPerson = menu ? people.find(person => person.email === menu.email) ?? null : null
  const act = (run: () => void) => {
    setMenu(null)
    run()
  }

  return (
    <div className={styles.people}>
      <div className={styles.peopleBar}>
        <label className={styles.peopleSearch}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Search people and mailboxes"
            aria-label="Search people and mailboxes"
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
        </label>
        <MailSelect
          value={filter}
          options={FILTERS}
          ariaLabel="Show"
          buttonClassName={styles.peopleFilter}
          onChange={value => setFilter(value as Filter)}
        />
      </div>
      <p className={styles.peopleSummary}>
        {searching
          ? `${shownCount} of ${people.length} ${people.length === 1 ? 'person' : 'people'}`
          : `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${counts.admins} ${counts.admins === 1 ? 'admin' : 'admins'}${counts.invited ? ` · ${counts.invited} invite${counts.invited === 1 ? '' : 's'} not accepted` : ''} · ${counts.domains} ${counts.domains === 1 ? 'domain' : 'domains'}`}
      </p>

      {groups.length === 0 && (
        <p className={styles.peopleEmpty}>
          {people.length === 0 ? 'Nobody has access yet. Invite someone above.' : 'Nobody matches. Try another name, address or filter.'}
        </p>
      )}

      {groups.map(group => {
        const open = searching || !closed.includes(group.domain)
        return (
          <section key={group.domain} className={styles.peopleGroup}>
            <button
              type="button"
              className={styles.peopleGroupHead}
              aria-expanded={open}
              onClick={() => toggleGroup(group.domain)}
            >
              <svg className={`${styles.peopleCaret} ${open ? styles.peopleCaretOpen : ''}`} viewBox="0 0 12 8" fill="none" aria-hidden>
                <path d="M1 1l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className={styles.peopleDomain}>{group.domain === NO_MAILBOX ? NO_MAILBOX : `@${group.domain}`}</span>
              <span className={styles.peopleCount}>{group.members.length}</span>
            </button>

            {open && (
              <ul className={styles.peopleRows}>
                {group.members.map(person => {
                  const ownSignIn = person.address && person.email !== person.address
                  const invitedOn = pending(person) ? day(person.createdAt) : null
                  return (
                    <li key={person.email} className={styles.personRow}>
                      <span className={`${styles.personAvatar} ${person.role === 'admin' ? styles.personAvatarAdmin : ''}`} aria-hidden>
                        {initialOf(person)}
                      </span>
                      <div className={styles.personMain}>
                        <div className={styles.personTitle}>
                          <strong>{shownName(person)}</strong>
                          {person.email === me && <span className={styles.personTag}>You</span>}
                          {pending(person) && <span className={`${styles.personTag} ${styles.personTagWarn}`}>Invited</span>}
                          {!pending(person) && person.twoStep && <span className={`${styles.personTag} ${styles.personTagOk}`}>Two-step</span>}
                        </div>

                        {rename.target === person.email ? (
                          <span className={styles.mailboxField}>
                            <span className={styles.mailboxInputWrap}>
                              <input
                                type="text"
                                autoFocus
                                aria-label={`Mailbox for ${person.email}`}
                                value={rename.handle}
                                onChange={event => rename.setHandle(event.target.value)}
                                onKeyDown={event => {
                                  if (event.key === 'Enter') rename.save(person.email)
                                  if (event.key === 'Escape') {
                                    event.stopPropagation()
                                    rename.cancel()
                                  }
                                }}
                              />
                              {domains.length > 1 ? (
                                <MailSelect
                                  buttonClassName={styles.mailboxDomainSelect}
                                  ariaLabel={`Mail domain for ${person.email}`}
                                  value={rename.domain}
                                  onChange={rename.setDomain}
                                  options={domains.map(domain => ({ value: domain, label: `@${domain}` }))}
                                />
                              ) : (
                                <span className={styles.mailboxDomain}>@{rename.domain || defaultDomain}</span>
                              )}
                            </span>
                            <button className={styles.mailboxSave} onClick={() => rename.save(person.email)} type="button">
                              Save
                            </button>
                            <button className={styles.linkBtn} onClick={rename.cancel} type="button">
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            className={styles.personAddress}
                            onClick={() => rename.start(person)}
                            title="Change this mailbox address"
                            type="button"
                          >
                            {person.address ?? 'No mailbox yet'}
                          </button>
                        )}

                        <span className={styles.personMeta}>
                          {ownSignIn
                            ? <>Signs in with <b>{person.email}</b></>
                            : person.address ? 'Signs in with the mailbox address' : <>Signs in with <b>{person.email}</b></>}
                          {person.recoveryEmail && person.recoveryEmail !== person.email && <> · recovery {person.recoveryEmail}</>}
                          {pending(person) && (
                            <> · invited{invitedOn ? ` ${invitedOn}` : ''}{person.invitedBy ? ` by ${person.invitedBy}` : ''}</>
                          )}
                        </span>
                        {person.apps?.map(app => (
                          <span key={`${app.device}-${app.lastUsedAt}`} className={styles.personApp}>
                            {appLabel(app)}
                          </span>
                        ))}
                      </div>

                      <div className={styles.personActions}>
                        <MailSelect
                          value={person.role}
                          options={ROLES.map(role => ({ ...role, closed: role.label }))}
                          ariaLabel={`Role for ${shownName(person)}`}
                          buttonClassName={styles.accessorRoleBtn}
                          onChange={value => onRole(person.email, value as 'admin' | 'member')}
                        />
                        <button
                          type="button"
                          className={styles.personMore}
                          aria-label={`More for ${shownName(person)}`}
                          aria-haspopup="menu"
                          aria-expanded={menu?.email === person.email}
                          onClick={event => openMenu(person.email, event.currentTarget)}
                        >
                          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <circle cx="5" cy="12" r="1.8" />
                            <circle cx="12" cy="12" r="1.8" />
                            <circle cx="19" cy="12" r="1.8" />
                          </svg>
                        </button>
                      </div>

                      {password.target?.email === person.email && (
                        <form
                          className={styles.adminPassword}
                          onSubmit={event => {
                            event.preventDefault()
                            password.save()
                          }}
                        >
                          <label className={styles.settingsField}>
                            <span>New password for {shownName(person)}</span>
                            <input
                              value={password.target.value}
                              onChange={event => password.set(person.email, event.target.value)}
                              autoComplete="new-password"
                              placeholder="At least 10 characters"
                              autoFocus
                            />
                          </label>
                          <div className={styles.factorActions}>
                            <button type="submit" className={styles.pwSubmit} disabled={password.target.value.length < 10}>
                              Save and copy
                            </button>
                            <button
                              type="button"
                              className={styles.linkBtn}
                              onClick={() => {
                                const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
                                const bytes = crypto.getRandomValues(new Uint8Array(16))
                                const generated = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('')
                                password.set(person.email, `${generated.slice(0, 4)}-${generated.slice(4, 8)}-${generated.slice(8, 12)}-${generated.slice(12)}`)
                              }}
                            >
                              Generate one
                            </button>
                            <button type="button" className={styles.linkBtn} onClick={password.cancel}>Cancel</button>
                          </div>
                        </form>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}

      {menu && menuPerson && (
        <div ref={menuRef} className={styles.selectMenu} style={menu.style} role="menu" aria-label={`Actions for ${shownName(menuPerson)}`}>
          <button type="button" role="menuitem" className={styles.selectOption} onClick={() => act(() => rename.start(menuPerson))}>
            Change mailbox address
          </button>
          <button type="button" role="menuitem" className={styles.selectOption} onClick={() => act(() => onResetLink(menuPerson.email))}>
            Copy a password reset link
          </button>
          <button type="button" role="menuitem" className={styles.selectOption} onClick={() => act(() => password.toggle(menuPerson.email))}>
            Set a password for them
          </button>
          {menuPerson.twoStep && (
            <button type="button" role="menuitem" className={styles.selectOption} onClick={() => act(() => onTwoStepOff(menuPerson.email))}>
              Turn off two-step sign-in
            </button>
          )}
          {menuPerson.address && (
            <button type="button" role="menuitem" className={styles.selectOption} onClick={() => act(() => {
              const address = menuPerson.address ?? ''
              void navigator.clipboard?.writeText(address).then(() => onCopied(address)).catch(() => {})
            })}>
              Copy mailbox address
            </button>
          )}
          {menuPerson.email !== me && (
            <>
              <span className={styles.personMenuRule} role="separator" />
              <button type="button" role="menuitem" className={`${styles.selectOption} ${styles.personMenuDanger}`} onClick={() => act(() => onRemove(menuPerson.email))}>
                Remove access
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
