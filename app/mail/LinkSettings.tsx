'use client'

import { viewableType, type ShareAccess } from '@/lib/share-policy'
import styles from './page.module.css'

export type LinkSettingsValue = {
  expiry: number | 'custom'
  expiresOn: string
  opensLater: boolean
  opensOn: string
  maxDownloads: string
  maxViews: string
  access: ShareAccess
  password: string
}

const EXPIRY_PRESETS: Array<[number, string]> = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [0, 'Never']]
const ACCESS_OPTIONS: Array<[ShareAccess, string]> = [['both', 'View and download'], ['view', 'View only'], ['download', 'Download only']]
const DAY_MS = 86_400_000

const pad = (value: number) => String(value).padStart(2, '0')

export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromLocalInput(value: string): string | null {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function defaultLinkSettings(filename: string, days = 30): LinkSettingsValue {
  return {
    expiry: days,
    expiresOn: toLocalInput(new Date(Date.now() + days * DAY_MS).toISOString()),
    opensLater: false,
    opensOn: toLocalInput(new Date(Date.now() + DAY_MS).toISOString()),
    maxDownloads: '',
    maxViews: '',
    access: viewableType(filename) ? 'both' : 'download',
    password: '',
  }
}

export function linkSettingsFromShare(share: {
  filename: string
  expiresAt: string | null
  availableAt: string | null
  maxDownloads: number | null
  maxViews: number | null
  access: ShareAccess
}): LinkSettingsValue {
  const base = defaultLinkSettings(share.filename)
  return {
    ...base,
    expiry: share.expiresAt ? 'custom' : 0,
    expiresOn: share.expiresAt ? toLocalInput(share.expiresAt) : base.expiresOn,
    opensLater: Boolean(share.availableAt && new Date(share.availableAt).getTime() > Date.now()),
    opensOn: share.availableAt ? toLocalInput(share.availableAt) : base.opensOn,
    maxDownloads: share.maxDownloads == null ? '' : String(share.maxDownloads),
    maxViews: share.maxViews == null ? '' : String(share.maxViews),
    access: share.access,
  }
}

export function linkSettingsPayload(value: LinkSettingsValue) {
  const expiresAt =
    value.expiry === 'custom'
      ? fromLocalInput(value.expiresOn)
      : value.expiry > 0
        ? new Date(Date.now() + value.expiry * DAY_MS).toISOString()
        : null
  return {
    expiresAt,
    availableAt: value.opensLater ? fromLocalInput(value.opensOn) : null,
    maxDownloads: value.access === 'view' ? null : value.maxDownloads.trim() || null,
    maxViews: value.access === 'download' ? null : value.maxViews.trim() || null,
    access: value.access,
  }
}

const whenLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })

/** The plain-language terms a recipient sees under the link in the email. */
export function linkTerms(value: LinkSettingsValue | undefined): string {
  if (!value) return ''
  const payload = linkSettingsPayload(value)
  const parts: string[] = []
  if (payload.availableAt) parts.push(`Opens ${whenLabel(payload.availableAt)}`)
  if (payload.expiresAt) parts.push(`Expires ${whenLabel(payload.expiresAt)}`)
  if (payload.access === 'view') parts.push('View only')
  if (payload.maxViews) parts.push(`${payload.maxViews} view${payload.maxViews === '1' ? '' : 's'}`)
  if (payload.maxDownloads) parts.push(`${payload.maxDownloads} download${payload.maxDownloads === '1' ? '' : 's'}`)
  if (value.password.trim()) parts.push('Password required')
  return parts.join(' · ')
}

export function linkSummary(value: LinkSettingsValue | undefined): string {
  if (!value) return 'Link settings'
  const parts: string[] = []
  if (value.password.trim()) parts.push('Password')
  if (value.opensLater) parts.push('Scheduled')
  if (value.access === 'view') parts.push('View only')
  if (value.maxViews.trim() || value.maxDownloads.trim()) parts.push('Limited')
  return parts.length ? parts.join(' · ') : 'Link settings'
}

type Props = {
  filename: string
  value: LinkSettingsValue
  onChange: (next: LinkSettingsValue) => void
  showPassword?: boolean
}

export default function LinkSettings({ filename, value, onChange, showPassword = true }: Props) {
  const viewable = Boolean(viewableType(filename))
  const set = (patch: Partial<LinkSettingsValue>) => onChange({ ...value, ...patch })

  return (
    <>
      <div className={styles.settingsField}>
        <span>Expires</span>
        <div className={styles.themeRow}>
          {EXPIRY_PRESETS.map(([days, label]) => (
            <button
              key={days}
              type="button"
              className={`${styles.themeChip} ${value.expiry === days ? styles.themeChipOn : ''}`}
              onClick={() => set({ expiry: days })}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`${styles.themeChip} ${value.expiry === 'custom' ? styles.themeChipOn : ''}`}
            onClick={() => set({ expiry: 'custom' })}
          >
            Pick a date
          </button>
        </div>
        {value.expiry === 'custom' && (
          <input
            type="datetime-local"
            aria-label="Expires on"
            value={value.expiresOn}
            min={toLocalInput(new Date().toISOString())}
            onChange={event => set({ expiresOn: event.target.value })}
          />
        )}
      </div>

      <div className={styles.settingsField}>
        <span>Opens</span>
        <div className={styles.themeRow}>
          <button type="button" className={`${styles.themeChip} ${!value.opensLater ? styles.themeChipOn : ''}`} onClick={() => set({ opensLater: false })}>
            Right away
          </button>
          <button type="button" className={`${styles.themeChip} ${value.opensLater ? styles.themeChipOn : ''}`} onClick={() => set({ opensLater: true })}>
            Later
          </button>
        </div>
        {value.opensLater && (
          <input
            type="datetime-local"
            aria-label="Opens on"
            value={value.opensOn}
            min={toLocalInput(new Date().toISOString())}
            onChange={event => set({ opensOn: event.target.value })}
          />
        )}
      </div>

      <div className={styles.settingsField}>
        <span>Recipients can</span>
        <div className={styles.themeRow}>
          {ACCESS_OPTIONS.map(([access, label]) => (
            <button
              key={access}
              type="button"
              disabled={!viewable && access !== 'download'}
              className={`${styles.themeChip} ${value.access === access ? styles.themeChipOn : ''}`}
              onClick={() => set({ access })}
            >
              {label}
            </button>
          ))}
        </div>
        {!viewable && <p className={styles.settingsNote}>This kind of file can&apos;t be opened in a browser, so it can only be downloaded.</p>}
        {value.access === 'view' && (
          <p className={styles.settingsNote}>Opens in the browser with saving turned off. Someone determined can still screenshot it.</p>
        )}
      </div>

      {value.access !== 'download' && (
        <label className={styles.settingsField}>
          <span>View limit (optional)</span>
          <input type="number" min={1} value={value.maxViews} onChange={event => set({ maxViews: event.target.value })} placeholder="Unlimited" />
        </label>
      )}
      {value.access !== 'view' && (
        <label className={styles.settingsField}>
          <span>Download limit (optional)</span>
          <input type="number" min={1} value={value.maxDownloads} onChange={event => set({ maxDownloads: event.target.value })} placeholder="Unlimited" />
        </label>
      )}
      {showPassword && (
        <label className={styles.settingsField}>
          <span>Password (optional)</span>
          <input
            type="text"
            value={value.password}
            onChange={event => set({ password: event.target.value })}
            placeholder="Leave blank for none"
            autoComplete="off"
          />
        </label>
      )}
    </>
  )
}
