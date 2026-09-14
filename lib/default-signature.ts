import { BRAND } from './brand'

/**
 * The mark with the brand colour in its pixels. A mail client cannot apply a CSS mask,
 * so this asset must carry its colour in the colour channels rather than the alpha.
 */
export const MARK_URL = BRAND.markUrl
export const MARK_WIDTH = 200

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Falls back to the part before the @ when a mailbox has no name on it. */
export function defaultSignature(name: string | null | undefined, address: string, mobile?: string): string {
  const { accent, link, muted } = BRAND.colors
  const local = address.split('@')[0] ?? ''
  const who = escapeHtml((name ?? '').trim() || local.replace(/[._-]+/g, ' '))
  const email = escapeHtml(address)
  const phones = [BRAND.tel ? `Tel: ${escapeHtml(BRAND.tel)}` : '', mobile ? `Mobile: ${escapeHtml(mobile)}` : ''].filter(Boolean).join(', ')
  const line2 = [BRAND.address ? escapeHtml(BRAND.address) : '', phones].filter(Boolean).join(' | ')

  return [
    `<p><img src="${escapeHtml(MARK_URL)}" width="${MARK_WIDTH}" alt="${escapeHtml(BRAND.name)}" style="display:block;width:${MARK_WIDTH}px;height:auto;border:0;" /></p>`,
    `<p><span style="font-size: 10pt; color: ${accent};"><strong>${who} | ${escapeHtml(BRAND.legalName)}</strong></span></p>`,
    line2 ? `<p><span style="font-size: 10pt; color: ${accent};">${line2}</span></p>` : '',
    `<p><span style="font-size: 8pt; color: ${accent};">Email: </span>`,
    `<a target="_blank" rel="noopener noreferrer nofollow" href="mailto:${email}"><span style="font-size: 8pt; color: ${link};"><u>${email}</u></span></a></p>`,
    `<p><span style="font-size: 8pt; color: ${accent};">Website: </span>`,
    `<a target="_blank" rel="noopener noreferrer nofollow" href="${escapeHtml(BRAND.websiteUrl)}/"><span style="font-size: 8pt; color: ${link};">${escapeHtml(BRAND.website)}</span></a></p>`,
    BRAND.regulatory ? `<p><span style="font-size: 8pt; color: rgb(0, 0, 0);"><strong>${escapeHtml(BRAND.regulatory)}</strong></span></p>` : '',
    '<hr>',
    `<p><span style="font-size: 8pt; color: ${muted};">${escapeHtml(BRAND.disclaimer)}</span></p>`,
  ].join('')
}
