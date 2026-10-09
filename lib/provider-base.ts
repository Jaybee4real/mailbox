export function providerBase(): string {
  const base = (process.env.RESEND_BASE_URL ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('RESEND_BASE_URL is not set; the provider key is never sent to a default host')
  return base
}
