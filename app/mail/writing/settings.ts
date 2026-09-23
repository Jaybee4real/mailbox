export type SpellLanguage = 'en-GB' | 'en-US'

export type WritingSettings = {
  autoCapitalize: boolean
  capitalizeI: boolean
  spellcheck: boolean
  spellLanguage: SpellLanguage
  ignoreCapitals: boolean
  ignoreWithNumbers: boolean
  repeatedWords: boolean
  autocorrect: boolean
  personalWords: string[]
  grammar: boolean
  tabIndent: boolean
  doubleTabMs: number
  templateShortcuts: boolean
  cleanPaste: boolean
  nairaFormat: boolean
  wordCount: boolean
  checkAttachment: boolean
  checkEmptyBody: boolean
  checkPlaceholders: boolean
  checkGreeting: boolean
  checkExternal: boolean
  externalThreshold: number
}

export const WRITING_DEFAULTS: WritingSettings = {
  autoCapitalize: true,
  capitalizeI: true,
  spellcheck: true,
  spellLanguage: 'en-GB',
  ignoreCapitals: true,
  ignoreWithNumbers: true,
  repeatedWords: true,
  autocorrect: true,
  personalWords: [],
  grammar: false,
  tabIndent: true,
  doubleTabMs: 400,
  templateShortcuts: true,
  cleanPaste: true,
  nairaFormat: false,
  wordCount: true,
  checkAttachment: true,
  checkEmptyBody: true,
  checkPlaceholders: true,
  checkGreeting: true,
  checkExternal: true,
  externalThreshold: 5,
}

const clamp = (value: unknown, low: number, high: number, fallback: number) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(high, Math.max(low, Math.round(number))) : fallback
}

/** Whatever was stored, read back as a complete set: a missing or malformed key takes its default. */
export function writingSettingsFrom(raw: unknown): WritingSettings {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof WritingSettings) =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : (WRITING_DEFAULTS[key] as boolean)
  return {
    autoCapitalize: flag('autoCapitalize'),
    capitalizeI: flag('capitalizeI'),
    spellcheck: flag('spellcheck'),
    spellLanguage: stored.spellLanguage === 'en-US' ? 'en-US' : 'en-GB',
    ignoreCapitals: flag('ignoreCapitals'),
    ignoreWithNumbers: flag('ignoreWithNumbers'),
    repeatedWords: flag('repeatedWords'),
    autocorrect: flag('autocorrect'),
    personalWords: Array.isArray(stored.personalWords)
      ? [...new Set(stored.personalWords.filter((word): word is string => typeof word === 'string' && word.trim().length > 0).map(word => word.trim()))].slice(0, 5000)
      : [],
    grammar: flag('grammar'),
    tabIndent: flag('tabIndent'),
    doubleTabMs: clamp(stored.doubleTabMs, 200, 1000, WRITING_DEFAULTS.doubleTabMs),
    templateShortcuts: flag('templateShortcuts'),
    cleanPaste: flag('cleanPaste'),
    nairaFormat: flag('nairaFormat'),
    wordCount: flag('wordCount'),
    checkAttachment: flag('checkAttachment'),
    checkEmptyBody: flag('checkEmptyBody'),
    checkPlaceholders: flag('checkPlaceholders'),
    checkGreeting: flag('checkGreeting'),
    checkExternal: flag('checkExternal'),
    externalThreshold: clamp(stored.externalThreshold, 1, 100, WRITING_DEFAULTS.externalThreshold),
  }
}
