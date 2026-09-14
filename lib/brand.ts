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
  markUrl: env('BRAND_MARK_URL', `${publicUrl}/brand/mark-email.png`),
  address: env('BRAND_ADDRESS'),
  tel: env('BRAND_TEL'),
  regulatory: env('BRAND_REGULATORY'),
  disclaimer: env(
    'BRAND_DISCLAIMER',
    `DISCLAIMER: The information contained in this e-mail is proprietary to ${env('BRAND_LEGAL_NAME', name)} and is intended only for the individual or entity to which it is addressed. It may contain information that is privileged, confidential or exempt from disclosure under applicable law. If you are not the intended recipient, any use, distribution, transmission, printing, copying or dissemination of this information is strictly prohibited. If you have received this communication in error, please delete it and notify us.`,
  ),
  colors: {
    accent: env('BRAND_COLOR_ACCENT', 'rgb(153, 0, 0)'),
    link: env('BRAND_COLOR_LINK', 'rgb(17, 85, 204)'),
    muted: env('BRAND_COLOR_MUTED', 'rgb(107, 114, 128)'),
  },
  supportEmail: env('MAIL_SUPPORT_EMAIL', `info@${domain}`),
  vapidSubject: env('VAPID_SUBJECT', `mailto:info@${domain}`),
} as const

export const MAIL_SEATS: MailSeat[] = json<MailSeat[]>('MAIL_SEATS', [])
export const ADDRESS_ALIASES: Record<string, string> = json<Record<string, string>>('MAIL_ADDRESS_ALIASES', {})

export const brandSlug = BRAND.name.toLowerCase().replace(/[^a-z0-9]+/g, '')
