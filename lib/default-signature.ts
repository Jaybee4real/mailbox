import { BRAND } from './brand'

/**
 * The mark with the brand colour in its pixels. A mail client cannot apply a CSS mask,
 * so this asset must carry its colour in the colour channels rather than the alpha.
 */
export const MARK_URL = BRAND.markUrl
export const MARK_WIDTH = 200

/** What a signature needs to know about the tenant; BRAND on the server, CLIENT_BRAND in the browser. */
export type SignatureBrand = {
  name: string
  legalName: string
  website: string
  websiteUrl: string
  markUrl: string
  address: string
  tel: string
  regulatory: string
  disclaimer: string
  colors: { accent: string; link: string; muted: string }
  signatureMark: { border: string; radius: string }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function markStyle(brand: SignatureBrand, width: number): string {
  const { border, radius } = brand.signatureMark
  const colour = border === 'accent' ? brand.colors.accent : border
  const frame = !colour || colour === 'none' ? 'border:0;' : `padding:8px;border:1px solid ${colour};border-radius:${radius}px;`
  return `display:block;width:${width}px;height:auto;${frame}`
}

/** Falls back to the part before the @ when a mailbox has no name on it. */
export function defaultSignature(name: string | null | undefined, address: string, mobile?: string, brand: SignatureBrand = BRAND): string {
  const { accent, link, muted } = brand.colors
  const local = address.split('@')[0] ?? ''
  const who = escapeHtml((name ?? '').trim() || local.replace(/[._-]+/g, ' '))
  const email = escapeHtml(address)
  const phones = [brand.tel ? `Tel: ${escapeHtml(brand.tel)}` : '', mobile ? `Mobile: ${escapeHtml(mobile)}` : ''].filter(Boolean).join(', ')
  const line2 = [brand.address ? escapeHtml(brand.address) : '', phones].filter(Boolean).join(' | ')

  return [
    `<p><img src="${escapeHtml(brand.markUrl)}" width="${MARK_WIDTH}" alt="${escapeHtml(brand.name)}" style="${markStyle(brand, MARK_WIDTH)}" /></p>`,
    `<p><span style="font-size: 10pt; color: ${accent};"><strong>${who} | ${escapeHtml(brand.legalName)}</strong></span></p>`,
    line2 ? `<p><span style="font-size: 10pt; color: ${accent};">${line2}</span></p>` : '',
    `<p><span style="font-size: 8pt; color: ${accent};">Email: </span>`,
    `<a target="_blank" rel="noopener noreferrer nofollow" href="mailto:${email}"><span style="font-size: 8pt; color: ${link};"><u>${email}</u></span></a></p>`,
    `<p><span style="font-size: 8pt; color: ${accent};">Website: </span>`,
    `<a target="_blank" rel="noopener noreferrer nofollow" href="${escapeHtml(brand.websiteUrl)}/"><span style="font-size: 8pt; color: ${link};">${escapeHtml(brand.website)}</span></a></p>`,
    brand.regulatory ? `<p><span style="font-size: 8pt; color: rgb(0, 0, 0);"><strong>${escapeHtml(brand.regulatory)}</strong></span></p>` : '',
    '<hr>',
    `<p><span style="font-size: 8pt; color: ${muted};">${escapeHtml(brand.disclaimer)}</span></p>`,
  ].join('')
}
