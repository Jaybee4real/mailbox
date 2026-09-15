import { BRAND, signatureMarkStyle } from './brand'

export type SignatureIdentity = { name: string; email: string; mobile?: string }

export const SIGNATURE_LOGO_URL = BRAND.markUrl

const escape = (value: string) => value.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char)

export function signatureLogoHtml(url: string): string {
  return `<p><img src="${escape(url)}" alt="${escape(BRAND.name)}" width="200" style="${signatureMarkStyle(200)}"></p>`
}

/** The company signature, personalised. Editable in the signature editor, so plain paragraphs and spans only. */
export function companySignatureHtml(identity: SignatureIdentity, options: { logo?: boolean } = {}): string {
  const { accent, link, muted } = BRAND.colors
  const phones = [BRAND.tel ? `Tel: ${BRAND.tel}` : '', identity.mobile ? `Mobile: ${identity.mobile}` : ''].filter(Boolean).join(', ')
  const line2 = [BRAND.address, phones].filter(Boolean).join(' | ')
  return [
    options.logo ? signatureLogoHtml(SIGNATURE_LOGO_URL) : '',
    `<p><span style="font-size: 10pt; color: ${accent}"><strong>${escape(identity.name)} | ${escape(BRAND.legalName)}</strong></span></p>`,
    line2 ? `<p><span style="font-size: 10pt; color: ${accent}">${escape(line2)}</span></p>` : '',
    `<p><span style="font-size: 8pt; color: ${accent}">Email: <a href="mailto:${escape(identity.email)}"><span style="color: ${link}"><u>${escape(identity.email)}</u></span></a></span></p>`,
    `<p><span style="font-size: 8pt; color: ${accent}">Website: <a href="${escape(BRAND.websiteUrl)}/"><span style="color: ${link}">${escape(BRAND.website)}</span></a></span></p>`,
    BRAND.regulatory ? `<p><span style="font-size: 8pt; color: rgb(0, 0, 0)"><strong>${escape(BRAND.regulatory)}</strong></span></p>` : '',
    '<hr>',
    `<p><span style="font-size: 8pt; color: ${muted}">${escape(BRAND.disclaimer)}</span></p>`,
  ].join('')
}
