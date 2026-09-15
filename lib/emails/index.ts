import { BRAND } from '../brand'
/**
 * Tiny email-template runtime.
 *
 * Each template lives as a real `.html` file under `./templates/` with
 * Mustache-style `{{placeholder}}` variables. Files are read once at module
 * load (server-only) and cached.
 *
 * Why this shape:
 *  - Designers / non-engineers can edit raw HTML without touching TS.
 *  - Inboxes only support inline CSS, so the templates keep their styles inline.
 *  - No mustache/handlebars dependency — just a `replaceAll` loop. If you
 *    ever outgrow it, drop in `mustache` or migrate to react-email.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

export type EmailMode = 'project' | 'academy'
export type EmailField = { label: string; value: string }

const BRAND_URL = BRAND.websiteUrl
const BRAND_HOST = BRAND.website

// ── Template loading ───────────────────────────────────────────────────────
const TEMPLATE_DIR = path.join(process.cwd(), 'lib/emails/templates')

function loadTemplate(name: string): string {
  return readFileSync(path.join(TEMPLATE_DIR, name), 'utf8')
}

// Read once at module init — cheap and avoids per-request disk hits.
const TPL_NOTIFICATION = loadTemplate('notification.html')
const TPL_AUTO_REPLY = loadTemplate('auto-reply.html')
const TPL_FIELD_ROW = loadTemplate('field-row.html')
const TPL_ACADEMY_FOLLOWUP = loadTemplate('academy-followup.html')
const TPL_CONTACT_FOLLOWUP = loadTemplate('contact-followup.html')
const TPL_ACTION = loadTemplate('action.html')

// ── Rendering primitives ───────────────────────────────────────────────────
/** Escape user-provided values before interpolating into HTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Replace every `{{key}}` in `tpl` with `vars[key]`.
 * Values are inserted as-is — callers must escape any user-provided strings.
 * (We intentionally don't auto-escape: row HTML is pre-rendered and needs to
 * pass through untouched.)
 */
function render(tpl: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, v),
    tpl,
  )
}

/** Render the field table by repeating the row template once per field. */
function renderRows(
  fields: EmailField[],
  variant: 'notification' | 'reply',
): string {
  const labelBg = variant === 'notification' ? '#110A1F' : '#0A0613'
  const valueBg = variant === 'notification' ? '#0A0613' : '#110A1F'
  const labelWidth = variant === 'notification' ? '160' : '140'

  return fields
    .map((f) =>
      render(TPL_FIELD_ROW, {
        labelBg,
        valueBg,
        labelWidth,
        label: escapeHtml(f.label || 'Field'),
        value: escapeHtml(f.value || '—'),
      }),
    )
    .join('')
}

// ── Public API ─────────────────────────────────────────────────────────────
export function renderNotificationEmail(
  mode: EmailMode,
  fields: EmailField[],
): string {
  return render(TPL_NOTIFICATION, {
    title:
      mode === 'academy' ? 'New Academy Registration' : 'New Project Inquiry',
    host: BRAND_HOST,
    date: new Date().toUTCString(),
    rows: renderRows(fields, 'notification'),
  })
}

export function notificationSubject(mode: EmailMode, email: string): string {
  return mode === 'academy'
    ? `Academy registration — ${email}`
    : `Project inquiry — ${email}`
}

export function renderAutoReplyEmail(
  mode: EmailMode,
  fields: EmailField[],
): string {
  const isAcademy = mode === 'academy'
  return render(TPL_AUTO_REPLY, {
    headline: isAcademy ? 'Your spot is reserved.' : 'We got your brief.',
    kicker: isAcademy ? 'Academy' : 'Studio',
    lead: isAcademy
      ? `Thanks for registering for ${BRAND.name} Academy. A human on our team will reach out within 24 hours with cohort details and payment info.`
      : "Thanks for reaching out. A human on our team will read this and reply within 8 business hours (Mon–Fri). The average response time is 1 hour. If we need anything else to scope your project, we'll ask.",
    rows: renderRows(fields, 'reply'),
    brandUrl: BRAND_URL,
    brandHost: BRAND_HOST,
  })
}

