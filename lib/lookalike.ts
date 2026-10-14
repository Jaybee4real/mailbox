const HOMOGLYPHS: Record<string, string> = {
  'а': 'a', 'А': 'a', 'в': 'b', 'В': 'b', 'ь': 'b', 'с': 'c', 'С': 'c', 'ԁ': 'd', 'е': 'e', 'Е': 'e', 'ё': 'e',
  'һ': 'h', 'Н': 'h', 'і': 'i', 'І': 'l', 'ј': 'j', 'Ј': 'j', 'к': 'k', 'К': 'k', 'ӏ': 'l', 'Ӏ': 'l',
  'м': 'm', 'М': 'm', 'п': 'n', 'о': 'o', 'О': 'o', 'р': 'p', 'Р': 'p', 'ԛ': 'q', 'г': 'r', 'ѕ': 's', 'Ѕ': 's',
  'т': 't', 'Т': 't', 'у': 'y', 'У': 'y', 'ү': 'y', 'х': 'x', 'Х': 'x', 'ԝ': 'w', 'Ԝ': 'w',
  'α': 'a', 'Α': 'a', 'β': 'b', 'Β': 'b', 'ε': 'e', 'Ε': 'e', 'Η': 'h', 'η': 'n', 'ι': 'i', 'Ι': 'l',
  'κ': 'k', 'Κ': 'k', 'Μ': 'm', 'ν': 'v', 'Ν': 'n', 'ο': 'o', 'Ο': 'o', 'ρ': 'p', 'Ρ': 'p', 'τ': 't', 'Τ': 't',
  'υ': 'u', 'Υ': 'y', 'χ': 'x', 'Χ': 'x', 'ω': 'w', 'γ': 'y', 'Ζ': 'z',
  'ա': 'w', 'ց': 'g', 'հ': 'h', 'ո': 'n', 'ս': 'u', 'օ': 'o', 'ք': 'p',
  'Ꭺ': 'a', 'Ᏼ': 'b', 'Ꮯ': 'c', 'Ꭼ': 'e', 'Ꮋ': 'h', 'Ꭻ': 'j', 'Ꮶ': 'k', 'Ꮮ': 'l', 'Ꮇ': 'm', 'Ꮲ': 'p', 'Ꮪ': 's', 'Ꭲ': 't', 'Ꮃ': 'w',
  'ɡ': 'g', 'ı': 'i', 'I': 'l',
}

export function skeleton(text: string): string {
  const folded = [...text.normalize('NFKC')].map(glyph => HOMOGLYPHS[glyph] ?? glyph).join('').toLowerCase()
  return folded.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/0/g, 'o').replace(/1/g, 'l')
}

export function levenshtein(left: string, right: string): number {
  const first = [...left]
  const second = [...right]
  let previous = Array.from({ length: second.length + 1 }, (_unused, index) => index)
  for (let row = 1; row <= first.length; row++) {
    const current = [row]
    for (let column = 1; column <= second.length; column++) {
      const substitution = previous[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1)
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution))
    }
    previous = current
  }
  return previous[second.length]
}

export function similarity(left: string, right: string): number {
  const longest = Math.max([...left].length, [...right].length)
  return longest === 0 ? 1 : 1 - levenshtein(left, right) / longest
}

const PUNY_BASE = 36

function decodePunycodeLabel(encoded: string): string | null {
  const delimiter = encoded.lastIndexOf('-')
  const output = delimiter > 0 ? [...encoded.slice(0, delimiter)].map(glyph => glyph.codePointAt(0)!) : []
  let cursor = delimiter > 0 ? delimiter + 1 : 0
  let codePoint = 128
  let bias = 72
  let position = 0
  while (cursor < encoded.length) {
    const start = position
    let weight = 1
    for (let step = PUNY_BASE; ; step += PUNY_BASE) {
      if (cursor >= encoded.length) return null
      const symbol = encoded.charCodeAt(cursor++)
      const digit = symbol >= 48 && symbol <= 57 ? symbol - 22
        : symbol >= 97 && symbol <= 122 ? symbol - 97
        : symbol >= 65 && symbol <= 90 ? symbol - 65
        : PUNY_BASE
      if (digit >= PUNY_BASE) return null
      position += digit * weight
      const threshold = step <= bias ? 1 : step >= bias + 26 ? 26 : step - bias
      if (digit < threshold) break
      weight *= PUNY_BASE - threshold
    }
    const length = output.length + 1
    let delta = start === 0 ? Math.floor((position - start) / 700) : (position - start) >> 1
    delta += Math.floor(delta / length)
    let scaled = 0
    while (delta > 455) {
      delta = Math.floor(delta / 35)
      scaled += PUNY_BASE
    }
    bias = scaled + Math.floor((36 * delta) / (delta + 38))
    codePoint += Math.floor(position / length)
    position %= length
    if (codePoint > 0x10ffff) return null
    output.splice(position, 0, codePoint)
    position += 1
  }
  return String.fromCodePoint(...output)
}

export function unicodeHost(host: string): string {
  return host
    .split('.')
    .map(label => (/^xn--/i.test(label) ? decodePunycodeLabel(label.slice(4).toLowerCase()) ?? label : label))
    .join('.')
}

const SCRIPTS = [
  'Cyrillic', 'Greek', 'Armenian', 'Cherokee', 'Georgian', 'Coptic', 'Hebrew', 'Arabic', 'Devanagari',
  'Bengali', 'Thai', 'Lao', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Ethiopic', 'Lisu', 'Canadian_Aboriginal',
  'Runic', 'Ogham', 'Tifinagh', 'Vai', 'Bamum', 'Osage', 'Adlam', 'Glagolitic', 'Gothic', 'Old_Italic',
].map(name => ({ name: name.replace(/_/g, ' '), pattern: new RegExp(`\\p{Script=${name}}`, 'u') }))

const LATIN = new RegExp('\\p{Script=Latin}', 'u')
const LETTER = new RegExp('\\p{L}', 'u')
const WORD_BREAK = new RegExp('[^\\p{L}\\p{M}\\p{N}]+', 'u')

export type MixedScript = { word: string; script: string }

export function mixedScriptWord(text: string): MixedScript | null {
  for (const word of text.normalize('NFC').split(WORD_BREAK)) {
    const letters = [...word].filter(glyph => LETTER.test(glyph))
    if (!letters.some(glyph => LATIN.test(glyph))) continue
    const foreign = letters.find(glyph => !LATIN.test(glyph))
    if (!foreign) continue
    const script = SCRIPTS.find(candidate => candidate.pattern.test(foreign))?.name ?? 'non-Latin'
    return { word, script }
  }
  return null
}
