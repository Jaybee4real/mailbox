import type { RequestDetails } from '../client-context.ts'

export type EmailBrand = {
  name: string
  accent: string
  accentOnDark: string
  accentInk?: string
  buttonText?: string
  buttonTextOnDark?: string
  markUrl?: string
  tagline: string
  site: string
  siteUrl: string
  poweredBy?: boolean
}

export type EmailCta = { label: string; url: string }

const THEMES = {
  light: {
    page: '#f7f7fa', card: '#ffffff', well: '#f4f4f8', line: '#e4e4ec',
    ink: '#16121f', dim: '#45414f', quiet: '#6e6a7c', footer: '#6e6a7c',
  },
  dark: {
    page: '#000000', card: '#111113', well: '#18181b', line: '#2a2a2e',
    ink: '#f4f4f7', dim: '#c6c4d0', quiet: '#928fa1', footer: '#928fa1',
  },
}
const LIGHT = THEMES.light

export const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const SERIF = "Georgia,'Times New Roman',Times,serif"
export const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono','Courier New',monospace"

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)

const safeUrl = (url: string) => (/^(https?:\/\/|mailto:)[^\s"'<>]+$/.test(url) ? escapeHtml(url) : '#')

const ink = (brand: EmailBrand) => brand.accentInk ?? brand.accent

function darkRules(brand: EmailBrand, scope = '') {
  const dark = THEMES.dark
  const at = (name: string) => `${scope}.${name}`
  return {
    colors: [
      `${at('em-ink')} { color: ${dark.ink} !important; }`,
      `${at('em-dim')} { color: ${dark.dim} !important; }`,
      `${at('em-quiet')} { color: ${dark.quiet} !important; }`,
      `${at('em-footer')} { color: ${dark.footer} !important; }`,
      `${at('em-accent')} { color: ${brand.accentOnDark} !important; }`,
      `${at('em-btn-text')} { color: ${brand.buttonTextOnDark ?? '#0b0a10'} !important; }`,
      `${at('em-line')} { border-color: ${dark.line} !important; }`,
      `${at('em-rule')} { border-left-color: ${brand.accentOnDark} !important; }`,
    ],
    backgrounds: [
      `${at('em-page')} { background-color: ${dark.page} !important; }`,
      `${at('em-card')} { background-color: ${dark.card} !important; border-color: ${dark.line} !important; }`,
      `${at('em-well')} { background-color: ${dark.well} !important; border-color: ${dark.line} !important; }`,
      `${at('em-btn')} { background-color: ${brand.accentOnDark} !important; }`,
      `${at('em-bar')} { background-color: ${brand.accentOnDark} !important; }`,
    ],
  }
}

function themeCss(brand: EmailBrand): string {
  const media = darkRules(brand)
  const outlookColors = darkRules(brand, '[data-ogsc] ')
  const outlookBackgrounds = darkRules(brand, '[data-ogsb] ')
  return `@media (prefers-color-scheme: dark) {
    ${[...media.colors, ...media.backgrounds].join('\n    ')}
  }
  ${outlookColors.colors.join('\n  ')}
  ${outlookBackgrounds.backgrounds.join('\n  ')}`
}

function header(brand: EmailBrand): string {
  const initial = escapeHtml(brand.name.trim()[0]?.toUpperCase() ?? '•')
  const mark = brand.markUrl
    ? `<img src="${safeUrl(brand.markUrl)}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border:0;outline:none;border-radius:8px;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="32" height="32" align="center" bgcolor="${brand.accent}" class="em-bar em-btn-text" style="width:32px;height:32px;border-radius:8px;background-color:${brand.accent};font-family:${SANS};font-size:16px;font-weight:700;line-height:32px;color:${brand.buttonText ?? '#ffffff'};">${initial}</td></tr></table>`
  return `<tr><td style="padding:0 4px 18px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="middle" style="padding:0 12px 0 0;">${mark}</td>
      <td valign="middle" class="em-ink" style="font-family:${SANS};font-size:16px;line-height:20px;font-weight:600;color:${LIGHT.ink};">${escapeHtml(brand.name)}</td>
    </tr></table>
  </td></tr>`
}

function button(brand: EmailBrand, cta: EmailCta): string {
  const url = safeUrl(cta.url)
  return `<table role="presentation" class="cta-table" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
    <tr><td bgcolor="${brand.accent}" class="cta-cell em-btn" style="border-radius:8px;background-color:${brand.accent};padding:13px 24px;">
      <a href="${url}" target="_blank" class="em-btn-text" style="display:block;font-family:${SANS};font-size:15px;line-height:20px;font-weight:600;color:${brand.buttonText ?? '#ffffff'};text-decoration:none;">${escapeHtml(cta.label)}</a>
    </td></tr>
  </table>
  <p class="em-quiet" style="margin:16px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${LIGHT.quiet};">Button not working? Paste this into your browser:<br><a href="${url}" class="em-accent" style="font-family:${MONO};font-size:12px;color:${ink(brand)};word-break:break-all;text-decoration:none;">${url}</a></p>`
}

const PANEL_LABEL = `font-family:${SANS};font-size:12px;line-height:1.5;font-weight:600;color:${LIGHT.quiet};`

/** Key/value rows inside a quiet panel. Values are HTML: escape anything user-supplied before passing it in. */
export function detailsPanel(rows: Array<[string, string]>, title?: string): string {
  const visible = rows.filter(([, value]) => value)
  if (!visible.length) return ''
  const lastIndex = visible.length - 1
  const rowHtml = visible.map(([label, value], index) => {
    const divider = index === lastIndex ? '' : `border-bottom:1px solid ${LIGHT.line};`
    return `<tr>
      <td valign="top" class="meta-key em-quiet em-line" style="padding:11px 14px 11px 0;${divider}width:112px;font-family:${SANS};font-size:13px;line-height:1.6;color:${LIGHT.quiet};">${escapeHtml(label)}</td>
      <td valign="top" class="em-ink em-line" style="padding:11px 0;${divider}font-family:${SANS};font-size:15px;line-height:1.55;color:${LIGHT.ink};word-break:break-word;">${value}</td>
    </tr>`
  }).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:24px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:8px;">
    ${title ? `<tr><td class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};${PANEL_LABEL}">${escapeHtml(title)}</td></tr>` : ''}
    <tr><td style="padding:2px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowHtml}</table></td></tr>
  </table>`
}

export type RequestNotice = {
  details: RequestDetails
  wasntYou: string
  helpUrl?: string
  devicesUrl?: string
}

const requestRows = (details: RequestDetails): Array<[string, string]> => [
  ['Time', details.time],
  ['IP address', details.ip ?? 'Unknown'],
  ['Location', details.location ?? 'Unknown'],
  ['Device', details.device],
]

export function requestPanel(brand: EmailBrand, notice: RequestNotice): string {
  const rows = requestRows(notice.details).map(([label, value]): [string, string] => [label, escapeHtml(value)])
  const href = notice.helpUrl ? safeUrl(notice.helpUrl) : '#'
  const link = href === '#' ? '' : ` <a href="${href}" class="em-accent" style="color:${ink(brand)};text-decoration:underline;word-break:break-all;">${href}</a>`
  const devicesHref = notice.devicesUrl ? safeUrl(notice.devicesUrl) : '#'
  const devices = devicesHref === '#' ? '' : `${link ? ' &middot;' : ''} <a href="${devicesHref}" class="em-accent" style="color:${ink(brand)};text-decoration:underline;">Review signed-in devices</a>`
  return `${detailsPanel(rows, 'Request details')}
  <p class="em-dim" style="margin:12px 0 0;font-family:${SANS};font-size:14px;line-height:1.6;color:${LIGHT.dim};"><strong>Wasn't you?</strong> ${escapeHtml(notice.wasntYou)}${link}${devices}</p>`
}

export function requestText(notice: RequestNotice): string[] {
  return [
    'Request details',
    ...requestRows(notice.details).map(([label, value]) => `${label}: ${value}`),
    '',
    `Wasn't you? ${notice.wasntYou}${notice.helpUrl ? ` ${notice.helpUrl}` : ''}`,
    ...(notice.devicesUrl ? [`Review signed-in devices: ${notice.devicesUrl}`] : []),
  ]
}

export const withRequestText = (text: string, notice: RequestNotice): string => `${text}\n\n${requestText(notice).join('\n')}`

export function calloutPanel(brand: EmailBrand, title: string, headlineHtml: string, bodyHtml = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:24px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:8px;">
    <tr><td class="em-rule" style="padding:18px 20px;border-left:3px solid ${brand.accent};border-radius:8px 0 0 8px;">
      <p class="em-accent" style="margin:0 0 6px;font-family:${SANS};font-size:13px;line-height:1.5;font-weight:600;color:${ink(brand)};">${escapeHtml(title)}</p>
      ${headlineHtml ? `<p class="em-ink" style="margin:0;font-family:${SERIF};font-size:20px;line-height:1.35;font-weight:400;color:${LIGHT.ink};">${headlineHtml}</p>` : ''}
      ${bodyHtml ? `<div class="em-dim" style="margin:${headlineHtml ? '8px' : '0'} 0 0;font-family:${SANS};font-size:15px;line-height:1.6;color:${LIGHT.dim};">${bodyHtml}</div>` : ''}
    </td></tr>
  </table>`
}

export function codePanel(code: string, expiry: string): string {
  const unbroken = escapeHtml(code.replace(/[\s-]+/g, ''))
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:24px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:8px;">
    <tr>
      <td class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};${PANEL_LABEL}">Your code</td>
      <td align="right" class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};${PANEL_LABEL}">${escapeHtml(expiry)}</td>
    </tr>
    <tr><td colspan="2" align="center" class="readout em-ink" style="padding:24px 12px 22px;font-family:${MONO};font-size:40px;line-height:1.1;font-weight:700;letter-spacing:0;color:${LIGHT.ink};-webkit-user-select:all;user-select:all;">${unbroken}</td></tr>
  </table>`
}

/** A body paragraph outside the main copy block. Pass escaped HTML. */
export function paragraph(html: string, options: { strong?: boolean; top?: number } = {}): string {
  const color = options.strong ? LIGHT.ink : LIGHT.dim
  return `<p class="${options.strong ? 'em-ink' : 'em-dim'}" style="margin:${options.top ?? 24}px 0 0;font-family:${SANS};font-size:15px;line-height:1.65;color:${color};${options.strong ? 'font-weight:600;' : ''}">${html}</p>`
}

export function bulletList(items: string[]): string {
  const visible = items.filter(Boolean)
  if (!visible.length) return ''
  return `<ul class="em-dim" style="margin:12px 0 0;padding-left:20px;font-family:${SANS};font-size:15px;line-height:1.65;color:${LIGHT.dim};">${visible.map(item => `<li style="margin:0 0 4px;">${item}</li>`).join('')}</ul>`
}

export type EmailLayoutInput = {
  brand: EmailBrand
  preview?: string
  eyebrow: string
  heading: string
  bodyHtml: string
  moduleHtml?: string
  cta?: EmailCta
  noteHtml?: string
  request?: RequestNotice
  recipient?: string
  reason?: string
}

const poweredBy = `<p style="margin:10px 0 0;">Powered by <a href="https://vela.novacraft.africa" class="em-footer" style="color:${LIGHT.footer};text-decoration:underline;">Vela Mail</a> by <a href="https://novacraft.africa" class="em-footer" style="color:${LIGHT.footer};text-decoration:underline;">Novacraft</a></p>`

export function emailLayout(input: EmailLayoutInput): string {
  const { brand } = input
  const preview = escapeHtml(input.preview ?? '')
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${escapeHtml(input.heading)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; }
  a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
  ${themeCss(brand)}
  @media (max-width: 600px) {
    .outer { padding: 24px 12px 36px !important; }
    .card-pad { padding: 28px 22px 30px !important; }
    .headline { font-size: 24px !important; }
    .meta-key { width: 86px !important; }
    .readout { font-size: 34px !important; }
    .cta-table { width: 100% !important; }
    .cta-cell { text-align: center !important; }
  }
</style>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body class="em-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${preview}${'&#8199;&#65279;&#847; '.repeat(40)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.page}" class="em-page" style="background-color:${LIGHT.page};">
    <tr><td align="center" class="outer" style="padding:32px 16px 48px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        ${header(brand)}
        <tr><td bgcolor="${LIGHT.card}" class="em-card" style="background-color:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td height="4" bgcolor="${brand.accent}" class="em-bar" style="height:4px;font-size:0;line-height:0;background-color:${brand.accent};border-radius:12px 12px 0 0;">&nbsp;</td></tr>
            <tr><td class="card-pad" style="padding:32px 40px 36px;">
              <p class="em-accent" style="margin:0 0 10px;font-family:${SANS};font-size:13px;line-height:1.4;font-weight:600;color:${ink(brand)};">${escapeHtml(input.eyebrow)}</p>
              <h1 class="headline em-ink" style="margin:0 0 14px;font-family:${SERIF};font-size:28px;line-height:1.25;font-weight:400;color:${LIGHT.ink};">${escapeHtml(input.heading)}</h1>
              <div class="em-dim" style="font-family:${SANS};font-size:15px;line-height:1.65;color:${LIGHT.dim};">${input.bodyHtml}</div>
              ${input.moduleHtml ?? ''}
              ${input.cta ? button(brand, input.cta) : ''}
              ${input.request ? requestPanel(brand, input.request) : ''}
              ${input.noteHtml ? `<div class="em-quiet em-line" style="margin:28px 0 0;padding:18px 0 0;border-top:1px solid ${LIGHT.line};font-family:${SANS};font-size:13px;line-height:1.6;color:${LIGHT.quiet};">${input.noteHtml}</div>` : ''}
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="em-footer" style="padding:22px 4px 0;font-family:${SANS};font-size:12px;line-height:1.7;color:${LIGHT.footer};">
          <p style="margin:0 0 4px;font-weight:600;">${escapeHtml(brand.name)} &middot; ${escapeHtml(brand.tagline)}</p>
          ${input.recipient ? `<p style="margin:0;">Sent to ${escapeHtml(input.recipient)}${input.reason ? ` ${escapeHtml(input.reason)}` : ''}.</p>` : ''}
          <p style="margin:0;"><a href="${safeUrl(brand.siteUrl)}" class="em-footer" style="color:${LIGHT.footer};text-decoration:none;">${escapeHtml(brand.site)}</a></p>
          ${brand.poweredBy ? poweredBy : ''}
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body></html>`
}

export function emailText(input: {
  brand: EmailBrand
  heading: string
  paragraphs: string[]
  details?: Array<[string, string]>
  cta?: EmailCta
  note?: string[]
  request?: RequestNotice
}): string {
  const details = (input.details ?? []).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`)
  return [
    input.heading,
    '',
    ...input.paragraphs.flatMap(paragraph => [paragraph, '']),
    ...(details.length ? [...details, ''] : []),
    ...(input.cta ? [`${input.cta.label}:`, input.cta.url, ''] : []),
    ...(input.request ? [...requestText(input.request), ''] : []),
    ...(input.note?.length ? [...input.note, ''] : []),
    '—',
    `${input.brand.name} · ${input.brand.tagline} · ${input.brand.site}`,
    ...(input.brand.poweredBy ? ['Powered by Vela Mail by Novacraft'] : []),
  ].join('\n')
}
