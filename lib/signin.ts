import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { BRAND } from '@/lib/brand'
import { renderActionEmail, withRequestText, type RequestNotice } from '@/lib/emails'
import { sendMail, type SendResult } from '@/lib/mail-provider'
import { recordSentMeta, setChallengeCode } from '@/lib/mailbox'
import { publicOrigin } from '@/lib/public-url'
import { hashEmailCode, newEmailCode } from '@/lib/two-factor'
import { describeRequest, visitorContext } from '@/lib/client-context'
import { NATIVE_CLIENT, nativeClient } from '@/lib/turnstile'
import type { RequesterContext, RequestPurpose } from '@/lib/vela'

export function requestContext(req: Request) {
  const { ip, userAgent, country, region, city, timezone } = visitorContext(req)
  return { ip, userAgent, country, region, city, timezone, client: nativeClient(req) ? NATIVE_CLIENT : null }
}

export const DEVICE_COOKIE = 'mail_device'
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/
const DEVICE_COOKIE_MAX_AGE = 2 * 365 * 24 * 60 * 60

const deviceCookie = (req: Request): string | null => {
  const entry = (req.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${DEVICE_COOKIE}=`))
  const value = entry?.slice(DEVICE_COOKIE.length + 1) ?? ''
  return DEVICE_ID.test(value) ? value : null
}

export function requesterDevice(req: Request): string | null {
  const installId = req.headers.get('x-mail-install-id')?.trim() ?? ''
  if (DEVICE_ID.test(installId)) return `app:${installId}`
  const cookie = deviceCookie(req)
  return cookie ? `web:${cookie}` : null
}

export function requesterContext(req: Request, account?: string | null): RequesterContext {
  const { ip, userAgent } = visitorContext(req)
  return { ip, device: requesterDevice(req), account: account?.trim().toLowerCase() || null, user_agent: userAgent?.slice(0, 512) ?? null }
}

export const sendContext = (req: Request, purpose: RequestPurpose, account?: string | null) => ({ purpose, ...requesterContext(req, account) })

export function withDeviceCookie<T extends NextResponse>(req: Request, response: T): T {
  if (deviceCookie(req) || req.headers.get('x-mail-install-id')) return response
  response.cookies.set({
    name: DEVICE_COOKIE,
    value: randomBytes(18).toString('base64url'),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE,
  })
  return response
}

const WASNT_YOU = 'Someone may have your password. Reset it with Forgot password on the sign-in page, or ask your mailbox admin to lock the account:'

export function requestNotice(req: Request, options: { wasntYou?: string; link?: boolean } = {}): RequestNotice {
  return {
    details: describeRequest(visitorContext(req), { native: nativeClient(req), deviceHeader: req.headers.get('x-mail-device') }),
    wasntYou: options.wasntYou ?? WASNT_YOU,
    ...(options.link === false ? {} : { helpUrl: `${publicOrigin(req)}/mail` }),
  }
}

type SignInBody = { body: Record<string, unknown> | null; refused: NextResponse | null }

// A cross-site form can post text/plain with no preflight, and these routes hand a session to
// whoever's credentials arrive, so without this a page signs its visitor into its own account.
export async function signInBody(req: Request): Promise<SignInBody> {
  const site = req.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return { body: null, refused: NextResponse.json({ ok: false, error: 'Cross-site request refused.' }, { status: 403 }) }
  }
  const text = await req.text().catch(() => '')
  if (!text) return { body: null, refused: null }
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
    return { body: null, refused: NextResponse.json({ ok: false, error: 'Send the request as JSON.' }, { status: 415 }) }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return { body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null, refused: null }
  } catch {
    return { body: null, refused: null }
  }
}

/** Sends a fresh six-digit code for a challenge; the code itself is never stored. */
export async function sendEmailCode(req: Request, challengeId: string, to: string, purpose: 'signin' | 'enroll', account: string): Promise<SendResult> {
  const code = newEmailCode()
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
  const from = (process.env.MAIL_FROM ?? BRAND.supportEmail).replace(/^.*<|>$/g, '').trim()
  const doing = purpose === 'signin' ? 'finish signing in to' : 'turn on email codes for'
  const request = requestNotice(req)
  const sent = await sendMail({
    from,
    fromName: `${BRAND.name} Mail`,
    to: [to],
    subject: `${spaced} is your ${BRAND.name} Mail code`,
    text: withRequestText(`Your code to ${doing} ${BRAND.name} Mail is ${spaced}.\n\nIt expires in 10 minutes. If you did not ask for it, someone has your password — change it.`, request),
    html: renderActionEmail({
      eyebrow: `${BRAND.name} · Mail`,
      code: spaced,
      recipient: to,
      reason: purpose === 'signin' ? 'because two-step sign-in by email is on for your account' : 'because email codes were requested for your account',
      title: spaced,
      body: `Enter this code to ${doing} ${BRAND.name} Mail. ${BRAND.name} will never ask for it by phone, chat or email.`,
      actionLabel: `Open ${BRAND.name} Mail`,
      actionUrl: `${publicOrigin(req)}/mail`,
      expiry: 'The code expires in 10 minutes and works once.',
      footer: 'Did not ask for this? Someone has your password. Sign in and change it.',
      request,
    }),
    // A code in the archive would outlive its purpose in a place other people can read.
    skipArchive: true,
    context: sendContext(req, purpose === 'signin' ? 'login_code' : 'verification', account),
  })
  if (sent.throttled) return sent
  await setChallengeCode(challengeId, hashEmailCode(challengeId, code))
  if (sent.id) await recordSentMeta(sent.id, null, true).catch(() => {})
  return sent
}
