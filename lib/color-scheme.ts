// Mail is styled inline, and only a stylesheet rule marked !important can override an inline
// colour, so the other scheme is a prefers-color-scheme block of per-element classes. Gmail
// drops that block and keeps inverting the inline styles itself.

type Rgb = [number, number, number]
type Hsl = [number, number, number]
export type SchemeBase = 'light' | 'dark'

const NAMED: Record<string, Rgb> = { white: [255, 255, 255], black: [0, 0, 0] }
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['style', 'script', 'title', 'textarea'])
const COLOR_TOKEN = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)|\b(?:white|black)\b/i
const SURFACE: Record<SchemeBase, Rgb> = { light: [28, 28, 30], dark: [255, 255, 255] }

function parseColor(value: string | undefined): Rgb | null {
  if (!value) return null
  const raw = value.trim().toLowerCase().replace(/\s*!important$/, '')
  if (NAMED[raw]) return NAMED[raw]
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)
  if (hex) {
    const full = hex[1].length === 3 ? [...hex[1]].map(digit => digit + digit).join('') : hex[1]
    return [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16)) as Rgb
  }
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgb && (rgb[4] === undefined || Number(rgb[4]) >= 0.9)) return [rgb[1], rgb[2], rgb[3]].map(Number) as Rgb
  return null
}

const toHex = (color: Rgb) => `#${color.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`

function luminance(color: Rgb): number {
  const [red, green, blue] = color.map(channel => {
    const scaled = channel / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(first: Rgb, second: Rgb): number {
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left)
  return (high + 0.05) / (low + 0.05)
}

function toHsl([red, green, blue]: Rgb): Hsl {
  const [scaledRed, scaledGreen, scaledBlue] = [red / 255, green / 255, blue / 255]
  const max = Math.max(scaledRed, scaledGreen, scaledBlue)
  const min = Math.min(scaledRed, scaledGreen, scaledBlue)
  const lightness = (max + min) / 2
  if (max === min) return [0, 0, lightness]
  const delta = max - min
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  const hue =
    max === scaledRed ? (scaledGreen - scaledBlue) / delta + (scaledGreen < scaledBlue ? 6 : 0)
    : max === scaledGreen ? (scaledBlue - scaledRed) / delta + 2
    : (scaledRed - scaledGreen) / delta + 4
  return [hue / 6, saturation, lightness]
}

function fromHsl([hue, saturation, lightness]: Hsl): Rgb {
  if (!saturation) return [lightness * 255, lightness * 255, lightness * 255]
  const upper = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const lower = 2 * lightness - upper
  const channel = (offset: number) => {
    let tint = hue + offset
    if (tint < 0) tint += 1
    if (tint > 1) tint -= 1
    if (tint < 1 / 6) return lower + (upper - lower) * 6 * tint
    if (tint < 1 / 2) return upper
    if (tint < 2 / 3) return lower + (upper - lower) * (2 / 3 - tint) * 6
    return lower
  }
  return [channel(1 / 3) * 255, channel(0) * 255, channel(-1 / 3) * 255]
}

const withLightness = (color: Rgb, lightness: number, saturationScale = 1): Rgb => {
  const [hue, saturation] = toHsl(color)
  return fromHsl([hue, saturation * saturationScale, Math.min(1, Math.max(0, lightness))])
}

function flipSurface(color: Rgb, base: SchemeBase, kind: 'fill' | 'border'): Rgb {
  const lightness = toHsl(color)[2]
  if (base === 'light') {
    if (lightness <= 0.75) return color
    return withLightness(color, (1 - lightness) * 0.6 + (kind === 'fill' ? 0.06 : 0.2), 0.7)
  }
  if (lightness >= 0.25) return color
  return withLightness(color, kind === 'fill' ? 0.94 + lightness * 0.6 : 0.9 - lightness * 0.6)
}

function fitText(color: Rgb, surface: Rgb): Rgb {
  if (contrast(color, surface) >= 4.5) return color
  const towardLight = luminance(surface) < 0.18
  let lightness = 1 - toHsl(color)[2]
  let candidate = withLightness(color, lightness)
  while (contrast(candidate, surface) < 4.5 && lightness > 0 && lightness < 1) {
    lightness += towardLight ? 0.02 : -0.02
    candidate = withLightness(color, lightness)
  }
  return candidate
}

const sameColor = (first: Rgb, second: Rgb) => toHex(first) === toHex(second)

function declarations(style: string): Map<string, string> {
  const found = new Map<string, string>()
  let depth = 0
  let start = 0
  const take = (end: number) => {
    const part = style.slice(start, end)
    const colon = part.indexOf(':')
    if (colon > 0) found.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim())
    start = end + 1
  }
  for (let index = 0; index < style.length; index++) {
    const char = style[index]
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === ';' && !depth) take(index)
  }
  take(style.length)
  return found
}

