import { lineSpacingOf, paragraphGap } from './fonts'
import { BRAND } from './brand'
/**
 * Turn editor HTML into HTML an email client will render.
 *
 * Mail is not the web. Outlook renders with Word's engine: it drops <style> blocks, ignores
 * flexbox and grid, and honours only a narrow set of inline properties — so every rule the
 * editor expresses through a class or a stylesheet has to be pushed onto the element itself.
 * Gmail additionally strips anything it does not recognise, which is why the styles below are
 * deliberately plain.
 */

const FONT = "font-family:Arial,Helvetica,sans-serif;"

/** Inline styles applied per tag, in the order the tags appear in the document. */
const STYLES: Record<string, string> = {
  p: `${FONT}font-size:15px;line-height:1.65;color:#030712;margin:0 0 14px;`,
  h1: `${FONT}font-size:24px;line-height:1.3;color:#030712;margin:24px 0 12px;font-weight:700;`,
  h2: `${FONT}font-size:20px;line-height:1.35;color:#030712;margin:22px 0 10px;font-weight:700;`,
  h3: `${FONT}font-size:17px;line-height:1.4;color:#030712;margin:20px 0 8px;font-weight:700;`,
  ul: `${FONT}font-size:15px;line-height:1.65;color:#030712;margin:0 0 14px;padding-left:22px;`,
  ol: `${FONT}font-size:15px;line-height:1.65;color:#030712;margin:0 0 14px;padding-left:22px;`,
  li: 'margin:0 0 6px;',
  blockquote:
    `${FONT}font-size:15px;line-height:1.65;color:#45414f;margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid #E8E2F4;`,
  a: `color:${BRAND.colors.accent};text-decoration:underline;`,
  code: "font-family:'Courier New',Courier,monospace;font-size:14px;background:#F5F3F8;padding:1px 4px;border-radius:3px;",
  pre: "font-family:'Courier New',Courier,monospace;font-size:13px;background:#F5F3F8;padding:12px 14px;border-radius:6px;overflow:auto;margin:0 0 14px;",
  table: 'border-collapse:collapse;margin:0 0 14px;',
  td: `${FONT}font-size:15px;line-height:1.6;color:#030712;border:1px solid #E4E4EC;padding:7px 10px;`,
  th: `${FONT}font-size:15px;line-height:1.6;color:#030712;border:1px solid #E4E4EC;padding:7px 10px;background:#F7F7FA;text-align:left;font-weight:700;`,
  hr: 'border:0;border-top:1px solid #E4E4EC;margin:22px 0;',
  img: 'max-width:100%;height:auto;display:block;border:0;',
}

export function inlineEmailStyles(html: string, base?: { family?: string; size?: string; lineSpacing?: number }): string {
  const family = base?.family?.replace(/'/g, '').trim()
  const size = base?.size?.trim()
  const spacing = lineSpacingOf(base)
  const gap = paragraphGap(spacing)
  const styles = Object.fromEntries(
    Object.entries(STYLES).map(([tag, style]) => {
      let adjusted = style
      if (family) adjusted = adjusted.replace('font-family:Arial,Helvetica,sans-serif;', `font-family:'${family}',Arial,Helvetica,sans-serif;`)
      if (size && !/^h[123]$/.test(tag)) adjusted = adjusted.replace('font-size:15px;', `font-size:${size};`)
      adjusted = adjusted.replace('line-height:1.65;', `line-height:${spacing};`).replace('margin:0 0 14px;', `margin:0 0 ${gap};`)
      return [tag, adjusted]
    }),
  )
  const withBase = (tag: string, attrs: string) => {
    const style = styles[tag]
    const existing = attrs.match(/\sstyle="([^"]*)"/i)
    if (!existing) return `${attrs} style="${style}"`
    return attrs.replace(existing[0], ` style="${style}${existing[1]}"`)
  }
  return html.replace(/<([a-z0-9]+)((?:\s[^>]*)?)>/gi, (match, rawTag: string, attrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!styles[tag]) return match
    return `<${rawTag}${withBase(tag, attrs)}>`
  })
}

/**
 * A plain-text fallback. Every message carries one: some clients prefer it, and a message
 * with no text part is markedly more likely to be filed as spam.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n  • ')
    // Not </li>: the opening tag already broke the line, and closing it too double-spaced
    // every bullet.
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i

/**
 * Normalises a user-typed address, or rejects it. The result is embedded in mail that
 * recipients click, so anything that is not an ordinary web/mail/phone address — most
 * of all `javascript:` and `data:` — has to come back null rather than be passed on.
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (SAFE_SCHEME.test(value)) return value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  return value.includes('@') && !value.includes('/') ? `mailto:${value}` : `https://${value}`
}

/**
 * Removes the `[cid:...]` markers a client leaves in the plain-text alternative where an
 * embedded image sat. They stand in for a signature logo the text part cannot draw, so
 * they carry nothing for a reader and appear mid-sentence, usually straight after a
 * sign-off. The html alternative never contains them.
 */
