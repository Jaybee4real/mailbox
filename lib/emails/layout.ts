export type EmailBrand = {
  name: string
  accent: string
  accentOnDark: string
  buttonText?: string
  buttonTextOnDark?: string
  markUrl?: string
  tagline: string
  site: string
  siteUrl: string
}

export type EmailCta = { label: string; url: string }

const THEMES = {
  light: {
    page: '#f3f2f7', card: '#ffffff', well: '#f7f6fb', line: '#e6e3ee',
    ink: '#16121f', dim: '#4a4458', quiet: '#767086', footer: '#5e586c',
  },
  dark: {
    page: '#0b0a10', card: '#15131c', well: '#0f0e15', line: '#2a2636',
    ink: '#f2f0f7', dim: '#b3adc2', quiet: '#857e97', footer: '#958fa6',
  },
}
const LIGHT = THEMES.light

const BODY_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO_FONT = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace"

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string)

const safeUrl = (url: string) => (/^(https?:\/\/|mailto:)[^\s"'<>]+$/.test(url) ? escapeHtml(url) : '#')

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

function brandMark(brand: EmailBrand): string {
  const initial = escapeHtml(brand.name.trim()[0]?.toUpperCase() ?? '•')
  const mark = brand.markUrl
    ? `<img src="${safeUrl(brand.markUrl)}" width="40" height="40" alt="${escapeHtml(brand.name)}" style="display:block;width:40px;height:40px;border:0;outline:none;">`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="40" height="40" align="center" bgcolor="${brand.accent}" class="em-bar" style="width:40px;height:40px;border-radius:10px;background-color:${brand.accent};font-family:${BODY_FONT};font-size:19px;font-weight:700;line-height:40px;color:#ffffff;">${initial}</td></tr></table>`
  return `<tr><td align="center" style="padding:0 0 22px;">${mark}</td></tr>`
}

function button(brand: EmailBrand, cta: EmailCta): string {
  const url = safeUrl(cta.url)
  return `<table role="presentation" class="cta-table" cellpadding="0" cellspacing="0" border="0" style="margin:30px 0 0;">
    <tr><td bgcolor="${brand.accent}" class="cta-cell em-btn" style="border-radius:10px;background-color:${brand.accent};padding:14px 26px;">
      <a href="${url}" target="_blank" class="em-btn-text" style="display:block;font-family:${BODY_FONT};font-size:15px;line-height:18px;font-weight:700;color:${brand.buttonText ?? '#ffffff'};text-decoration:none;">${escapeHtml(cta.label)}&nbsp;&nbsp;&rarr;</a>
    </td></tr>
  </table>
  <p class="em-quiet" style="margin:18px 0 0;font-family:${BODY_FONT};font-size:12.5px;line-height:1.6;color:${LIGHT.quiet};">Button not working? Paste this into your browser:<br><a href="${url}" class="em-accent" style="font-family:${MONO_FONT};font-size:12px;color:${brand.accent};word-break:break-all;text-decoration:none;">${url}</a></p>`
}

/** Key/value rows inside a quiet panel. Values are HTML: escape anything user-supplied before passing it in. */
export function detailsPanel(rows: Array<[string, string]>, title?: string): string {
  const visible = rows.filter(([, value]) => value)
  if (!visible.length) return ''
  const lastIndex = visible.length - 1
  const rowHtml = visible.map(([label, value], index) => {
    const divider = index === lastIndex ? '' : `border-bottom:1px solid ${LIGHT.line};`
    return `<tr>
      <td valign="top" class="meta-key em-quiet em-line" style="padding:11px 12px 11px 0;${divider}width:118px;font-family:${MONO_FONT};font-size:10.5px;line-height:1.9;letter-spacing:0.14em;text-transform:uppercase;color:${LIGHT.quiet};">${escapeHtml(label)}</td>
      <td valign="top" class="em-ink em-line" style="padding:11px 0;${divider}font-family:${BODY_FONT};font-size:14.5px;line-height:1.55;color:${LIGHT.ink};word-break:break-word;">${value}</td>
    </tr>`
  }).join('')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:26px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:12px;">
    ${title ? `<tr><td class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};font-family:${MONO_FONT};font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${LIGHT.quiet};">${escapeHtml(title)}</td></tr>` : ''}
    <tr><td style="padding:4px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowHtml}</table></td></tr>
  </table>`
}

export function calloutPanel(brand: EmailBrand, title: string, headlineHtml: string, bodyHtml = ''): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:24px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:12px;">
    <tr><td style="padding:18px 20px;">
      <p class="em-accent" style="margin:0 0 8px;font-family:${MONO_FONT};font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${brand.accent};">${escapeHtml(title)}</p>
      <p class="em-ink" style="margin:0;font-family:${BODY_FONT};font-size:18px;line-height:1.4;font-weight:600;color:${LIGHT.ink};">${headlineHtml}</p>
      ${bodyHtml ? `<div class="em-dim" style="margin:8px 0 0;font-family:${BODY_FONT};font-size:14.5px;line-height:1.6;color:${LIGHT.dim};">${bodyHtml}</div>` : ''}
    </td></tr>
  </table>`
}

export function codePanel(brand: EmailBrand, code: string, expiry: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-well" style="margin:26px 0 0;background-color:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:12px;">
    <tr>
      <td class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};font-family:${MONO_FONT};font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${LIGHT.quiet};">Your code</td>
      <td align="right" class="em-quiet em-line" style="padding:12px 18px;border-bottom:1px solid ${LIGHT.line};font-family:${MONO_FONT};font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:${LIGHT.quiet};">${escapeHtml(expiry)}</td>
    </tr>
    <tr><td colspan="2" align="center" class="readout em-accent" style="padding:26px 12px 24px;font-family:${MONO_FONT};font-size:36px;line-height:1;font-weight:600;letter-spacing:0.32em;text-indent:0.32em;color:${brand.accent};">${escapeHtml(code)}</td></tr>
  </table>`
}

export function bulletList(items: string[]): string {
  const visible = items.filter(Boolean)
  if (!visible.length) return ''
  return `<ul class="em-dim" style="margin:12px 0 0;padding-left:20px;font-family:${BODY_FONT};font-size:15px;line-height:1.65;color:${LIGHT.dim};">${visible.map(item => `<li style="margin:0 0 4px;">${item}</li>`).join('')}</ul>`
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
  recipient?: string
  reason?: string
}

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
    .outer { padding: 26px 12px 40px !important; }
    .card-pad { padding: 30px 22px 30px !important; }
    .headline { font-size: 24px !important; }
    .meta-key { width: 88px !important; }
    .readout { font-size: 28px !important; letter-spacing: 0.22em !important; text-indent: 0.22em !important; }
    .cta-table { width: 100% !important; }
    .cta-cell { text-align: center !important; }
  }
</style>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body class="em-page" style="margin:0;padding:0;background-color:${LIGHT.page};">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${preview}${'&#8199;&#65279;&#847; '.repeat(40)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.page}" class="em-page" style="background-color:${LIGHT.page};">
    <tr><td align="center" class="outer" style="padding:34px 16px 52px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        ${brandMark(brand)}
        <tr><td bgcolor="${LIGHT.card}" class="em-card" style="background-color:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:0 64px;font-size:0;line-height:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td height="3" bgcolor="${brand.accent}" class="em-bar" style="height:3px;font-size:0;line-height:0;background-color:${brand.accent};border-radius:0 0 3px 3px;">&nbsp;</td></tr></table>
            </td></tr>
            <tr><td class="card-pad" style="padding:36px 42px 38px;">
              <p class="em-accent" style="margin:0 0 16px;font-family:${MONO_FONT};font-size:11px;line-height:1.4;font-weight:600;letter-spacing:0.18em;text-transform:uppercase;color:${brand.accent};">${escapeHtml(brand.name)}&nbsp;&nbsp;&middot;&nbsp;&nbsp;${escapeHtml(input.eyebrow)}</p>
              <h1 class="headline em-ink" style="margin:0 0 14px;font-family:${BODY_FONT};font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-0.015em;color:${LIGHT.ink};">${escapeHtml(input.heading)}</h1>
              <div class="em-dim" style="font-family:${BODY_FONT};font-size:15.5px;line-height:1.65;color:${LIGHT.dim};">${input.bodyHtml}</div>
              ${input.moduleHtml ?? ''}
              ${input.cta ? button(brand, input.cta) : ''}
              ${input.noteHtml ? `<div class="em-quiet em-line" style="margin:30px 0 0;padding:18px 0 0;border-top:1px solid ${LIGHT.line};font-family:${BODY_FONT};font-size:13px;line-height:1.6;color:${LIGHT.quiet};">${input.noteHtml}</div>` : ''}
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="em-quiet" style="padding:24px 8px 0;font-family:${MONO_FONT};font-size:11px;line-height:1.75;letter-spacing:0.03em;color:${LIGHT.quiet};">
          <p class="em-footer" style="margin:0 0 6px;letter-spacing:0.14em;text-transform:uppercase;color:${LIGHT.footer};">${escapeHtml(brand.name)} &mdash; ${escapeHtml(brand.tagline)}</p>
          ${input.recipient ? `<p style="margin:0;">Sent to ${escapeHtml(input.recipient)}${input.reason ? ` ${escapeHtml(input.reason)}` : ''}.</p>` : ''}
          <p style="margin:0;"><a href="${safeUrl(brand.siteUrl)}" class="em-footer" style="color:${LIGHT.footer};text-decoration:none;">${escapeHtml(brand.site)}</a></p>
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
}): string {
  const details = (input.details ?? []).filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`)
  return [
    input.heading,
    '',
    ...input.paragraphs.flatMap(paragraph => [paragraph, '']),
    ...(details.length ? [...details, ''] : []),
    ...(input.cta ? [`${input.cta.label}:`, input.cta.url, ''] : []),
    ...(input.note?.length ? [...input.note, ''] : []),
    '—',
    `${input.brand.name} · ${input.brand.tagline} · ${input.brand.site}`,
  ].join('\n')
}
