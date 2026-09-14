export type ThemeBase = 'dark' | 'dim' | 'light'

export const ACCENT_RAMP: Record<ThemeBase, Record<string, number>> = {
  dark: { 100: 92, 200: 84, 300: 73, 400: 62, 500: 52, 600: 44, 700: 37, 800: 25, 900: 16 },
  dim: { 100: 90, 200: 82, 300: 71, 400: 60, 500: 51, 600: 43, 700: 36, 800: 27, 900: 20 },
  light: { 100: 34, 200: 40, 300: 46, 400: 46, 500: 46, 600: 55, 700: 70, 800: 93, 900: 96 },
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const clean = hex.replace('#', '')
  const full = clean.length === 3 ? clean.split('').map(char => char + char).join('') : clean
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  const red = parseInt(full.slice(0, 2), 16) / 255
  const green = parseInt(full.slice(2, 4), 16) / 255
  const blue = parseInt(full.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: lightness * 100 }
  const delta = max - min
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue: number
  if (max === red) hue = ((green - blue) / delta) % 6
  else if (max === green) hue = (blue - red) / delta + 2
  else hue = (red - green) / delta + 4
  return { h: (hue * 60 + 360) % 360, s: saturation * 100, l: lightness * 100 }
}

export function accentRampCss(hex: string, base: ThemeBase = 'light'): string {
  const hsl = hexToHsl(hex)
  if (!hsl) return ''
  const saturation = Math.max(28, Math.min(92, hsl.s))
  return Object.entries(ACCENT_RAMP[base])
    .map(([stop, lightness]) => `--nc-violet-${stop}:hsl(${hsl.h.toFixed(0)} ${saturation.toFixed(0)}% ${lightness}%)`)
    .join(';')
}
