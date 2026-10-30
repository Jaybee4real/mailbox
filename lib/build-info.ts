export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? ''
export const BUILD_SHA = (process.env.NEXT_PUBLIC_BUILD_SHA ?? '').slice(0, 7)
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME ?? ''

export const BUILD_LABEL = [APP_VERSION && `v${APP_VERSION}`, BUILD_SHA].filter(Boolean).join(' · ') || 'dev'

export function builtAt(locale?: string): string {
  const time = Date.parse(BUILD_TIME)
  return Number.isFinite(time) ? new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown'
}
