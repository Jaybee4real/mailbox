const name = process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || 'Mailbox'
const domain = process.env.NEXT_PUBLIC_MAIL_DOMAIN?.trim().toLowerCase() || 'example.com'
const website = (process.env.NEXT_PUBLIC_BRAND_WEBSITE?.trim() || domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
const publicUrl = (process.env.NEXT_PUBLIC_MAIL_PUBLIC_URL?.trim() || `https://mail.${domain}`).replace(/\/$/, '')

export const CLIENT_BRAND = {
  name,
  legalName: process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME?.trim() || name,
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'mailbox',
  domain,
  website,
  websiteUrl: `https://${website}`,
  publicUrl,
  markUrl: process.env.NEXT_PUBLIC_BRAND_MARK_URL?.trim() || `${publicUrl}/brand/mark-email.png`,
  accent: process.env.NEXT_PUBLIC_BRAND_ACCENT?.trim() || '#6d28d9',
  addresses: (process.env.NEXT_PUBLIC_MAIL_ADDRESSES ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
} as const

export const LS = (key: string) => `${CLIENT_BRAND.slug}_mail_${key}`
