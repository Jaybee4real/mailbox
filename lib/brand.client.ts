/**
 * The names of the public brand settings. The server writes their values into every page it
 * renders, and the browser reads them back from there.
 */
export const BRAND_ENV_KEYS = [
  'NEXT_PUBLIC_BRAND_NAME', 'NEXT_PUBLIC_MAIL_DOMAIN', 'NEXT_PUBLIC_BRAND_WEBSITE', 'NEXT_PUBLIC_MAIL_PUBLIC_URL',
  'NEXT_PUBLIC_BRAND_LEGAL_NAME', 'NEXT_PUBLIC_BRAND_ADDRESS', 'NEXT_PUBLIC_BRAND_TEL', 'NEXT_PUBLIC_BRAND_REGULATORY',
  'NEXT_PUBLIC_BRAND_DISCLAIMER', 'NEXT_PUBLIC_BRAND_COLOR_ACCENT', 'NEXT_PUBLIC_BRAND_COLOR_LINK',
  'NEXT_PUBLIC_BRAND_COLOR_MUTED', 'NEXT_PUBLIC_BRAND_MARK_URL', 'NEXT_PUBLIC_BRAND_ACCENT',
  'NEXT_PUBLIC_BRAND_CHROME_MARK_URL', 'NEXT_PUBLIC_BRAND_SIGNATURE_MARK_BORDER', 'NEXT_PUBLIC_BRAND_SIGNATURE_MARK_RADIUS',
  'NEXT_PUBLIC_MAIL_ADDRESS_DOMAINS', 'NEXT_PUBLIC_MAIL_ADDRESSES',
] as const

type BrandEnv = Partial<Record<string, string>>

declare global {
  interface Window { __MAILBOX_BRAND_ENV__?: BrandEnv }
}

// Next rewrites every literal `process.env.NEXT_PUBLIC_…` into a fixed string at build time,
// which would freeze one tenant's brand into an image all of them share. Reading by a
// computed key leaves it to run time: the process's own environment on the server, and in
// the browser the values the server wrote into the page.
const runtimeEnv: BrandEnv = typeof window === 'undefined' ? process.env : (window.__MAILBOX_BRAND_ENV__ ?? {})
const read = (key: string) => runtimeEnv[`NEXT_PUBLIC_${key}`]?.trim() || ''
const list = (key: string) => read(key).split(',').map(value => value.trim().toLowerCase()).filter(Boolean)

const name = read('BRAND_NAME') || 'Mailbox'
const domain = read('MAIL_DOMAIN').toLowerCase() || 'example.com'
const website = (read('BRAND_WEBSITE') || domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
const publicUrl = (read('MAIL_PUBLIC_URL') || `https://mail.${domain}`).replace(/\/$/, '')

const legalName = read('BRAND_LEGAL_NAME') || name

export const CLIENT_BRAND = {
  name,
  legalName,
  address: read('BRAND_ADDRESS'),
  tel: read('BRAND_TEL'),
  regulatory: read('BRAND_REGULATORY'),
  disclaimer:
    read('BRAND_DISCLAIMER') ||
    `DISCLAIMER: The information contained in this e-mail is proprietary to ${legalName} and is intended only for the individual or entity to which it is addressed. It may contain information that is privileged, confidential or exempt from disclosure under applicable law. If you are not the intended recipient, any use, distribution, transmission, printing, copying or dissemination of this information is strictly prohibited. If you have received this communication in error, please delete it and notify us.`,
  colors: {
    accent: read('BRAND_COLOR_ACCENT') || 'rgb(109, 40, 217)',
    link: read('BRAND_COLOR_LINK') || 'rgb(17, 85, 204)',
    muted: read('BRAND_COLOR_MUTED') || 'rgb(107, 114, 128)',
  },
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'mailbox',
  domain,
  website,
  websiteUrl: `https://${website}`,
  publicUrl,
  markUrl: read('BRAND_MARK_URL') || `${publicUrl}/icon-192.png`,
  accent: read('BRAND_ACCENT') || '#6d28d9',
  chromeMarkUrl: read('BRAND_CHROME_MARK_URL') || '/brand/mark.png',
  signatureMark: {
    border: read('BRAND_SIGNATURE_MARK_BORDER') || 'none',
    radius: read('BRAND_SIGNATURE_MARK_RADIUS') || '0',
  },
  addressDomains: list('MAIL_ADDRESS_DOMAINS'),
  addresses: list('MAIL_ADDRESSES'),
} as const

export const LS = (key: string) => `${CLIENT_BRAND.slug}_mail_${key}`

/** Browser twin of signatureMarkStyle in lib/brand.ts; the two must agree or the preview lies about the sent mail. */
export function clientSignatureMarkStyle(width: number): string {
  const { border, radius } = CLIENT_BRAND.signatureMark
  const colour = border === 'accent' ? CLIENT_BRAND.accent : border
  const frame = !colour || colour === 'none' ? 'border:0;' : `padding:8px;border:1px solid ${colour};border-radius:${radius}px;`
  return `display:block;width:${width}px;height:auto;${frame}`
}
