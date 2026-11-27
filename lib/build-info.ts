export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ''
export const BUILD_FULL_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? ''
export const BUILD_SHA = BUILD_FULL_SHA.slice(0, 7)
export const BUILD_NUMBER = process.env.NEXT_PUBLIC_BUILD_NUMBER ?? ''
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? ''

export function buildLabel(number: string, sha: string): string {
  return [number && `Build ${number}`, sha.slice(0, 7)].filter(Boolean).join(' · ') || 'dev'
}

export const BUILD_LABEL = buildLabel(BUILD_NUMBER, BUILD_SHA)

export function isNewerBuild(running: string, served: unknown): served is string {
  return Boolean(running) && typeof served === 'string' && served.length > 0 && served !== running
}

export function builtAt(locale?: string): string {
  const time = Date.parse(BUILD_TIME)
  return Number.isFinite(time) ? new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown'
}
