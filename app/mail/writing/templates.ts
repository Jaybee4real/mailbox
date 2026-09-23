export type MailTemplate = { id: string; name: string; shortcut: string; html: string }
export type TemplateContext = { firstName?: string; name?: string; email?: string; senderName?: string }

export const TEMPLATE_FIELD = /\{[A-Za-z][A-Za-z_ ]{0,29}\}/g

/** A shortcut as the sender types it: ";renewal". Letters, digits, dashes only. */
export const normaliseShortcut = (raw: string) => raw.trim().toLowerCase().replace(/^;+/, '').replace(/[^a-z0-9-]/g, '')

/** Fills the fields a template can know about; the rest stay as {field} for the sender to Tab through. */
export function fillTemplate(html: string, context: TemplateContext, today = new Date()): string {
  const known: Record<string, string | undefined> = {
    first_name: context.firstName,
    firstname: context.firstName,
    name: context.name ?? context.firstName,
    email: context.email,
    sender_name: context.senderName,
    my_name: context.senderName,
    date: today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    today: today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
  }
  return html.replace(TEMPLATE_FIELD, field => {
    const value = known[field.slice(1, -1).trim().toLowerCase().replace(/\s+/g, '_')]
    return value ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;') : field
  })
}

const SHARED_MAILBOXES = new Set([
  'info', 'admin', 'support', 'claims', 'accounts', 'account', 'underwriting', 'sales', 'hello', 'contact', 'enquiries',
  'enquiry', 'noreply', 'no-reply', 'mail', 'office', 'team', 'service', 'services', 'customerservice', 'customercare',
  'care', 'help', 'hr', 'finance', 'billing', 'operations', 'ops', 'reception', 'marketing', 'news', 'notifications',
])

/** A first name from an address like eric.samuel@…; nothing for a shared mailbox like info@. */
export function firstNameFromAddress(address: string | undefined): string | undefined {
  const local = (address ?? '').split('@')[0]?.toLowerCase() ?? ''
  if (!local || SHARED_MAILBOXES.has(local)) return undefined
  const first = local.split(/[._-]/)[0]
  if (!/^[a-z]{2,20}$/.test(first) || SHARED_MAILBOXES.has(first)) return undefined
  return first[0].toUpperCase() + first.slice(1)
}