export function autoReplySubject(mode: EmailMode): string {
  return mode === 'academy'
    ? `Your ${BRAND.name} Academy registration — we've got it`
    : `We got your project brief — ${BRAND.name}`
}

// ── Academy follow-up (sent manually via dev backdoor) ──────────────────────
export type AcademyFollowupVars = {
  firstName: string
  courses: string
  cohortDate: string
  headline?: string
  introText?: string
  cohortBoxTitle?: string
  cohortDateQuestion?: string
  connectLead?: string
  connectBullet1?: string
  connectBullet2?: string
  connectBullet3?: string
  quickStartTitle?: string
  quickStartText?: string
  quickStartBullet1?: string
  quickStartBullet2?: string
  closingText?: string
  signatureName?: string
  signatureRole?: string
  logoUrl?: string
}

export function renderAcademyFollowupEmail(vars: AcademyFollowupVars): string {
  return render(TPL_ACADEMY_FOLLOWUP, {
    logoUrl: vars.logoUrl ?? BRAND.logoUrl,
    headline: escapeHtml(vars.headline ?? 'Your cohort details are here.'),
    firstName: escapeHtml(vars.firstName),
    introText: escapeHtml(
      vars.introText ??
        `Thanks again for registering for ${BRAND.name} Academy. You're confirmed for ${vars.courses}.`,
    ),
    courses: escapeHtml(vars.courses),
    cohortDate: escapeHtml(vars.cohortDate),
    cohortBoxTitle: escapeHtml(vars.cohortBoxTitle ?? 'Next Cohort'),
    cohortDateQuestion: escapeHtml(
      vars.cohortDateQuestion ??
        'Does this date work for you, or would you prefer a later cohort? Just reply and let us know.',
    ),
    connectLead: escapeHtml(
      vars.connectLead ??
        "If you can send your phone number also via email, we'd love to connect on WhatsApp or a quick call so we can:",
    ),
    connectBullet1: escapeHtml(vars.connectBullet1 ?? 'Walk you through the curriculum'),
    connectBullet2: escapeHtml(vars.connectBullet2 ?? 'Confirm payment details'),
    connectBullet3: escapeHtml(
      vars.connectBullet3 ?? "Make sure we're both on the same page before day one",
    ),
    quickStartTitle: escapeHtml(vars.quickStartTitle ?? 'Quick Start (Email Only)'),
    quickStartText: escapeHtml(
      vars.quickStartText ??
        'If you already know you want in and would rather handle everything over email, just reply here with:',
    ),
    quickStartBullet1: escapeHtml(
      vars.quickStartBullet1 ??
        `Confirmation that you're good for ${vars.cohortDate}, or reply with your preferred month and we will send you payment details to get started.`,
    ),
    closingText: escapeHtml(vars.closingText ?? "We'd love to hear from you."),
    signatureName: escapeHtml(vars.signatureName ?? 'Joseph'),
    signatureRole: escapeHtml(vars.signatureRole ?? `${BRAND.name} Academy`),
    brandUrl: BRAND_URL,
    brandHost: BRAND_HOST,
  })
}

export function academyFollowupSubject(courses: string): string {
  return `${BRAND.name} Academy — your cohort details · ${courses}`
}

// ── Contact follow-up (sent manually via dev backdoor) ─────────────────────
export type ContactFollowupVars = {
  firstName: string
  projectType: string
  headline?: string
  introText?: string
  scopeLead?: string
  detailsLead?: string
  detailBullet1?: string
  detailBullet2?: string
  detailBullet3?: string
  includeAcademy?: string
  academyHeadline?: string
  academyText?: string
  academyBullet1?: string
  academyBullet2?: string
  academyCta?: string
  closingText?: string
  signatureName?: string
  signatureRole?: string
  logoUrl?: string
}