function attribute(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined
}

function colorsOf(tag: string, attrs: string) {
  const style = declarations((attribute(attrs, 'style') ?? '').replace(/&quot;/g, '"'))
  const backgroundShorthand = style.get('background')
  const fill =
    parseColor(style.get('background-color')) ??
    (backgroundShorthand && !/url\(/i.test(backgroundShorthand)
      ? parseColor(backgroundShorthand) ?? parseColor(backgroundShorthand.match(COLOR_TOKEN)?.[0])
      : null) ??
    parseColor(attribute(attrs, 'bgcolor'))
  const borderValue = ['border-color', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left']
    .map(name => style.get(name))
    .find(value => value && COLOR_TOKEN.test(value))
  return {
    text: parseColor(style.get('color')) ?? (tag === 'font' ? parseColor(attribute(attrs, 'color')) : null),
    fill,
    border: parseColor(borderValue?.match(COLOR_TOKEN)?.[0]),
  }
}

type Frame = { tag: string; sourceText: Rgb; targetText: Rgb; targetFill: Rgb }

export function designsForDark(html: string): boolean {
  return /prefers-color-scheme\s*:\s*dark/i.test(html)
}

export function adaptiveEmail(html: string, base: SchemeBase = 'light'): string {
  if (!html.trim() || /prefers-color-scheme/i.test(html)) return html
  const other = base === 'light' ? 'dark' : 'light'
  const rules = new Map<string, string>()
  const root: Frame = {
    tag: '#root',
    sourceText: [0, 0, 0],
    targetText: fitText([0, 0, 0], SURFACE[base]),
    targetFill: SURFACE[base],
  }
  const stack: Frame[] = [root]
  const tagPattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?)\s*(\/?)>/g
  let output = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(html))) {
    const [whole, closing, rawTag, attrs = '', selfClosing] = match
    output += html.slice(cursor, match.index)
    cursor = match.index + whole.length
    if (!rawTag) {
      output += whole
      continue
    }
    const tag = rawTag.toLowerCase()
    if (closing) {
      const depth = stack.map(frame => frame.tag).lastIndexOf(tag)
      if (depth > 0) stack.length = depth
      output += whole
      continue
    }
    if (RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, cursor)
      const stop = end === -1 ? html.length : end
      output += whole + html.slice(cursor, stop)
      cursor = stop
      tagPattern.lastIndex = stop
      continue
    }
    const parent = stack[stack.length - 1]
    const own = colorsOf(tag, attrs)
    const sourceText = own.text ?? parent.sourceText
    const targetFill = own.fill ? flipSurface(own.fill, base, 'fill') : parent.targetFill
    const targetText = fitText(sourceText, targetFill)
    const shownWithoutRule = own.text ?? parent.targetText
    const declarationsForOther = [
      !sameColor(targetText, shownWithoutRule) && `color:${toHex(targetText)}!important`,
      own.fill && !sameColor(targetFill, own.fill) && `background-color:${toHex(targetFill)}!important`,
      own.border && !sameColor(flipSurface(own.border, base, 'border'), own.border) &&
        `border-color:${toHex(flipSurface(own.border, base, 'border'))}!important`,
    ].filter(Boolean).join(';')

    let tagHtml = whole
    if (declarationsForOther) {
      const name = rules.get(declarationsForOther) ?? `nc-${other[0]}${rules.size}`
      rules.set(declarationsForOther, name)
      const existing = attrs.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      tagHtml = existing
        ? whole.replace(existing[0], ` class="${`${existing[1] ?? existing[2] ?? ''} ${name}`.trim()}"`)
        : whole.replace(/^<[a-zA-Z0-9]+/, opening => `${opening} class="${name}"`)
    }
    output += tagHtml
    if (!selfClosing && !/\/\s*$/.test(attrs) && !VOID.has(tag)) stack.push({ tag, sourceText, targetText, targetFill })
  }
  output += html.slice(cursor)

  const css = [...rules].map(([body, name]) => `.${name}{${body}}`).join('')
  const head =
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme: ${other}){${css}}</style>`
  if (/<head[\s>]/i.test(output)) return output.replace(/<head([^>]*)>/i, `<head$1>${head}`)
  if (/<html[\s>]/i.test(output)) return output.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`)
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${output}</body></html>`
}

// The reader's theme decides, not the device's: a dark app on a light device still gets the dark design.
export function pinColorScheme(html: string, dark: boolean): string {
  return html.replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi, (_, scheme: string) =>
    (scheme.toLowerCase() === 'dark') === dark ? '(min-width:0px)' : '(max-width:0px)',
  )
}