/** Drops <img> tags whose source is not reachable from a recipient's mail client. */
export function dropUnreachableImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? ''
    return /^(https?:\/\/|data:image\/|\/)/i.test(src) ? tag : ''
  })
}

/**
 * Addresses Gmail serves only to the account that owns them.
 *
 * A signature logo written by Gmail lives on Google's own CDN, and Takeout exports the
 * link but never the bytes. Outside that mailbox the address answers 400, so the picture
 * has been broken since the day the mail was exported and can never load again.
 */
const GOOGLE_PRIVATE_IMAGE = /^https?:\/\/(?:ci\d*\.googleusercontent\.com\/mail-sig\/|mail\.google\.com\/mail\/|docs\.google\.com\/uc\?)/i

/**
 * Removes those pictures so the signature reads as text rather than a broken icon.
 * When `mark` is given — only for mail one of our own addresses sent, where we know whose
 * logo it was — the tenant's own mark is put back in its place instead.
 */
export function healGooglePrivateImages(html: string, mark?: string | null): string {
  return html.replace(/<img\b[^>]*>/gi, tag => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1]?.trim() ?? ''
    if (!GOOGLE_PRIVATE_IMAGE.test(src)) return tag
    if (!mark) return ''
    return tag.replace(/\bsrc\s*=\s*["'][^"']*["']/i, `src="${mark}"`)
  })
}

/**
 * A root-relative address resolves against our own app, and nowhere else. Sent out as-is it
 * points a recipient's client at its own host, so the signature logo the composer showed
 * happily arrives broken in every other mailbox.
 *
 * Only our own asset paths are rewritten. A forwarded message carries the original
 * sender's markup verbatim, and their "/unsubscribe" belongs to their site, not ours —
 * giving it our hostname would put our domain behind someone else's link.
 */
const OWN_ASSET_PATH = /\b(src|href)\s*=\s*(["'])(\/(?:api|brand)\/[^"']*)\2/gi

export function absoluteUrls(html: string, origin: string): string {
  const root = origin.replace(/\/+$/, '')
  return html.replace(OWN_ASSET_PATH, (_tag, attribute, quote, path) => `${attribute}=${quote}${root}${path}${quote}`)
}

export function stripCidPlaceholders(text: string): string {
  return text
    .replace(/\[cid:[^\]\n]{0,300}\]/gi, '')
    // A placeholder on its own line leaves the blank line it sat on behind.
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
}

function declarations(style: string): Record<string, string> {
  return Object.fromEntries(
    style
      .split(';')
      .map(part => part.split(':'))
      .filter(pair => pair.length === 2)
      .map(([name, value]) => [name.trim().toLowerCase(), value.trim()]),
  )
}

function declarationText(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
}

const FRAMELESS = ['none', '0', '0px']

/**
 * Outlook on Windows lays mail out with Word, which ignores padding and borders on an image
 * and centres nothing. A framed or centred image is therefore emitted as a one-cell table,
 * which Word does honour, with the image plain inside it. Everything else is left alone.
 */
export function outlookSafeImages(html: string): string {
  return html.replace(/(<a[^>]*>)?\s*(<img[^>]*>)\s*(<\/a>)?/gi, (whole, open: string | undefined, tag: string, close: string | undefined) => {
    const anchored = Boolean(open && close)
    const image = anchored ? tag : whole
    const style = declarations(/style="([^"]*)"/i.exec(image)?.[1] ?? '')
    const align = (/data-align="(left|center|right)"/i.exec(image)?.[1] ?? 'left').toLowerCase()
    const framed = Boolean(style.border) && !FRAMELESS.includes(style.border)
    const stripped = image.replace(/\sdata-align="[^"]*"/i, '')
    // Nothing to protect this one from: leave it byte for byte as the writer left it.
    if (!framed && align === 'left') return anchored ? `${open}${stripped}${close}` : stripped
    const plain = stripped.replace(
      /\sstyle="[^"]*"/i,
      ` style="${declarationText({ display: 'block', width: style.width ?? '', height: 'auto', border: '0' })}"`,
    )
    const inner = anchored ? `${open}${plain}${close}` : plain
    const cell = declarationText({
      border: framed ? style.border : '',
      'border-radius': framed ? (style['border-radius'] ?? '') : '',
      padding: framed ? (style.padding ?? '0') : '0',
    })
    // align="left" on a table is a float in HTML, and the signature then wrapped itself
    // around the logo. Only centring and right alignment name an alignment at all.
    const aligned = align === 'left' ? '' : ` align="${align}"`
    const outer = align === 'center' ? 'margin:0 auto;' : align === 'right' ? 'margin-left:auto;' : ''
    return `<table role="presentation" border="0" cellpadding="0" cellspacing="0"${aligned} style="border-collapse:separate;${outer}"><tr><td style="${cell}">${inner}</td></tr></table>`
  })
}

/** The open-tracking pixel this app appends to outgoing mail, at its current and its former path. */
export const OWN_PIXEL = /<img[^>]*\/api\/(?:dev\/)?mail\/pixel\/[^>]*>/gi
export const stripOwnPixel = (html: string) => html.replace(OWN_PIXEL, '')
