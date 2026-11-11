import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DISPOSABLE_EMAIL_MESSAGE = "Please use a permanent email address. Disposable email addresses aren't accepted."

let disposableDomains: Set<string> | null = null

function loadDisposableDomains(): Set<string> {
  disposableDomains ??= new Set(
    readFileSync(join(process.cwd(), 'lib', 'disposable-email-domains.txt'), 'utf8')
      .split('\n')
      .map(line => line.trim().toLowerCase())
      .filter(line => line && !line.startsWith('#')),
  )
  return disposableDomains
}

export function isDisposableEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase()
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1)
  if (!normalized.includes('@') || !domain) return false
  const domains = loadDisposableDomains()
  const labels = domain.split('.')
  for (let start = 0; start < labels.length - 1; start += 1) {
    if (domains.has(labels.slice(start).join('.'))) return true
  }
  return false
}
