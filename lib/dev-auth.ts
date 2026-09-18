import { BRAND } from './brand'
/**
 * Shared dev backdoor auth utilities.
 *
 * On localhost: everything is allowed (for local development).
 * On production: requires x-dev-email and x-dev-password headers
 * whose SHA-256 hashes match DEV_ADMIN_EMAIL_HASH / DEV_ADMIN_PASSWORD_HASH.
 */

import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getAccount, getAccountPasswordHash, setAccountPassword, MAIL_SEATS, type MailRole } from '@/lib/mailbox'
import { hashPassword, verifyPassword, isLegacyHash } from '@/lib/password'
import { passwordFingerprint, readSession } from '@/lib/session'

/**
 * The two original accounts. They may sign in with the email-derived default password
 * (local-part@your-domain). Everyone invited afterwards MUST set a password via their
 * invite link — no default-password fallback — so a pending invite can't be logged into.
 */
export const MAIL_ACCOUNTS = MAIL_SEATS.filter(seat => seat.role === 'admin').map(seat => seat.email)

/**
 * Where a copy of inbound mail is forwarded. Off unless MAIL_FORWARD_TO is set: forwarding
 * to an address this app itself receives would loop, and copying a client's mail into a
 * personal inbox is not a decision a deployment should make quietly.
 */
export const FORWARD_RECIPIENTS = (process.env.MAIL_FORWARD_TO ?? '')
  .split(',')
  .map(entry => entry.trim().toLowerCase())
  .filter(Boolean)

function isLegacyDefaultAccount(email: string): boolean {
  return MAIL_ACCOUNTS.includes(email.trim().toLowerCase())
}

/** An address is a valid accessor if it exists in mail_accounts. */
export async function isMailAccount(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return false
  if (isLegacyDefaultAccount(normalized)) return true
  return (await getAccount(normalized)) !== null
}

/** Domain every mailbox address lives on. */
export const MAIL_DOMAIN = (BRAND.domain).trim().toLowerCase()

export function defaultPasswordFor(email: string): string {
  const localPart = email.trim().toLowerCase().split('@')[0]
  return `${localPart}@${MAIL_DOMAIN}`
}

export function isLocalOrigin(req: Request): boolean {
  // origin/referer/host are client-supplied; only trust them off a deployed runtime.
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) return false
  const origin = req.headers.get('origin') ?? ''
  const referer = req.headers.get('referer') ?? ''
  const host = req.headers.get('host') ?? ''
  const localHosts = ['localhost', '127.0.0.1', '::1']
  const check = (s: string) =>
    localHosts.some((h) => s.startsWith(`http://${h}`) || s.startsWith(`https://${h}`))
  return check(origin) || check(referer) || localHosts.some((h) => host.startsWith(h))
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function verifyDevAuth(req: Request): { ok: boolean; error?: string } {
  // Localhost is always allowed
  if (isLocalOrigin(req)) return { ok: true }

  const emailHashEnv = process.env.DEV_ADMIN_EMAIL_HASH ?? ''
  const passwordHashEnv = process.env.DEV_ADMIN_PASSWORD_HASH ?? ''

  // If hashes are not configured, backdoor is disabled on production
  if (!emailHashEnv || !passwordHashEnv) {
    return { ok: false, error: 'Backdoor disabled' }
  }

  const email = req.headers.get('x-dev-email') ?? ''
  const password = req.headers.get('x-dev-password') ?? ''

  if (!email || !password) {
    return { ok: false, error: 'Authentication required' }
  }

  const emailHash = sha256(email)
  const passwordHash = sha256(password)

  if (emailHash !== emailHashEnv || passwordHash !== passwordHashEnv) {
    return { ok: false, error: 'Invalid credentials' }
  }

  return { ok: true }
}

/** Handy wrapper for route handlers. */
export function devAuthGuard(req: Request): NextResponse | null {
  const result = verifyDevAuth(req)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 403 })
  }
  return null
}

/**
 * Auth for the mail client. Accepts, in order: localhost, the legacy single-admin
 * env hashes, and the two named mail accounts (custom password from Blob, else the
 * email-derived default). Async because custom passwords live in the Blob store.
 */
