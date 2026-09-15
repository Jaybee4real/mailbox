const name = process.env.NEXT_PUBLIC_BRAND_NAME?.trim() || 'Mailbox'
const domain = process.env.NEXT_PUBLIC_MAIL_DOMAIN?.trim().toLowerCase() || 'example.com'
const website = (process.env.NEXT_PUBLIC_BRAND_WEBSITE?.trim() || domain).replace(/^https?:\/\//, '').replace(/\/$/, '')
const publicUrl = (process.env.NEXT_PUBLIC_MAIL_PUBLIC_URL?.trim() || `https://mail.${domain}`).replace(/\/$/, '')

const legalName = process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME?.trim() || name

export const CLIENT_BRAND = {
  name,
  legalName,
  address: process.env.NEXT_PUBLIC_BRAND_ADDRESS?.trim() || '',
  tel: process.env.NEXT_PUBLIC_BRAND_TEL?.trim() || '',
  regulatory: process.env.NEXT_PUBLIC_BRAND_REGULATORY?.trim() || '',
  disclaimer:
    process.env.NEXT_PUBLIC_BRAND_DISCLAIMER?.trim() ||
    `DISCLAIMER: The information contained in this e-mail is proprietary to ${legalName} and is intended only for the individual or entity to which it is addressed. It may contain information that is privileged, confidential or exempt from disclosure under applicable law. If you are not the intended recipient, any use, distribution, transmission, printing, copying or dissemination of this information is strictly prohibited. If you have received this communication in error, please delete it and notify us.`,
  colors: {
    accent: process.env.NEXT_PUBLIC_BRAND_COLOR_ACCENT?.trim() || 'rgb(109, 40, 217)',
    link: process.env.NEXT_PUBLIC_BRAND_COLOR_LINK?.trim() || 'rgb(17, 85, 204)',
    muted: process.env.NEXT_PUBLIC_BRAND_COLOR_MUTED?.trim() || 'rgb(107, 114, 128)',
  },
  slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'mailbox',
  domain,
  website,
  websiteUrl: `https://${website}`,
  publicUrl,
  markUrl: process.env.NEXT_PUBLIC_BRAND_MARK_URL?.trim() || `${publicUrl}/brand/mark-email.png`,
  accent: process.env.NEXT_PUBLIC_BRAND_ACCENT?.trim() || '#6d28d9',
  chromeMarkUrl: process.env.NEXT_PUBLIC_BRAND_CHROME_MARK_URL?.trim() || '/brand/mark.png',
  signatureMark: {
    border: process.env.NEXT_PUBLIC_BRAND_SIGNATURE_MARK_BORDER?.trim() || 'none',
    radius: process.env.NEXT_PUBLIC_BRAND_SIGNATURE_MARK_RADIUS?.trim() || '0',
  },
  addressDomains: (process.env.NEXT_PUBLIC_MAIL_ADDRESS_DOMAINS ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
  addresses: (process.env.NEXT_PUBLIC_MAIL_ADDRESSES ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
} as const

export const LS = (key: string) => `${CLIENT_BRAND.slug}_mail_${key}`

/** Browser twin of signatureMarkStyle in lib/brand.ts; the two must agree or the preview lies about the sent mail. */
export function clientSignatureMarkStyle(width: number): string {
  const { border, radius } = CLIENT_BRAND.signatureMark
  const colour = border === 'accent' ? CLIENT_BRAND.accent : border
  const frame = !colour || colour === 'none' ? 'border:0;' : `padding:8px;border:1px solid ${colour};border-radius:${radius}px;`
  return `display:block;width:${width}px;height:auto;${frame}`
}

/** Re-applies the tenant's frame to the brand mark wherever it appears in signature HTML; the editor drops inline styles on images. */
export function frameSignatureMark(html: string): string {
  const mark = CLIENT_BRAND.markUrl
  if (!mark || !html.includes('<img')) return html
  return html.replace(/<img\b([^>]*?)\s*\/?>/g, (tag, attrs: string) => {
    if (!attrs.includes(mark)) return tag
    const width = Number(/\bwidth="?(\d+)/.exec(attrs)?.[1]) || 200
    const cleaned = attrs.replace(/\sstyle="[^"]*"/, '')
    return `<img${cleaned} style="${clientSignatureMarkStyle(width)}" />`
  })
}
