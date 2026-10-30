export function velaApiBase(): string {
  const origin = (process.env.VELA_API_URL ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '')
  if (!origin) throw new Error('VELA_API_URL is not set; the Vela key is never sent to a default host')
  return `${origin}/api/v1`
}

export const velaApiKey = (): string | null => process.env.VELA_API_KEY?.trim() || null

export function velaConfigProblem(): string | null {
  if (!(process.env.VELA_API_URL ?? '').trim()) return 'VELA_API_URL is not configured'
  return velaApiKey() ? null : 'VELA_API_KEY is not configured'
}
