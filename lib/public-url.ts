/**
 * The Host header is caller-controlled, so deriving a link from req.url lets an attacker
 * point a password-reset email at their own domain. Anything that ends up in an email
 * must use the configured origin; req.url is only a local-development fallback.
 */
export function publicOrigin(req: Request): string {
  const configured = process.env.MAIL_PUBLIC_URL?.trim().replace(/\/$/, '')
  if (configured) return configured

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '').replace(/\/$/, '')}`

  return new URL(req.url).origin
}