export async function verifyMailAuth(
  email: string,
  password: string,
): Promise<{ ok: boolean; email?: string; error?: string }> {
  const normalized = email.trim().toLowerCase()

  const emailHashEnv = process.env.DEV_ADMIN_EMAIL_HASH ?? ''
  const passwordHashEnv = process.env.DEV_ADMIN_PASSWORD_HASH ?? ''
  if (emailHashEnv && passwordHashEnv) {
    if (sha256(email) === emailHashEnv && sha256(password) === passwordHashEnv) {
      // The env pair is a password, not an identity: it opens an address this deployment
      // actually hosts, never an arbitrary one. The same pair installed on two tenants
      // would otherwise be one key to both mailboxes.
      if (await isMailAccount(normalized)) return { ok: true, email: normalized }
      return { ok: false, error: 'Invalid credentials' }
    }
  }

  const account = await getAccount(normalized)
  const legacy = isLegacyDefaultAccount(normalized)
  if (!account && !legacy) {
    return { ok: false, error: 'Invalid credentials' }
  }

  const custom = account?.hasPassword ? await getAccountPasswordHash(normalized) : undefined

  if (custom) {
    if (await verifyPassword(password, custom)) {
      // Anyone still on an unsalted digest is upgraded the moment they sign in,
      // so the weak hashes drain out of the table without a migration.
      if (isLegacyHash(custom)) {
        await setAccountPassword(normalized, await hashPassword(password)).catch(() => {})
      }
      return { ok: true, email: normalized }
    }
    return { ok: false, error: 'Invalid credentials' }
  }

  // No stored password: only the bootstrap admin gets the address-derived default.
  // Invited people must set their own via the link they were sent.
  if (legacy && password === defaultPasswordFor(normalized)) {
    return { ok: true, email: normalized }
  }
  return { ok: false, error: 'Invalid credentials' }
}

/** The session tag for an address as it stands right now, for minting a fresh cookie. */
export async function currentFingerprint(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const account = await getAccount(normalized)
  const stored = account?.hasPassword ? await getAccountPasswordHash(normalized) : undefined
  return passwordFingerprint(stored)
}

/**
 * A session cookie only counts while it still matches the account's current password hash,
 * so changing or resetting a password signs out every device that was already signed in.
 */
async function sessionIdentity(req: Request): Promise<string | null> {
  const session = readSession(req)
  if (!session) return null

  const account = await getAccount(session.email)
  if (!account && !isLegacyDefaultAccount(session.email)) return null
  if (account && account.status !== 'active') return null

  const stored = account?.hasPassword ? await getAccountPasswordHash(session.email) : undefined
  if (session.fingerprint !== passwordFingerprint(stored)) return null

  return session.email
}

/**
 * The authenticated address for a request: the session cookie first, then the credential
 * headers. The header path is kept so an already-open tab keeps working across the deploy
 * that introduced sessions, and for the localhost dev bypass.
 */
export async function authenticate(req: Request): Promise<string | null> {
  const fromSession = await sessionIdentity(req)
  if (fromSession) return fromSession

  const email = req.headers.get('x-dev-email') ?? ''
  const password = req.headers.get('x-dev-password') ?? ''
  if (!email || !password) return null

  const result = await verifyMailAuth(email, password)
  return result.ok ? (result.email ?? null) : null
}

/**
 * Resolve the acting account for owner-scoping. Never falls back to the admin owner on a
 * deployed runtime: a route that reaches here unauthenticated gets no mailbox rather than
 * everybody's, so forgetting the guard cannot hand out the shared inbox.
 */
export async function resolveAccount(
  req: Request,
): Promise<{ email: string; address: string | null; name: string | null; role: MailRole }> {
  const identity = (await authenticate(req)) ?? ''
  if (identity) {
    const account = await getAccount(identity)
    if (account) return { email: account.email, address: account.address, name: account.name ?? null, role: account.role }
    return { email: identity, address: null, name: null, role: 'member' }
  }

  // No session means no identity, on localhost as anywhere else. Standing in for the
  // admin owner here meant that signing in as one person and losing the session for any
  // reason silently showed you the shared inbox instead of theirs.
  return { email: '', address: null, name: null, role: 'member' }
}

/** Guard for mail routes: a valid session or credential headers, localhost included. */
export async function mailAuthGuard(req: Request): Promise<NextResponse | null> {
  if (await authenticate(req)) return null
  return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 403 })
}