function renderAcademySection(vars: ContactFollowupVars): string {
  if (vars.includeAcademy !== 'true') return ''
  return `
      <div style="background:#110A1F;border:1px solid #2C1F4A;border-radius:12px;padding:20px 24px;margin:0 0 24px">
        <div style="font:600 11px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#A578FF;letter-spacing:.18em;text-transform:uppercase;margin:0 0 10px">
          ${escapeHtml(vars.academyHeadline ?? `${BRAND.name} Academy`)}
        </div>
        <p style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#C8BFD9;margin:0 0 12px">
          ${escapeHtml(vars.academyText ?? 'Interested in levelling up your skills while we scope your project? You can register for an upcoming cohort.')}
        </p>
        <ul style="font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#C8BFD9;margin:0 0 12px;padding-left:20px">
          <li>${escapeHtml(vars.academyBullet1 ?? 'Graphic Design — UI/UX, brand systems, motion')}</li>
          <li>${escapeHtml(vars.academyBullet2 ?? 'Programming — full-stack web & mobile development')}</li>
        </ul>
        <p style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#C8BFD9;margin:0">
          ${escapeHtml(vars.academyCta ?? 'Just reply to this email with the course you want and we will send you the next cohort dates and payment details.')}
        </p>
      </div>`
}

export function renderContactFollowupEmail(vars: ContactFollowupVars): string {
  return render(TPL_CONTACT_FOLLOWUP, {
    logoUrl: vars.logoUrl ?? BRAND.logoUrl,
    headline: escapeHtml(vars.headline ?? 'A few quick questions about your project.'),
    firstName: escapeHtml(vars.firstName),
    introText: escapeHtml(
      vars.introText ??
        "Thanks for reaching out. We're excited about what you're building and want to make sure we scope this properly from day one. To move fast, could you clarify a few things?",
    ),
    projectType: escapeHtml(vars.projectType),
    scopeLead: escapeHtml(
      vars.scopeLead ??
        "We want to understand your product, your users, and your timeline so we can propose the right team and approach.",
    ),
    detailsLead: escapeHtml(
      vars.detailsLead ??
        "Here is what would help us most right now:",
    ),
    detailBullet1: escapeHtml(
      vars.detailBullet1 ?? 'What problem are you solving, and who is the primary user?',
    ),
    detailBullet2: escapeHtml(
      vars.detailBullet2 ?? 'Do you have existing designs, wireframes, or a product brief we can review?',
    ),
    detailBullet3: escapeHtml(
      vars.detailBullet3 ?? 'What does success look like in 90 days? Launch, revenue, user count?',
    ),
    academySection: renderAcademySection(vars),
    closingText: escapeHtml(
      vars.closingText ??
        "Reply here with as much or as little as you have — we will take it from there.",
    ),
    signatureName: escapeHtml(vars.signatureName ?? `The ${BRAND.name} team`),
    signatureRole: escapeHtml(vars.signatureRole ?? 'Engineering Studio'),
    brandUrl: BRAND_URL,
    brandHost: BRAND_HOST,
  })
}

export function contactFollowupSubject(projectType: string): string {
  return `Re: your project — ${projectType} · ${BRAND.name}`
}

export type ActionEmailVars = {
  eyebrow: string
  accent: string
  title: string
  body: string
  actionLabel: string
  actionUrl: string
  expiry: string
  footer: string
}

/** One-button transactional mail — resets, invites — in the tenant's own accent. */
export function renderActionEmail(vars: ActionEmailVars): string {
  return render(TPL_ACTION, {
    eyebrow: escapeHtml(vars.eyebrow),
    accent: escapeHtml(vars.accent),
    title: escapeHtml(vars.title),
    body: escapeHtml(vars.body),
    actionLabel: escapeHtml(vars.actionLabel),
    actionUrl: escapeHtml(vars.actionUrl),
    expiry: escapeHtml(vars.expiry),
    footer: escapeHtml(vars.footer),
  })
}
