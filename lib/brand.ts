export type MailRole = 'admin' | 'member'
export type MailSeat = { email: string; address: string; name: string; role: MailRole }

const env = (key: string, fallback = '') => (process.env[key] ?? fallback).trim()

function json<T>(key: string, fallback: T): T {
  const raw = process.env[key]
  if (!raw || !raw.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const domain = env('MAIL_ADDRESS_DOMAIN', 'example.com').toLowerCase()
const name = env('BRAND_NAME', 'Mailbox')
const website = env('BRAND_WEBSITE', domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
const publicUrl = env('MAIL_PUBLIC_URL', `https://mail.${domain}`).replace(/\/$/, '')

export const BRAND = {
  name,
  legalName: env('BRAND_LEGAL_NAME', name),
  domain,
  website,
  websiteUrl: `https://${website}`,
  publicUrl,
  logoUrl: env('BRAND_LOGO_URL', `${publicUrl}/brand/mark-email.png`),
  markUrl: env('BRAND_MARK_URL', `${publicUrl}/icon-192.png`),
  address: env('BRAND_ADDRESS'),
  tel: env('BRAND_TEL'),
  regulatory: env('BRAND_REGULATORY'),
  disclaimer: env(
    'BRAND_DISCLAIMER',
    `DISCLAIMER: The information contained in this e-mail is proprietary to ${env('BRAND_LEGAL_NAME', name)} and is intended only for the individual or entity to which it is addressed. It may contain information that is privileged, confidential or exempt from disclosure under applicable law. If you are not the intended recipient, any use, distribution, transmission, printing, copying or dissemination of this information is strictly prohibited. If you have received this communication in error, please delete it and notify us.`,
  ),
  colors: {
    accent: env('BRAND_COLOR_ACCENT', 'rgb(109, 40, 217)'),
    link: env('BRAND_COLOR_LINK', 'rgb(17, 85, 204)'),
    muted: env('BRAND_COLOR_MUTED', 'rgb(107, 114, 128)'),
  },
  chromeMarkUrl: env('BRAND_CHROME_MARK_URL', '/brand/mark.png'),
  signatureMark: {
    border: env('BRAND_SIGNATURE_MARK_BORDER', 'none'),
    radius: env('BRAND_SIGNATURE_MARK_RADIUS', '0'),
  },
  iconUrl: env('BRAND_ICON_URL'),
  appleIconUrl: env('BRAND_APPLE_ICON_URL', env('BRAND_ICON_URL')),
  accentHex: env('BRAND_ACCENT_HEX', env('NEXT_PUBLIC_BRAND_ACCENT', '#6d28d9')),
  supportEmail: env('MAIL_SUPPORT_EMAIL', `info@${domain}`),
  vapidSubject: env('VAPID_SUBJECT', `mailto:info@${domain}`),
} as const

const addressDomains: string[] = (() => {
  const extra = env('MAIL_ADDRESS_DOMAINS')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
  const preferred = env('MAIL_DEFAULT_ADDRESS_DOMAIN').toLowerCase() || domain
  return [...new Set([preferred, domain, ...extra])]
})()

export const ADDRESS_DOMAINS = addressDomains

/**
 * A mailbox a fresh checkout can sign into, so the package can be run and tried with no
 * configuration at all. Its password is its own address, so it is never seeded into a
 * production deployment.
 */
const DEV_SEAT: MailSeat = { email: `test@${domain}`, address: `test@${domain}`, name: 'Test Account', role: 'admin' }

export const MAIL_SEATS: MailSeat[] = (() => {
  const configured = json<MailSeat[]>('MAIL_SEATS', [])
  if (process.env.NODE_ENV === 'production') return configured
  return configured.some(seat => seat.email.toLowerCase() === DEV_SEAT.email) ? configured : [...configured, DEV_SEAT]
})()
export const ADDRESS_ALIASES: Record<string, string> = json<Record<string, string>>('MAIL_ADDRESS_ALIASES', {})

export const brandSlug = BRAND.name.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Inline style for the mark in a signature: a frame in the accent when the tenant asks for one, nothing otherwise. */
export function signatureMarkStyle(width: number): string {
  const { border, radius } = BRAND.signatureMark
  const colour = border === 'accent' ? BRAND.colors.accent : border
  const frame = !colour || colour === 'none' ? 'border:0;' : `padding:8px;border:1px solid ${colour};border-radius:${radius}px;`
  return `display:block;width:${width}px;height:auto;${frame}`
}
