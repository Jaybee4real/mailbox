export const DEEP_LINK_PATHS = {
  signin: '/mail/signin',
  forgot: '/mail/forgot',
  security: '/mail/security',
} as const

export type DeepLinkTarget = keyof typeof DEEP_LINK_PATHS

export type DeepLink = { target: DeepLinkTarget; email: string | null; code: string | null }

const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}$/

export function cleanEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

export function cleanCode(value: unknown): string | null {
  const digits = typeof value === 'string' ? value.replace(/[\s-]/g, '') : ''
  return /^\d{6}$/.test(digits) ? digits : null
}

export const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`

export function deepLink(origin: string, target: DeepLinkTarget, params: { email?: string | null; code?: string | null } = {}): string {
  const url = new URL(DEEP_LINK_PATHS[target], origin)
  const email = cleanEmail(params.email)
  const code = cleanCode(params.code)
  if (email) url.searchParams.set('email', email)
  if (code) url.searchParams.set('code', code)
  return url.toString()
}

export function readDeepLink(pathname: string, search: string): DeepLink | null {
  const path = pathname.replace(/\/+$/, '')
  const target = (Object.keys(DEEP_LINK_PATHS) as DeepLinkTarget[]).find(key => DEEP_LINK_PATHS[key] === path)
  if (!target) return null
  const params = new URLSearchParams(search)
  return {
    target,
    email: target === 'security' ? null : cleanEmail(params.get('email')),
    code: target === 'forgot' ? null : cleanCode(params.get('code')),
  }
}
