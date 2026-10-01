import { BRAND } from '../brand.ts'
import { hexToHsl } from '../accent-ramp.ts'
import {
  bulletList, calloutPanel, codePanel, detailsPanel, emailLayout, emailText, escapeHtml,
  type EmailBrand,
} from './layout.ts'

export { escapeHtml }
export type EmailMode = 'project' | 'academy'
export type EmailField = { label: string; value: string }

const toHex = (color: string): string => {
  if (color.startsWith('#')) return color
  const channels = color.match(/\d+/g)?.slice(0, 3).map(Number) ?? []
  return channels.length === 3 ? `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}` : '#6d28d9'
}

const accentOnDark = (color: string): string => {
  const hsl = hexToHsl(toHex(color))
  return hsl ? `hsl(${hsl.h.toFixed(0)} ${Math.min(88, hsl.s).toFixed(0)}% 74%)` : '#c4b5fd'
}

export const MAIL_BRAND: EmailBrand = {
  name: `${BRAND.name} Mail`,
  accent: toHex(BRAND.colors.accent),
  accentOnDark: accentOnDark(BRAND.colors.accent),
  markUrl: BRAND.logoUrl,
  tagline: 'Team mail',
  site: BRAND.publicUrl.replace(/^https?:\/\//, ''),
  siteUrl: BRAND.publicUrl,
}

const COMPANY_BRAND: EmailBrand = {
  ...MAIL_BRAND,
  name: BRAND.name,
  tagline: BRAND.legalName,
  site: BRAND.website,
  siteUrl: BRAND.websiteUrl,
}

const fieldRows = (fields: EmailField[]): Array<[string, string]> =>
  fields.map(field => [field.label || 'Field', escapeHtml(field.value || '—').replace(/\n/g, '<br>')])

const fieldText = (fields: EmailField[]): Array<[string, string]> =>
  fields.map(field => [field.label || 'Field', field.value || '—'])

export function renderNotificationEmail(mode: EmailMode, fields: EmailField[]): string {
  const title = mode === 'academy' ? 'New Academy registration' : 'New project inquiry'
  return emailLayout({
    brand: COMPANY_BRAND,
    preview: `${title} from the website`,
    eyebrow: 'Inbox',
    heading: title,
    bodyHtml: `<p style="margin:0;">Someone filled in the ${mode === 'academy' ? 'Academy registration' : 'project inquiry'} form on ${escapeHtml(COMPANY_BRAND.site)}. Reply to this email to answer them directly.</p>`,
    moduleHtml: detailsPanel(fieldRows(fields), 'What they sent'),
    noteHtml: `<p style="margin:0;">Sent from ${escapeHtml(COMPANY_BRAND.site)} · ${escapeHtml(new Date().toUTCString())}</p>`,
  })
}

export function renderNotificationText(mode: EmailMode, fields: EmailField[]): string {
  const title = mode === 'academy' ? 'New Academy registration' : 'New project inquiry'
  return emailText({
    brand: COMPANY_BRAND,
    heading: title,
    paragraphs: [`Someone filled in the form on ${COMPANY_BRAND.site}. Reply to this email to answer them directly.`],
    details: fieldText(fields),
    note: [`Sent ${new Date().toUTCString()}`],
  })
}

export function notificationSubject(mode: EmailMode, email: string): string {
  return mode === 'academy'
    ? `Academy registration — ${email}`
    : `Project inquiry — ${email}`
}

const autoReplyCopy = (mode: EmailMode) =>
  mode === 'academy'
    ? {
        eyebrow: 'Academy',
        heading: 'Your spot is reserved',
        lead: `Thanks for registering for ${BRAND.name} Academy. A human on our team will reach out within 24 hours with cohort details and payment info.`,
        reason: `because you registered for ${BRAND.name} Academy`,
      }
    : {
        eyebrow: 'Studio',
        heading: 'We got your brief',
        lead: "Thanks for reaching out. A human on our team will read this and reply within 8 business hours (Monday to Friday). The average response time is 1 hour. If we need anything else to scope your project, we'll ask.",
        reason: `because you sent a project inquiry on ${BRAND.website}`,
      }

export function renderAutoReplyEmail(mode: EmailMode, fields: EmailField[], recipient = ''): string {
  const copy = autoReplyCopy(mode)
  return emailLayout({
    brand: COMPANY_BRAND,
    preview: copy.lead,
    eyebrow: copy.eyebrow,
    heading: copy.heading,
    bodyHtml: `<p style="margin:0;">${escapeHtml(copy.lead)}</p>`,
    moduleHtml: detailsPanel(fieldRows(fields), 'Your submission'),
    noteHtml: `<p style="margin:0;">Need to update something? Reply to this email and we'll see it.</p>`,
    recipient,
    reason: copy.reason,
  })
}

export function renderAutoReplyText(mode: EmailMode, fields: EmailField[]): string {
  const copy = autoReplyCopy(mode)
  return emailText({
    brand: COMPANY_BRAND,
    heading: copy.heading,
    paragraphs: [copy.lead, 'Your submission:'],
    details: fieldText(fields),
    note: ["Need to update something? Reply to this email and we'll see it.", `The ${BRAND.name} team`],
  })
}

export function autoReplySubject(mode: EmailMode): string {
  return mode === 'academy'
    ? `Your ${BRAND.name} Academy registration — we've got it`
    : `We got your project brief — ${BRAND.name}`
}

/** The follow-up templates are written for one business, so a deployment offers only those it lists. */
export function templateEnabled(name: string | undefined, setting = process.env.MAIL_TEMPLATES ?? ''): boolean {
  const offered = setting.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
  return Boolean(name) && offered.includes(String(name).toLowerCase())
}

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

function academyCopy(vars: AcademyFollowupVars) {
  return {
    headline: vars.headline ?? 'Your cohort details are here.',
    intro: vars.introText ?? `Thanks again for registering for ${BRAND.name} Academy. You're confirmed for ${vars.courses}.`,
    boxTitle: vars.cohortBoxTitle ?? 'Next Cohort',
    dateQuestion: vars.cohortDateQuestion ?? 'Does this date work for you, or would you prefer a later cohort? Just reply and let us know.',
    connectLead: vars.connectLead ?? "If you can send your phone number also via email, we'd love to connect on WhatsApp or a quick call so we can:",
    connect: [
      vars.connectBullet1 ?? 'Walk you through the curriculum',
      vars.connectBullet2 ?? 'Confirm payment details',
      vars.connectBullet3 ?? "Make sure we're both on the same page before day one",
    ],
    quickStartTitle: vars.quickStartTitle ?? 'Quick Start (Email Only)',
    quickStartText: vars.quickStartText ?? 'If you already know you want in and would rather handle everything over email, just reply here with:',
    quickStart: [
      vars.quickStartBullet1 ?? `Confirmation that you're good for ${vars.cohortDate}, or reply with your preferred month and we will send you payment details to get started.`,
      vars.quickStartBullet2 ?? '',
    ],
    closing: vars.closingText ?? "We'd love to hear from you.",
    signatureName: vars.signatureName ?? 'Joseph',
    signatureRole: vars.signatureRole ?? `${BRAND.name} Academy`,
  }
}

export function renderAcademyFollowupEmail(vars: AcademyFollowupVars): string {
  const copy = academyCopy(vars)
  return emailLayout({
    brand: { ...COMPANY_BRAND, markUrl: vars.logoUrl ?? COMPANY_BRAND.markUrl },
    preview: copy.intro,
    eyebrow: 'Academy',
    heading: copy.headline,
    bodyHtml: `<p style="margin:0 0 12px;">Hi ${escapeHtml(vars.firstName)},</p><p style="margin:0;">${escapeHtml(copy.intro)}</p>`,
    moduleHtml: [
      calloutPanel(COMPANY_BRAND, copy.boxTitle, escapeHtml(vars.cohortDate), escapeHtml(copy.dateQuestion)),
      `<p class="em-dim" style="margin:24px 0 0;">${escapeHtml(copy.connectLead)}</p>`,
      bulletList(copy.connect.map(escapeHtml)),
      calloutPanel(COMPANY_BRAND, copy.quickStartTitle, escapeHtml(copy.quickStartText), bulletList(copy.quickStart.map(escapeHtml))),
      `<p class="em-dim" style="margin:24px 0 0;">${escapeHtml(copy.closing)}</p>`,
      `<p class="em-ink" style="margin:16px 0 0;font-weight:600;">${escapeHtml(copy.signatureName)}<br><span class="em-dim" style="font-weight:400;">${escapeHtml(copy.signatureRole)}</span></p>`,
    ].join(''),
    reason: `because you registered for ${BRAND.name} Academy`,
  })
}

export function renderAcademyFollowupText(vars: AcademyFollowupVars): string {
  const copy = academyCopy(vars)
  return emailText({
    brand: COMPANY_BRAND,
    heading: copy.headline,
    paragraphs: [
      `Hi ${vars.firstName},`,
      copy.intro,
      `${copy.boxTitle}: ${vars.cohortDate}\n${copy.dateQuestion}`,
      `${copy.connectLead}\n${copy.connect.map(item => `- ${item}`).join('\n')}`,
      `${copy.quickStartTitle}\n${copy.quickStartText}\n${copy.quickStart.filter(Boolean).map(item => `- ${item}`).join('\n')}`,
      copy.closing,
      `${copy.signatureName}\n${copy.signatureRole}`,
    ],
  })
}

export function academyFollowupSubject(courses: string): string {
  return `${BRAND.name} Academy — your cohort details · ${courses}`
}

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

function contactCopy(vars: ContactFollowupVars) {
  return {
    headline: vars.headline ?? 'A few quick questions about your project.',
    intro: vars.introText ?? "Thanks for reaching out. We're excited about what you're building and want to make sure we scope this properly from day one. To move fast, could you clarify a few things?",
    scopeLead: vars.scopeLead ?? 'We want to understand your product, your users, and your timeline so we can propose the right team and approach.',
    detailsLead: vars.detailsLead ?? 'Here is what would help us most right now:',
    details: [
      vars.detailBullet1 ?? 'What problem are you solving, and who is the primary user?',
      vars.detailBullet2 ?? 'Do you have existing designs, wireframes, or a product brief we can review?',
      vars.detailBullet3 ?? 'What does success look like in 90 days? Launch, revenue, user count?',
    ],
    academy: vars.includeAcademy === 'true'
      ? {
          headline: vars.academyHeadline ?? `${BRAND.name} Academy`,
          text: vars.academyText ?? 'Interested in levelling up your skills while we scope your project? You can register for an upcoming cohort.',
          bullets: [
            vars.academyBullet1 ?? 'Graphic Design: UI/UX, brand systems, motion',
            vars.academyBullet2 ?? 'Programming: full-stack web & mobile development',
          ],
          cta: vars.academyCta ?? 'Just reply to this email with the course you want and we will send you the next cohort dates and payment details.',
        }
      : null,
    closing: vars.closingText ?? 'Reply here with as much or as little as you have. We will take it from there.',
    signatureName: vars.signatureName ?? `The ${BRAND.name} team`,
    signatureRole: vars.signatureRole ?? 'Engineering Studio',
  }
}

export function renderContactFollowupEmail(vars: ContactFollowupVars): string {
  const copy = contactCopy(vars)
  return emailLayout({
    brand: { ...COMPANY_BRAND, markUrl: vars.logoUrl ?? COMPANY_BRAND.markUrl },
    preview: copy.intro,
    eyebrow: 'Studio',
    heading: copy.headline,
    bodyHtml: `<p style="margin:0 0 12px;">Hi ${escapeHtml(vars.firstName)},</p><p style="margin:0;">${escapeHtml(copy.intro)}</p>`,
    moduleHtml: [
      calloutPanel(COMPANY_BRAND, "What we're thinking", escapeHtml(vars.projectType), escapeHtml(copy.scopeLead)),
      `<p class="em-dim" style="margin:24px 0 0;">${escapeHtml(copy.detailsLead)}</p>`,
      bulletList(copy.details.map(escapeHtml)),
      copy.academy
        ? calloutPanel(
            COMPANY_BRAND,
            copy.academy.headline,
            escapeHtml(copy.academy.text),
            bulletList(copy.academy.bullets.map(escapeHtml)) + `<p style="margin:12px 0 0;">${escapeHtml(copy.academy.cta)}</p>`,
          )
        : '',
      `<p class="em-dim" style="margin:24px 0 0;">${escapeHtml(copy.closing)}</p>`,
      `<p class="em-ink" style="margin:16px 0 0;font-weight:600;">${escapeHtml(copy.signatureName)}<br><span class="em-dim" style="font-weight:400;">${escapeHtml(copy.signatureRole)}</span></p>`,
    ].join(''),
    reason: `because you sent a project inquiry on ${BRAND.website}`,
  })
}

export function renderContactFollowupText(vars: ContactFollowupVars): string {
  const copy = contactCopy(vars)
  return emailText({
    brand: COMPANY_BRAND,
    heading: copy.headline,
    paragraphs: [
      `Hi ${vars.firstName},`,
      copy.intro,
      `What we're thinking: ${vars.projectType}\n${copy.scopeLead}`,
      `${copy.detailsLead}\n${copy.details.map(item => `- ${item}`).join('\n')}`,
      ...(copy.academy ? [`${copy.academy.headline}\n${copy.academy.text}\n${copy.academy.bullets.map(item => `- ${item}`).join('\n')}\n${copy.academy.cta}`] : []),
      copy.closing,
      `${copy.signatureName}\n${copy.signatureRole}`,
    ],
  })
}

export function contactFollowupSubject(projectType: string): string {
  return `Re: your project — ${projectType} · ${BRAND.name}`
}

export type AccessEmailInput = {
  brand: EmailBrand
  kind: 'reset' | 'invite'
  product: string
  recipient: string
  link: string
  expiry: string
  invitedBy?: string
}

export function renderAccessEmail(input: AccessEmailInput): { subject: string; html: string; text: string } {
  const invite = input.kind === 'invite'
  const heading = invite ? `You have access to ${input.product}` : 'Reset your password'
  const lead = invite
    ? `${input.invitedBy ?? 'An administrator'} gave you access to ${input.product}. Set a password to sign in.`
    : `Someone asked to reset the password for this ${input.product} account. Choose a new one below.`
  const cta = { label: invite ? 'Set your password' : 'Set a new password', url: input.link }
  const ignore = invite
    ? "Weren't expecting this? You can ignore this email. Nothing happens until a password is set."
    : "Didn't ask for this? Ignore this email and your password will not change."
  return {
    subject: invite ? `You have been given access to ${input.product}` : `Reset your ${input.product} password`,
    html: emailLayout({
      brand: input.brand,
      preview: lead,
      eyebrow: invite ? 'Invitation' : 'Password reset',
      heading,
      bodyHtml: `<p style="margin:0;">${escapeHtml(lead)}</p>`,
      moduleHtml: detailsPanel([
        ['Account', `<span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;">${escapeHtml(input.recipient)}</span>`],
        ...(invite && input.invitedBy ? [['Invited by', escapeHtml(input.invitedBy)] as [string, string]] : []),
        ['Link expires', escapeHtml(input.expiry)],
      ]),
      cta,
      noteHtml: `<p style="margin:0 0 8px;">The link works once. ${escapeHtml(input.product)} will never ask for your password by email or phone.</p><p style="margin:0;">${escapeHtml(ignore)}</p>`,
      recipient: input.recipient,
      reason: invite ? `because ${input.invitedBy ?? 'an administrator'} invited this address` : 'because a password reset was requested for this account',
    }),
    text: emailText({
      brand: input.brand,
      heading,
      paragraphs: [lead],
      details: [['Account', input.recipient], ['Link expires', input.expiry]],
      cta,
      note: [`The link works once. ${ignore}`],
    }),
  }
}

export type ActionEmailVars = {
  eyebrow: string
  accent?: string
  title: string
  body: string
  actionLabel: string
  actionUrl: string
  expiry: string
  footer: string
  code?: string
  recipient?: string
  reason?: string
}

export function renderActionEmail(vars: ActionEmailVars): string {
  const brand = vars.accent ? { ...MAIL_BRAND, accent: toHex(vars.accent), accentOnDark: accentOnDark(vars.accent) } : MAIL_BRAND
  const eyebrow = vars.eyebrow.split('·').pop()?.trim() || 'Account'
  return emailLayout({
    brand,
    preview: vars.body,
    eyebrow: vars.code ? 'Sign-in code' : eyebrow === 'Mail' ? 'Account' : eyebrow,
    heading: vars.code ? 'Your sign-in code' : vars.title,
    bodyHtml: `<p style="margin:0;">${escapeHtml(vars.body)}</p>`,
    moduleHtml: vars.code ? codePanel(brand, vars.code, 'Expires in 10 min') : '',
    cta: vars.code ? undefined : { label: vars.actionLabel, url: vars.actionUrl },
    noteHtml: `<p style="margin:0 0 8px;">${escapeHtml(vars.expiry)}</p><p style="margin:0;">${escapeHtml(vars.footer)}</p>`,
    recipient: vars.recipient,
    reason: vars.reason,
  })
}
