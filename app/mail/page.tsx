'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { extractUrls, inspectUrl, type LinkVerdict } from '@/lib/link-safety'
import AttachmentLightbox, { attachmentKind, formatSize, type PreviewItem } from './AttachmentLightbox'
import AccessCheck from './AccessCheck'
import { parseQuery, matchesQuery } from './search'
import { useConfirm } from './ConfirmDialog'
import { subscribePush, unsubscribePush, useInstall, useNotifications } from './pwa'
import RichEditor from './RichEditor'
import { inlineEmailStyles, htmlToPlainText, dropUnreachableImages, outlookSafeImages } from '@/lib/email-html'
import { BUILTIN_FONTS, EMPTY_FONT, FONT_SIZES, fontFaceCss, fontStack, type BaseFont, type CustomFont } from '@/lib/fonts'
import MailSelect from './MailSelect'
import { applyThreadFlagDeltas, normalizeSubject } from '@/lib/threads'
import { defaultSignature, fillSignature } from '@/lib/default-signature'
import styles from './page.module.css'

// Files up to this size ride along as real email attachments; larger ones are
// linked as a download button in the body (email providers cap total size).
const ATTACH_LIMIT_BYTES = 20 * 1024 * 1024

// No bytes for this long means the connection has gone, however healthy the request looks.
const STALL_AFTER_MS = 45_000

import { CLIENT_BRAND, LS, clientSignatureMarkStyle } from '@/lib/brand.client'
import { accentScale, hexToHsl } from '@/lib/accent-ramp'

const LS_EMAIL_KEY = LS('email')
const LS_DOMAIN_KEY = LS('domain')
const LS_INBOX_CACHE_KEY = LS('inbox_cache')
const LS_PASSWORD_KEY = LS('password')
const LS_THEME_KEY = LS('theme')
const LS_RAIL_KEY = LS('rail_collapsed')
const LS_LIST_W_KEY = LS('list_width')
const LS_SCALE_KEY = LS('ui_scale')
const SCALE_MIN = 80
const SCALE_MAX = 140
const LIST_W_MIN = 280
const LIST_W_MAX = 720
const LIST_W_DEFAULT = 400
const LS_LAYOUT_KEY = LS('layout')
const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
]

type ThemeBase = 'light' | 'dim' | 'dark'
type ThemePref = 'system' | ThemeBase

const LS_ACCENT_KEY = LS('accent')
const LS_THEME_CUSTOM_KEY = LS('theme_custom')

const ACCENT_PRESETS: Array<{ key: string; label: string; hex: string }> = [
  { key: 'brand', label: 'Brand', hex: CLIENT_BRAND.accent },
  { key: 'indigo', label: 'Indigo', hex: '#4F5BD5' },
  { key: 'teal', label: 'Teal', hex: '#0E8F8F' },
  { key: 'emerald', label: 'Emerald', hex: '#12855B' },
  { key: 'amber', label: 'Amber', hex: '#B4700A' },
  { key: 'rose', label: 'Rose', hex: '#C22B58' },
]

// The individually themeable surfaces, in the order they appear in the editor. Each maps
// onto the token the whole UI already reads, so overriding one repaints every use of it.
const THEME_FIELDS: Array<{ key: string; label: string; vars: string[] }> = [
  { key: 'surface', label: 'Message area', vars: ['--nc-ink-0'] },
  { key: 'sidebar', label: 'Sidebar', vars: ['--nc-ink-1'] },
  { key: 'panel', label: 'Cards & panels', vars: ['--nc-ink-2'] },
  { key: 'raised', label: 'Hover / raised', vars: ['--nc-ink-3'] },
  { key: 'text', label: 'Primary text', vars: ['--nc-fg-1'] },
  { key: 'muted', label: 'Secondary text', vars: ['--nc-fg-2'] },
  { key: 'faint', label: 'Muted text', vars: ['--nc-fg-3'] },
  { key: 'border', label: 'Borders', vars: ['--nc-line-1', '--nc-line-2'] },
]

type ThemeCustom = Record<string, string>

// Full presets: a base for anything not overridden, an accent, and surface overrides.
const THEME_PRESETS: Array<{ key: string; label: string; base: ThemeBase; accent: string; vars: ThemeCustom }> = [
  { key: 'brand', label: CLIENT_BRAND.name, base: 'light', accent: CLIENT_BRAND.accent, vars: {} },
  { key: 'aubergine', label: 'Aubergine', base: 'dark', accent: '#8B5CF6', vars: { surface: '#1A1023', sidebar: '#3F0E40', panel: '#241430', raised: '#32203F', border: '#4A2A54', muted: '#D6C7E0' } },
  { key: 'slate', label: 'Slate', base: 'dim', accent: '#4F8CD5', vars: {} },
  { key: 'forest', label: 'Forest', base: 'dark', accent: '#2F9E68', vars: { surface: '#0C1512', sidebar: '#122019', panel: '#16281F', raised: '#1D3529', border: '#25412F' } },
  { key: 'ember', label: 'Ember', base: 'dark', accent: '#D2632A', vars: { surface: '#160F0B', sidebar: '#1F1611', panel: '#271B14', raised: '#33241A', border: '#3F2C20' } },
  { key: 'paper', label: 'Paper', base: 'light', accent: CLIENT_BRAND.accent, vars: {} },
  { key: 'sand', label: 'Sand', base: 'light', accent: '#A6600F', vars: { surface: '#FDFBF6', sidebar: '#F5EFE2', panel: '#FFFDF8', raised: '#EFE6D3', border: '#E2D6BE' } },
]

// Each base's actual token values, mirroring the CSS. Used for the preview swatches and
// so the surface pickers show the colour that is really in effect rather than black.
const BASE_TOKENS: Record<ThemeBase, ThemeCustom> = {
  light: { surface: '#ffffff', sidebar: '#f7f7fa', panel: '#ffffff', raised: '#f0f0f5', text: '#16121f', muted: '#45414f', faint: '#6e6a7c', border: '#e4e4ec' },
  dim: { surface: '#1b1f27', sidebar: '#222732', panel: '#2a303c', raised: '#333a48', text: '#eef1f6', muted: '#c3cad6', faint: '#97a0af', border: '#39414f' },
  dark: { surface: '#000000', sidebar: '#0a0a0a', panel: '#141414', raised: '#1f1f1f', text: '#f4f4f7', muted: '#c6c4d0', faint: '#928fa1', border: '#262626' },
}

const BASE_PREVIEW = BASE_TOKENS

/** Accent scale + any per-surface overrides, as inline custom properties. */
function themeVars(accent: string, base: ThemeBase, custom: ThemeCustom): React.CSSProperties {
  const vars: Record<string, string> = { ...accentScale(accent, base) }
  for (const field of THEME_FIELDS) {
    const value = custom[field.key]
    if (value && hexToHsl(value)) for (const cssVar of field.vars) vars[cssVar] = value
  }
  return vars as React.CSSProperties
}
type MailAccountInfo = { email: string; address: string | null; name?: string | null; role: 'admin' | 'member'; defaultPassword?: boolean }
type Accessor = {
  email: string
  name: string | null
  address: string | null
  role: 'admin' | 'member'
  status: string
  hasPassword: boolean
  invitedBy: string | null
}

type Folder = 'inbox' | 'starred' | 'snoozed' | 'sent' | 'scheduled' | 'drafts' | 'archived' | 'trash'

type SentEmail = {
  id: string
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  searchText?: string
  subject: string
  createdAt: string
  scheduledAt: string | null
  lastEvent: string
  starred: boolean
  archived: boolean
  trashed: boolean
  opened: boolean
  openCount: number
  openedAt: string | null
  owner?: string
  inReplyTo?: string | null
}

type DownloadAttachment = { filename: string; size: number; downloadUrl: string; shareId?: string; contentType?: string }

type SentDetail = SentEmail & {
  cc: string[]
  bcc: string[]
  replyTo: string | null
  html: string | null
  text: string | null
  attachments: DownloadAttachment[]
}

type ConversationRow = {
  threadId: string
  snoozedUntil?: string | null
  subject: string
  firstAt: string
  latestAt: string
  latestId: string | null
  count: number
  unreadCount: number
  starredCount: number
  inboxCount: number
  archivedCount: number
  trashedCount: number
  attachCount: number
  senders: string[]
  snippet: string
  labels: string[]
}

type InboundEmail = {
  id: string
  snoozedUntil?: string | null
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  html: string | null
  text: string | null
  headers: Record<string, unknown>
  receivedAt: string
  read: boolean
  attachments: Array<{ filename: string; contentType?: string; size?: number; shareId?: string; url?: string }>
  starred: boolean
  archived: boolean
  trashed: boolean
  labels: string[]
  owner?: string | null
  threadId?: string | null
}

type Attachment = {
  /** Identifies the entry across updates. Progress replaces the object, so the row
      cannot be found again by identity once the first byte has moved. */
  uid?: string
  filename: string
  url: string
  /** Bucket object key for a file that rides along on the email. */
  key?: string
  size: number
  uploading?: boolean
  /** Set when the file went to object storage instead of riding along on the email. */
  shareId?: string
  shareUrl?: string
  password?: string
  progress?: number
  error?: string
  /** Briefly true after the bytes land, so the chip can confirm rather than just stop moving. */
  uploaded?: boolean
  /** Kept so a failed upload can be retried without asking for the file again. */
  file?: File
  /** Object URL for an image, so the chip and the preview panel can show the real thing. */
  preview?: string
}

// A single message in a conversation — either an inbound email or one of our sent replies.
type ThreadItem =
  | { kind: 'inbound'; id: string; date: string; inbound: InboundEmail }
  | { kind: 'sent'; id: string; date: string; sent: SentEmail }

type MailEvent = {
  emailId: string
  type: string
  at: string
  meta?: Record<string, string>
}

type Campaign = {
  kind: '' | 'academy' | 'contact'
  firstName: string
  courses: string[]
  cohortDate: string
  projectType: string
  includeAcademy: boolean
}

type ComposeData = {
  fromName: string
  /** What the editor holds. `markdown` stays for drafts written before the editor. */
  bodyHtml: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string
  subject: string
  markdown: string
  htmlSource: string
  htmlDirty: boolean
  useSignature: boolean
  delayKey: string
  customDate: string
  campaign: Campaign
  quoteHtml?: string
  inReplyTo?: string
}

/** The inline quick-reply still has its own views; the composer is now one editor. */
type ReplyMode = 'write' | 'preview' | 'plain' | 'html' | 'raw'

type Draft = { id: string; savedAt: string; data: ComposeData }

const EMPTY_CAMPAIGN: Campaign = {
  kind: '',
  firstName: '',
  courses: [],
  cohortDate: 'June 1st',
  projectType: 'Web app',
  includeAcademy: false,
}

const EMPTY_COMPOSE: ComposeData = {
  // Filled in from the signed-in account when compose opens.
  fromName: '',
  bodyHtml: '',
  to: [],
  cc: [],
  bcc: [],
  replyTo: '',
  subject: '',
  markdown: '',
  htmlSource: '',
  htmlDirty: false,
  useSignature: true,
  delayKey: '20',
  customDate: '',
  campaign: EMPTY_CAMPAIGN,
}

type MailSettings = {
  signature: string
  signatureLogo: string
  senderName: string
  confirmSend: boolean
  showRemoteImages: boolean
  notifications: boolean
  desktopNotifications: boolean
  density: 'compact' | 'relaxed'
  /** Percent. Scales the whole interface, not only the type. */
  uiScale: number
  mobile: string
  replyAllDefault: boolean
  notifyEmail: string
  fonts: CustomFont[]
  defaultFont: BaseFont
  prefs?: { theme?: ThemePref; accent?: string; themeCustom?: ThemeCustom; layout?: 'list' | 'bubbles' }
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const DEFAULT_SETTINGS: MailSettings = {
  signature: '',
  signatureLogo: '',
  senderName: '',
  confirmSend: false,
  showRemoteImages: true,
  notifications: false,
  notifyEmail: '',
  desktopNotifications: false,
  density: 'compact',
  uiScale: 100,
  mobile: '',
  replyAllDefault: false,
  fonts: [],
  defaultFont: EMPTY_FONT,
}

type SettingsTab = 'profile' | 'signature' | 'appearance' | 'notifications' | 'mail' | 'people' | 'app'

type ShareLink = {
  id: string
  filename: string
  size: number
  hasPassword: boolean
  expiresAt: string | null
  downloads: number
  maxDownloads: number | null
  revoked: boolean
}

type LibraryFile = {
  messageId: string
  filename: string
  size: number
  contentType?: string
  url: string
  subject: string
  from: string
  at: string
  sent?: boolean
}

const SETTINGS_TABS: Array<{ key: SettingsTab; label: string; hint: string; adminOnly?: boolean }> = [
  { key: 'profile', label: 'Account', hint: 'Your address, name and password' },
  { key: 'signature', label: 'Signature', hint: 'What goes at the end of your mail' },
  { key: 'mail', label: 'Writing & reading', hint: 'Fonts, replies and images' },
  { key: 'appearance', label: 'Appearance', hint: 'Theme, size and density' },
  { key: 'notifications', label: 'Notifications', hint: 'How you hear about mail' },
  { key: 'people', label: 'People with access', hint: 'Mailboxes and roles', adminOnly: true },
  { key: 'app', label: 'Installed app', hint: 'Install, version, sign out' },
]

// Addresses that count as "us" when working out who a reply should go back to.
const MAIL_ADDRESSES: string[] = CLIENT_BRAND.addresses

/** Everyone here signs in at the same domain, so only the part before it is worth typing. */
const LOGIN_DOMAINS: string[] = CLIENT_BRAND.addressDomains.length
  ? CLIENT_BRAND.addressDomains
  : [(MAIL_ADDRESSES[0] ?? `@${CLIENT_BRAND.domain}`).split('@')[1] ?? CLIENT_BRAND.domain]
const DEFAULT_MAIL_DOMAIN = LOGIN_DOMAINS[0]

const LABELS: Array<{ id: string; name: string; color: string }> = [
  { id: 'important', name: 'Important', color: '#F5A623' },
  { id: 'follow-up', name: 'Follow-up', color: '#8B4FF5' },
  { id: 'client', name: 'Client', color: '#34D399' },
  { id: 'receipt', name: 'Receipt', color: '#5AA9F0' },
]
const LABEL_BY_ID = new Map(LABELS.map(label => [label.id, label]))

const ACADEMY_COURSES = ['Graphic Design', 'Programming', 'Networking & IT', 'UI/UX Design']
const MAX_COURSES = 2
const PROJECT_TYPES = ['Web app', 'Mobile app', 'Web platform', 'Advanced', 'Design', 'Automation', 'Other']

const DELAY_OPTIONS = [
  { key: '0', label: 'Send now' },
  { key: '20', label: 'Delay 20s' },
  { key: '60', label: 'Delay 1 min' },
  { key: '600', label: 'Delay 10 min' },
  { key: '3600', label: 'Delay 1 hour' },
  { key: 'custom', label: 'Pick date & time' },
]


/** The copy with the brand colour in its pixels; the site's own mark is alpha-only. */
const PRINT_MARK_URL = CLIENT_BRAND.markUrl

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}

function escapeHtml(src: string): string {
  return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineMd(src: string): string {
  return src
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:#F4EEFF;color:#5418C2;padding:2px 5px;border-radius:4px;font-size:13px;">$1</code>')
    // Images before links — otherwise the link rule swallows ![alt](src) and leaves a stray "!".
    .replace(
      /!\[(.*?)\]\((.+?)\)/g,
      '<img src="$2" alt="$1" style="max-width:100%;height:auto;display:block;margin:12px 0;border-radius:8px;" />',
    )
    .replace(
      /\[button:(.+?)\]\((.+?)\)/g,
      '<a href="$2" style="display:inline-block;background:${CLIENT_BRAND.accent};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;margin:6px 0;">$1</a>',
    )
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:${CLIENT_BRAND.accent};">$1</a>')
}

// Signatures used to be stored as markdown. Anything without tags is still run through
// the markdown path so an existing signature keeps rendering after the editor switch.
const asRichHtml = (value: string): string =>
  /<[a-z][\s\S]*>/i.test(value) ? value : markdownToHtml(value)

// A long reply chain re-embeds the sender's signature and social icons on every hop, so
// one message can carry a hundred of them. They are part of the body, not files anyone
// attached, and listing them buries the two or three real documents.
const EMBEDDED_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|image\d*)\.(png|gif|jpe?g)$/i

function isEmbeddedImage(entry: { filename?: string; contentType?: string; size?: number }): boolean {
  if (!entry.contentType?.startsWith('image/')) return false
  if ((entry.size ?? 0) > 20_000) return false
  return EMBEDDED_NAME.test(entry.filename ?? '')
}

function markdownToHtml(src: string): string {
  const lines = escapeHtml(src).split('\n')
  const out: string[] = []
  let list: string[] = []
  let paragraph: string[] = []
  let quote: string[] = []

  const flushList = () => {
    if (!list.length) return
    out.push(`<ul style="margin:0 0 16px;padding-left:22px;">${list.map(item => `<li style="margin:0 0 6px;">${item}</li>`).join('')}</ul>`)
    list = []
  }
  const flushParagraph = () => {
    if (!paragraph.length) return
    out.push(`<p style="margin:0 0 16px;">${paragraph.join('<br/>')}</p>`)
    paragraph = []
  }
  const flushQuote = () => {
    if (!quote.length) return
    out.push(
      `<blockquote style="margin:0 0 16px;padding:4px 0 4px 14px;border-left:3px solid #C9BCEC;color:#6B6480;">${quote.join('<br/>')}</blockquote>`,
    )
    quote = []
  }
  const flushBlocks = () => {
    flushList()
    flushParagraph()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      flushBlocks()
      continue
    }
    // escapeHtml has already turned a leading ">" into "&gt;"
    if (line.startsWith('&gt;')) {
      flushList(); flushParagraph()
      const inner = line.replace(/^&gt;\s?/, '')
      quote.push(inner ? inlineMd(inner) : '')
    } else if (line.startsWith('### ')) {
      flushBlocks()
      out.push(`<h3 style="margin:22px 0 10px;font-size:17px;">${inlineMd(line.slice(4))}</h3>`)
    } else if (line.startsWith('## ')) {
      flushBlocks()
      out.push(`<h2 style="margin:26px 0 12px;font-size:21px;">${inlineMd(line.slice(3))}</h2>`)
    } else if (line === '---') {
      flushBlocks()
      out.push('<hr style="border:none;border-top:1px solid #E5DEF5;margin:22px 0;"/>')
    } else if (line.startsWith('- ')) {
      flushParagraph(); flushQuote()
      list.push(inlineMd(line.slice(2)))
    } else {
      flushList(); flushQuote()
      paragraph.push(inlineMd(line))
    }
  }
  flushBlocks()
  return out.join('\n')
}

function buildEmailHtml(data: ComposeData, signatureHtml: string, fontCss = '', base: BaseFont = EMPTY_FONT): string {
  if (data.htmlDirty && data.htmlSource.trim()) return data.htmlSource
  // Editor HTML for anything composed here; markdown only for drafts saved before it.
  const body = data.bodyHtml.trim() ? data.bodyHtml : markdownToHtml(data.markdown)
  const inner = body + (data.useSignature ? signatureHtml : '')
  const fonts = fontCss ? `<style>${fontCss}</style>` : ''
  return `${fonts}<div style="font-family:${fontStack(base.family)};font-size:${base.size || '15px'};line-height:1.65;color:#030712;">${outlookSafeImages(inlineEmailStyles(inner, base))}</div>${data.quoteHtml ?? ''}`
}

function buildEmailText(data: ComposeData, signatureText: string): string {
  // Every message carries a text part: some clients prefer it, and its absence reads as spam.
  const quoteText = data.quoteHtml ? `\n\n${htmlToPlainText(data.quoteHtml)}` : ''
  if (data.bodyHtml.trim()) {
    return (htmlToPlainText(data.bodyHtml) + (data.useSignature ? signatureText : '') + quoteText).trim()
  }
  const body = data.markdown + (data.useSignature ? signatureText : '') + quoteText
  return body
    // Images first, for the same precedence reason as inlineMd. The replacement must not
    // contain brackets, or the link rule below matches across it and mangles the line.
    .replace(/!\[(.*?)\]\((.+?)\)/g, (_match, alt: string, url: string) => (alt ? `${alt} — ${url}` : `Image — ${url}`))
    .replace(/\[button:(.+?)\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/[*#`]/g, '')
    .trim()
}

// Preview text for lists. Email bodies routinely carry inlined base64 images, tracking
// URLs and entity soup — none of which reads as a preview, so strip it and fall back to
// naming the media when that's all the message contains.
function cleanSnippet(raw: string): string {
  return raw
    .replace(/\[?\s*data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\]?/gi, ' ')
    .replace(/\bcid:[^\s"'>]+/gi, ' ')
    .replace(/https?:\/\/\S{120,}/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&zwnj;|&#8204;|‌|​|­/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToSnippetText(html: string | null, text: string | null): string {
  const fromText = text?.trim() ? cleanSnippet(text) : ''
  if (fromText) return fromText
  if (!html) return ''
  const images = (html.match(/<img\b/gi) ?? []).length
  const body = cleanSnippet(
    html
      .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
  if (body) return body
  if (images) return images > 1 ? `${images} images` : 'Image'
  return ''
}

function htmlToQuoteText(html: string | null, text: string | null): string {
  if (text?.trim()) return text.trim()
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Real, visible images in an email (skips the 1x1 tracking pixel and inline cid: parts).
function extractBubbleImages(html: string | null): string[] {
  if (!html) return []
  const out: string[] = []
  const tags = html.match(/<img\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1]
    if (!src) continue
    if (/\/api\/dev\/mail\/pixel\//.test(src)) continue
    if (/\bwidth=["']?1\b/.test(tag) && /\bheight=["']?1\b/.test(tag)) continue
    if (/display\s*:\s*none/i.test(tag)) continue
    if ((src.startsWith('data:image') || /^https?:\/\//i.test(src)) && !out.includes(src)) out.push(src)
  }
  return out
}

// The new part of a message for a chat bubble: drop the quoted reply history and signature.
function cleanBubbleText(html: string | null, text: string | null): string {
  const raw = htmlToQuoteText(html, text)
  if (!raw) return ''
  const kept: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (/^On\b.+\bwrote:\s*$/i.test(trimmed)) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(trimmed)) break
    if (/^_{5,}$/.test(trimmed)) break
    if (/^>+/.test(trimmed)) break
    if (/^(From|Sent|To|Subject):\s/i.test(trimmed) && kept.length > 3) break
    kept.push(line)
  }
  let body = kept.join('\n')
  const signature = body.search(/\n--[ \t]*\n/)
  if (signature >= 0) body = body.slice(0, signature)
  return body.replace(/\n{3,}/g, '\n\n').trim()
}

function parseAddress(raw: string): string {
  const match = raw.match(/<([^>]+)>/)
  return (match ? match[1] : raw).trim()
}

function isForwarded(subject: string): boolean {
  // Fwd: markers anywhere, plus the app's own "New mail: …" forward/notification prefix.
  return /(^|\s)fwd?\s*:/i.test(subject) || /^\s*new mail\s*:/i.test(subject)
}

/**
 * Inbound noise generated by this app itself. Deliberately narrower than isForwarded:
 * a real person replying on a forwarded thread keeps "Fwd:" in the subject, and hiding
 * those made genuinely addressed mail invisible in the inbox.
 */
function isAppNotification(subject: string): boolean {
  return /^\s*new mail\s*:/i.test(subject)
}

const STATUS_ORDER = [
  'email.scheduled',
  'email.queued',
  'email.sent',
  'email.delivery_delayed',
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.bounced',
  'email.complained',
  'email.failed',
]
function statusRank(type: string): number {
  const index = STATUS_ORDER.indexOf(type)
  return index === -1 ? STATUS_ORDER.length : index
}

/** Turns a status code into something a person can act on. */
function describeHttp(status: number): string {
  if (status === 401 || status === 403) return 'Your session is not authorised. Sign in again.'
  if (status === 429) return 'Too many requests. Wait a moment and retry.'
  if (status >= 500) return 'The mail server is not responding. This is usually temporary.'
  return `The mail server refused the request (${status}).`
}

function ReaderSkeleton() {
  return (
    <div className={styles.readerSkeleton} role="status" aria-label="Opening conversation">
      <span className={`${styles.skelBar} ${styles.skelSubject}`} />
      <div className={styles.skelHeadRow}>
        <span className={styles.skelAvatar} />
        <div className={styles.skelHeadLines}>
          <span className={styles.skelBar} />
          <span className={styles.skelBar} />
        </div>
      </div>
      <div className={styles.skelActions}>
        <span className={styles.skelBar} />
        <span className={styles.skelBar} />
        <span className={styles.skelBar} />
      </div>
      <BodySkeleton />
    </div>
  )
}

function BodySkeleton() {
  return (
    <div className={styles.bodySkeleton} role="status" aria-label="Loading email">
      <div className={styles.skelHeadRow}>
        <span className={styles.skelAvatar} />
        <div className={styles.skelHeadLines}>
          <span className={styles.skelBar} />
          <span className={styles.skelBar} />
        </div>
      </div>
      <span className={styles.skelBar} />
      <span className={styles.skelBar} />
      <span className={styles.skelBar} />
      <span className={styles.skelBar} />
      <span className={styles.skelBlock} />
      <span className={styles.skelBar} />
      <span className={styles.skelBar} />
      <span className={styles.skelBar} />
    </div>
  )
}

function countRemoteRefs(html: string | null): number {
  if (!html) return 0
  return (html.match(/(?:src|background)\s*=\s*["']?https?:\/\//gi) ?? []).length
}

// Show the email in its true colours on a light "paper" card, framed by the dark
// reader. The markup is left untouched — the card supplies a legible white surface
// for bare fragments, and emails that paint their own background render as designed.
const READER_THEME = `<style>
  :root { color-scheme: light; }
  /* Transparent so the framed document takes the app's themed surface from the
     iframe element behind it. Theme variables do not cross the document boundary,
     so anything set here would be a colour frozen against one theme. */
  html { background: transparent; }
  body { margin: 0; background: transparent; padding: 22px 22px 44px; }
  .nc-paper {
    max-width: 800px;
    margin: 0 auto;
    background: #ffffff;
    color: #1A1030;
    border-radius: 14px;
    padding: 30px 34px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.7;
    -webkit-font-smoothing: antialiased;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .nc-paper img { max-width: 100%; height: auto; }
  .nc-paper a { color: #5418C2; }
</style>`

/**
 * Convert pasted rich text into the markdown dialect the composer understands, so
 * formatting from Docs/Word/web pages survives a paste into a plain textarea.
 * Emits only what markdownToHtml supports: ##/###, -, >, ---, **bold**, *italic*, links.
 */
function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('style, script, head, meta, title').forEach(node => node.remove())

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()
    if (tag === 'img') {
      const src = element.getAttribute('src') ?? ''
      const alt = (element.getAttribute('alt') ?? '').replace(/[[\]]/g, '')
      const width = Number(element.getAttribute('width') ?? 0)
      const height = Number(element.getAttribute('height') ?? 0)
      // cid: parts only resolve inside their original message, and 1x1s are trackers.
      if (!src || src.startsWith('cid:') || (width === 1 && height === 1)) return ''
      return `![${alt}](${src})`
    }
    const inner = Array.from(element.childNodes).map(inline).join('')
    const weight = element.style?.fontWeight
    const bold = tag === 'strong' || tag === 'b' || weight === 'bold' || Number(weight) >= 600
    const italic = tag === 'em' || tag === 'i' || element.style?.fontStyle === 'italic'
    if (!inner.trim()) return tag === 'br' ? '\n' : ''
    if (tag === 'a') {
      const href = element.getAttribute('href') ?? ''
      return href && !href.startsWith('#') ? `[${inner.trim()}](${href})` : inner
    }
    if (bold) return `**${inner.trim()}**`
    if (italic) return `*${inner.trim()}*`
    return inner
  }

  const blocks: string[] = []
  const walk = (node: Node, quoted = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) blocks.push(quoted ? `> ${text}` : text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as HTMLElement
    const tag = element.tagName.toLowerCase()
    const children = Array.from(element.childNodes)
    const flat = () => inline(element).replace(/\s+/g, ' ').trim()

    if (tag === 'br') return
    if (tag === 'hr') return void blocks.push('---')
    if (/^h[1-6]$/.test(tag)) {
      // Headings render bold already — editors wrap them in bold spans, so drop the markers.
      const text = flat().replace(/\*\*/g, '')
      if (text) blocks.push(`${tag === 'h1' || tag === 'h2' ? '##' : '###'} ${text}`)
      return
    }
    if (tag === 'li') {
      const text = flat()
      if (text) blocks.push(`- ${text}`)
      return
    }
    if (tag === 'blockquote') {
      children.forEach(child => walk(child, true))
      return
    }
    if (tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tbody' || tag === 'tr') {
      children.forEach(child => walk(child, quoted))
      return
    }
    // A block that holds only inline content becomes one paragraph; otherwise recurse.
    const hasBlockChild = children.some(
      child => child.nodeType === Node.ELEMENT_NODE && /^(p|div|h[1-6]|ul|ol|li|blockquote|table|tr|td|hr|section|article)$/i.test((child as HTMLElement).tagName),
    )
    if (hasBlockChild) {
      children.forEach(child => walk(child, quoted))
      return
    }
    const text = inline(element).replace(/[ \t]+/g, ' ').trim()
    if (text) blocks.push(quoted ? `> ${text}` : text)
  }

  Array.from(doc.body.childNodes).forEach(node => walk(node))
  // Consecutive list items and quote lines must stay adjacent — a blank line between them
  // closes the list/quote in markdownToHtml and would split one list into several.
  const joined = blocks.reduce((text, block, index) => {
    if (!index) return block
    const previous = blocks[index - 1]
    const sameRun =
      (block.startsWith('- ') && previous.startsWith('- ')) || (block.startsWith('> ') && previous.startsWith('> '))
    return `${text}${sameRun ? '\n' : '\n\n'}${block}`
  }, '')
  return joined.replace(/\n{3,}/g, '\n\n').trim()
}

/** Rich clipboard payloads only — plain text should paste normally. */
function pastedMarkdown(event: React.ClipboardEvent): string | null {
  const html = event.clipboardData?.getData('text/html')
  if (!html || !/<(a|b|strong|i|em|h[1-6]|ul|ol|li|blockquote|hr|table|img)\b/i.test(html)) return null
  const markdown = htmlToMarkdown(html)
  return markdown || null
}

// Reading our own sent mail must not register as the recipient opening it, so the
// tracking pixel is removed before the message is ever rendered in this app.
function stripOwnPixel(html: string): string {
  return html.replace(/<img[^>]*\/api\/dev\/mail\/pixel\/[^>]*>/gi, '')
}

/**
 * Our own hosts stay allowed even with remote images off. Blocking a sender's images
 * is what that setting is for; the mark in our own signature is not a tracking pixel,
 * and blocking it put a broken image on the end of every message we send.
 */
const OWN_IMAGE_HOSTS = `${CLIENT_BRAND.websiteUrl} ${CLIENT_BRAND.publicUrl}`

// When allowRemote is false the CSP blocks remote fetches so tracking pixels never load.
function frameHtml(html: string, allowRemote: boolean): string {
  const csp = allowRemote
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:; media-src * data:">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${OWN_IMAGE_HOSTS} data:; style-src 'unsafe-inline'; font-src data:">`
  return `<!doctype html><html><head><meta charset="utf-8">${csp}${READER_THEME}<base target="_blank"></head><body><div class="nc-paper">${stripOwnPixel(html)}</div></body>`
}

function headerValue(email: InboundEmail, key: string): string {
  const headers = email.headers || {}
  const match = Object.keys(headers).find(name => name.toLowerCase() === key.toLowerCase())
  return match ? String((headers as Record<string, unknown>)[match] ?? '') : ''
}


// Message-IDs this email is connected to: its own, the one it replies to, and the
// full References chain. Used to stitch replies into a conversation.
function messageTokens(email: InboundEmail): string[] {
  const ids: string[] = []
  const own = headerValue(email, 'message-id')
  const inReplyTo = headerValue(email, 'in-reply-to')
  const references = headerValue(email, 'references')
  if (own) ids.push(own)
  if (inReplyTo) ids.push(inReplyTo)
  if (references) ids.push(...references.split(/\s+/))
  return ids.map(id => id.replace(/[<>]/g, '').trim()).filter(Boolean)
}

// Union-find grouping: two emails share a thread when their message-id chains
// intersect, or (fallback for header-less clients) when their subjects match.
function computeThreadKeys(emails: InboundEmail[]): Map<string, string> {
  const parent = new Map<string, string>()
  emails.forEach(email => parent.set(email.id, email.id))
  const find = (node: string): string => {
    let root = node
    while (parent.get(root) !== root) root = parent.get(root)!
    while (parent.get(node) !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }
  const union = (left: string, right: string) => {
    const rootLeft = find(left)
    const rootRight = find(right)
    if (rootLeft !== rootRight) parent.set(rootLeft, rootRight)
  }
  const signalOwner = new Map<string, string>()
  for (const email of emails) {
    const signals = messageTokens(email).map(token => `mid:${token}`)
    const subject = normalizeSubject(email.subject)
    if (subject) signals.push(`subj:${subject}`)
    for (const signal of signals) {
      const owner = signalOwner.get(signal)
      if (owner) union(email.id, owner)
      else signalOwner.set(signal, email.id)
    }
  }
  const keys = new Map<string, string>()
  emails.forEach(email => keys.set(email.id, find(email.id)))
  return keys
}

// Distil the SPF / DKIM / DMARC results into a one-line trust summary.
function authSummary(email: InboundEmail): string {
  const results = headerValue(email, 'authentication-results').toLowerCase()
  if (!results) return ''
  const parts: string[] = []
  for (const mech of ['spf', 'dkim', 'dmarc']) {
    const found = results.match(new RegExp(`${mech}=(\\w+)`))
    if (found) parts.push(`${mech.toUpperCase()} ${found[1]}`)
  }
  return parts.join(' · ')
}

function rawInboundMessage(email: InboundEmail): string {
  const messageId = headerValue(email, 'message-id') || email.id
  return [
    `From: ${email.from}`,
    `To: ${email.to.join(', ')}`,
    email.cc.length ? `Cc: ${email.cc.join(', ')}` : null,
    email.bcc.length ? `Bcc: ${email.bcc.join(', ')}` : null,
    email.replyTo.length ? `Reply-To: ${email.replyTo.join(', ')}` : null,
    `Subject: ${email.subject}`,
    `Date: ${new Date(email.receivedAt).toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: ${email.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    '',
    email.html ? formatHtmlSource(email.html) : email.text ?? '',
  ]
    .filter(line => line !== null)
    .join('\n')
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** Re-indent HTML/XML source so it reads like code. Regex-based, tolerant of malformed email markup. */
function formatHtmlSource(html: string): string {
  if (!html?.trim()) return '(no HTML part)'
  const lines = html
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  let indent = 0
  const out: string[] = []
  for (const line of lines) {
    const closing = /^<\//.test(line)
    const openMatch = line.match(/^<([a-zA-Z][\w-]*)/)
    const tagName = openMatch?.[1]?.toLowerCase()
    const selfClose = /\/>\s*$/.test(line) || (!!tagName && VOID_TAGS.has(tagName))
    const comment = /^<!/.test(line)
    const opensAndCloses = !!tagName && new RegExp(`</${tagName}>\\s*$`).test(line)
    if (closing) indent = Math.max(0, indent - 1)
    out.push('  '.repeat(indent) + line)
    if (!closing && !selfClose && !comment && openMatch && !opensAndCloses) indent += 1
  }
  return out.join('\n')
}

function formatRelative(iso: string, now: number): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ''
  const diff = now - time
  if (diff < 0) return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000))
  if (total < 60) return `${total}s`
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type StashHeaders = Record<string, string>

async function fetchStash(kind: 'draft', headers: StashHeaders): Promise<Array<{ id: string; data: unknown; updatedAt: string }>> {
  try {
    const response = await fetch(`/api/mail/stash?kind=${kind}`, { headers })
    const data = await response.json()
    return data.ok ? data.items : []
  } catch {
    return []
  }
}

function putStash(kind: 'draft', id: string, data: unknown, headers: StashHeaders): void {
  fetch('/api/mail/stash', { method: 'PUT', headers, body: JSON.stringify({ kind, id, data }) }).catch(() => {})
}

function deleteStashItem(kind: 'draft', id: string, headers: StashHeaders): void {
  fetch(`/api/mail/stash?kind=${kind}&id=${encodeURIComponent(id)}`, { method: 'DELETE', headers }).catch(() => {})
}

function ChipField({
  chips,
  onChange,
  placeholder,
  suggest,
}: {
  chips: string[]
  onChange: (next: string[]) => void
  placeholder: string
  suggest?: (query: string) => Promise<Array<{ email: string; name: string | null }>>
}) {
  const [text, setText] = useState('')
  const [suggestions, setSuggestions] = useState<Array<{ email: string; name: string | null }>>([])
  const [highlight, setHighlight] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map(part => part.trim()).filter(Boolean)
    if (!parts.length) return
    const merged = [...chips]
    for (const part of parts) {
      if (!merged.includes(part)) merged.push(part)
    }
    onChange(merged)
    setText('')
    setSuggestions([])
  }

  const addContact = (candidate: string) => {
    if (!chips.includes(candidate)) onChange([...chips, candidate])
    setText('')
    setSuggestions([])
  }

  const onType = (value: string) => {
    setText(value)
    setHighlight(0)
    if (!suggest) return
    window.clearTimeout(timerRef.current)
    if (!value.trim()) {
      setSuggestions([])
      return
    }
    timerRef.current = setTimeout(async () => {
      const results = await suggest(value.trim())
      setSuggestions(results.filter(entry => !chips.includes(entry.email)).slice(0, 6))
    }, 160)
  }

  return (
    <>
      {chips.map(chip => (
        <span key={chip} className={`${styles.addrChip} ${EMAIL_RE.test(chip) ? '' : styles.addrChipBad}`}>
          {chip}
          <button type="button" aria-label={`Remove ${chip}`} onClick={() => onChange(chips.filter(entry => entry !== chip))}>
            ×
          </button>
        </span>
      ))}
      <span className={styles.chipInputWrap}>
        <input
          value={text}
          placeholder={chips.length ? '' : placeholder}
          onChange={event => onType(event.target.value)}
          onKeyDown={event => {
            if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setHighlight(current =>
                event.key === 'ArrowDown'
                  ? (current + 1) % suggestions.length
                  : (current - 1 + suggestions.length) % suggestions.length,
              )
            } else if (event.key === 'Enter' || event.key === ',' || event.key === 'Tab') {
              if (suggestions.length && event.key !== 'Tab') {
                event.preventDefault()
                addContact(suggestions[highlight].email)
              } else if (text.trim()) {
                event.preventDefault()
                commit(text)
              }
            } else if (event.key === 'Backspace' && !text && chips.length) {
              onChange(chips.slice(0, -1))
            } else if (event.key === 'Escape') {
              setSuggestions([])
            }
          }}
          onBlur={() => {
            window.setTimeout(() => setSuggestions([]), 150)
            commit(text)
          }}
        />
        {suggestions.length > 0 && (
          <div className={styles.suggestBox}>
            {suggestions.map((entry, index) => (
              <button
                type="button"
                key={entry.email}
                className={`${styles.suggestItem} ${index === highlight ? styles.suggestItemOn : ''}`}
                onMouseDown={event => {
                  event.preventDefault()
                  addContact(entry.email)
                }}
              >
                <span className={styles.suggestAvatar}>{(entry.name ?? entry.email)[0]?.toUpperCase()}</span>
                <span className={styles.suggestText}>
                  {entry.name && <span className={styles.suggestName}>{entry.name}</span>}
                  <span className={styles.suggestEmail}>{entry.email}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </span>
    </>
  )
}

const ICONS = {
  inbox: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l3.5-7z"/></svg>,
  sent: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/></svg>,
  scheduled: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  drafts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>,
  refresh: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4-4"/></svg>,
  close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
  copy: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m20 6-11 11-5-5"/></svg>,
  reply: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 17H6a4 4 0 0 1 0-8h12"/><path d="m14 5 4 4-4 4"/></svg>,
  forward: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 17h3a4 4 0 0 0 0-8H6"/><path d="M10 5 6 9l4 4"/></svg>,
  back: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>,
  attach: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>,
  replyAll: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m7 17-5-5 5-5"/><path d="m12 17-5-5 5-5"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg>,
  star: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 15.09 8.26 22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>,
  archive: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/></svg>,
  trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  unread: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7l10 6 10-6"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>,
  print: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>,
  image: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>,
  restore: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>,
  tag: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.2"/></svg>,
  pencil: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>,
  pin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l2 3.2H7l2-3.2Z"/></svg>,
  menu: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>,
  filter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  sliders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>,
  send: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  snooze: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="13" r="8"/><path d="M11 9v4l2.5 1.6"/><path d="M16.5 2.5h4l-4 4h4"/></svg>,
  chevron: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>,
  bellOff: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18.6 13A16.7 16.7 0 0 1 18 8a6 6 0 0 0-9.3-5"/><path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="m2 2 20 20"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  install: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v7"/><path d="m9 11 3 3 3-3"/></svg>,
  play: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4.5v15l13-7.5-13-7.5z"/></svg>,
  music: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>,
  file: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>,
  person: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  palette: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="13.5" cy="6.5" r=".8"/><circle cx="17.5" cy="10.5" r=".8"/><circle cx="8.5" cy="7.5" r=".8"/><circle cx="6.5" cy="12.5" r=".8"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8z"/></svg>,
  shield: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  key: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8.6-8.6"/><path d="m17 6 2.5 2.5"/><path d="m14.5 8.5 2.5 2.5"/></svg>,
}

const SETTINGS_TAB_ICONS: Record<SettingsTab, React.ReactNode> = {
  profile: ICONS.person,
  signature: ICONS.pencil,
  appearance: ICONS.palette,
  notifications: ICONS.bell,
  mail: ICONS.pencil,
  people: ICONS.users,
  app: ICONS.install,
}

const FOLDER_ICONS: Record<Folder, React.ReactNode> = {
  inbox: ICONS.inbox,
  starred: ICONS.star,
  snoozed: ICONS.snooze,
  sent: ICONS.sent,
  scheduled: ICONS.scheduled,
  drafts: ICONS.drafts,
  archived: ICONS.archive,
  trash: ICONS.trash,
}

export default function DevMailPage() {
  const confirm = useConfirm()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [checking, setChecking] = useState(true)
  const [loginError, setLoginError] = useState('')
  const [loginDetail, setLoginDetail] = useState('')
  const [loginDetailOpen, setLoginDetailOpen] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [resetMode, setResetMode] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [loginDomain, setLoginDomain] = useState(DEFAULT_MAIL_DOMAIN)
  const [loginRaw, setLoginRaw] = useState('')
  const [domainOpen, setDomainOpen] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)

  const [folder, setFolder] = useState<Folder>('inbox')
  const [search, setSearch] = useState('')
  const [sentEmails, setSentEmails] = useState<SentEmail[]>([])
  const [inboxEmails, setInboxEmails] = useState<InboundEmail[]>([])
  // The server owns search and paging now; the client holds one page at a time
  // rather than the whole mailbox.
  const [inboxTotal, setInboxTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [inboxCursor, setInboxCursor] = useState<string | null>(null)
  const inboxFetch = useRef<string | null>(null)
  type FolderTally = { inbox: number; unread: number; starred: number; archived: number; trashed: number; snoozed: number }
  const [serverCounts, setServerCounts] = useState<(FolderTally & { conversations: FolderTally | null }) | null>(null)
  const [countsLoading, setCountsLoading] = useState(false)
  const [composeExpanded, setComposeExpanded] = useState(true)
  const pwSectionRef = useRef<HTMLDivElement | null>(null)
  const [pwHighlight, setPwHighlight] = useState(false)
  // A counter, not a boolean: asking twice in a row should scroll and flash again.
  const [pwFocusRequest, setPwFocusRequest] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [events, setEvents] = useState<MailEvent[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, SentDetail>>({})
  const [showEmbedded, setShowEmbedded] = useState<Record<string, boolean>>({})
  const [inboundAttachments, setInboundAttachments] = useState<Record<string, DownloadAttachment[]>>({})
  const [readerOpenMobile, setReaderOpenMobile] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  // Collapsed unless this browser has chosen otherwise, so the mail gets the width by default.
  // Below this width the reader covers the list, so there is genuinely something behind it.
  const [listHidden, setListHidden] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)')
    const apply = () => setListHidden(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  // Below this the reader is the whole screen and a docked reply has nowhere to sit.
  const [isPhone, setIsPhone] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)')
    const apply = () => setIsPhone(media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  const [railCollapsed, setRailCollapsed] = useState(true)
  useEffect(() => {
    try {
      setRailCollapsed(localStorage.getItem(LS_RAIL_KEY) !== '0')
    } catch {}
  }, [])
  const [listWidth, setListWidth] = useState(LIST_W_DEFAULT)
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(LS_LIST_W_KEY))
      if (saved >= LIST_W_MIN && saved <= LIST_W_MAX) setListWidth(saved)
    } catch {}
  }, [])
  const listPaneRef = useRef<HTMLElement | null>(null)
  const startListResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const pane = listPaneRef.current
    if (!pane) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const left = pane.getBoundingClientRect().left
    let width = listWidth
    const move = (moveEvent: PointerEvent) => {
      width = Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, Math.round(moveEvent.clientX - left)))
      setListWidth(width)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      try {
        localStorage.setItem(LS_LIST_W_KEY, String(width))
      } catch {}
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }, [listWidth])
  const toggleRail = useCallback(() => {
    setRailCollapsed(current => {
      try {
        localStorage.setItem(LS_RAIL_KEY, current ? '0' : '1')
      } catch {}
      return !current
    })
  }, [])
  const [hideForwarded] = useState(true)
  const [showRemote, setShowRemote] = useState(false)
  const [showFullHeaders, setShowFullHeaders] = useState(false)
  const [readerMode, setReaderMode] = useState<'preview' | 'plain' | 'html' | 'raw'>('preview')
  const [readerLayout, setReaderLayout] = useState<'list' | 'bubbles'>('list')
  const [attachBar, setAttachBar] = useState<'open' | 'collapsed' | 'closed'>('open')
  const attachBarRef = useRef<HTMLDivElement | null>(null)
  const actingBarRef = useRef<HTMLDivElement | null>(null)
  const [actingBarHeight, setActingBarHeight] = useState(0)
  // Ids marked read locally whose PATCH has not confirmed. A poll that lands in that
  // window would otherwise reinstate the server's stale unread flag.
  const pendingRead = useRef<Set<string>>(new Set())
  const [attachBarHeight, setAttachBarHeight] = useState(0)
  const [threadOrder, setThreadOrder] = useState<'newest' | 'oldest'>('newest')
  const [threadOpening, setThreadOpening] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchPick, setSearchPick] = useState(0)
  const [threadExpanded, setThreadExpanded] = useState<Set<string>>(new Set())
  const [threadEverOpen, setThreadEverOpen] = useState<Set<string>>(new Set())
  const [linkVerdicts, setLinkVerdicts] = useState<Record<string, { verdict: LinkVerdict; reasons: string[] }>>({})
  const scanLinksRef = useRef<(urls: string[]) => void>(() => {})
  const [preview, setPreview] = useState<{ items: PreviewItem[]; index: number } | null>(null)
  const [labelMenuOpen, setLabelMenuOpen] = useState(false)
  const [selectedBulk, setSelectedBulk] = useState<Set<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNext, setPwNext] = useState('')
  const [pwRepeat, setPwRepeat] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  // Dismissed for this session only: it should come back next sign-in while the
  // password is still the one the mailbox was created with.
  const [pwNoticeHidden, setPwNoticeHidden] = useState(false)
  const [settings, setMailSettings] = useState<MailSettings>(DEFAULT_SETTINGS)
  const { canInstall, installed, install } = useInstall()
  const { permission: notifyPermission, request: requestNotifyPermission, announce } = useNotifications(
    settings.desktopNotifications,
  )

  const [themePref, setThemePref] = useState<ThemePref>('light')
  const [resolvedTheme, setResolvedTheme] = useState<ThemeBase>('light')
  const [accent, setAccent] = useState<string>(ACCENT_PRESETS[0].hex)
  const [themeCustom, setThemeCustom] = useState<ThemeCustom>({})
  // Hovering a swatch previews that whole theme — base, accent and surfaces — across the
  // entire app until the pointer leaves, so what you see is what applying would give you.
  const [themePreview, setThemePreview] = useState<{ base: ThemeBase; accent: string; vars: ThemeCustom } | null>(null)
  const [themeMenuOpen, setThemeMenuOpen] = useState(false)
  const themeMenuTimer = useRef<number | undefined>(undefined)
  // Closing on a short delay (cancelled if the pointer comes back) means travelling from
  // the button down into the menu never dismisses it mid-journey.
  const openThemeMenu = useCallback(() => {
    window.clearTimeout(themeMenuTimer.current)
    setThemeMenuOpen(true)
  }, [])
  const closeThemeMenuSoon = useCallback(() => {
    window.clearTimeout(themeMenuTimer.current)
    themeMenuTimer.current = window.setTimeout(() => {
      setThemeMenuOpen(false)
      setThemePreview(null)
    }, 220)
  }, [])
  const [account, setAccount] = useState<MailAccountInfo | null>(null)
  const [mailbox, setMailbox] = useState<string>('all')
  // Starts true so the very first fetch shows skeletons instead of the empty state.
  const [mailboxLoading, setMailboxLoading] = useState(true)
  const [mailboxStale, setMailboxStale] = useState(false)
  const lastRefreshAt = useRef(0)
  const [searching, setSearching] = useState(false)
  // A swallowed fetch error used to render as an empty inbox, which reads as "no mail"
  // rather than "we could not reach the server".
  const [loadError, setLoadError] = useState<string | null>(null)
  const mailboxFirstRun = useRef(true)
  const [filesOpen, setFilesOpen] = useState(false)
  const [shares, setShares] = useState<ShareLink[]>([])
  const [shareDraft, setShareDraft] = useState<LibraryFile | null>(null)
  const [shareExpiry, setShareExpiry] = useState(7)
  const [sharePassword, setSharePassword] = useState('')
  const [shareMax, setShareMax] = useState('')
  const [shareBusy, setShareBusy] = useState(false)
  const [shareResult, setShareResult] = useState<string | null>(null)
  const [filesMsg, setFilesMsg] = useState('')
  const [accessors, setAccessors] = useState<Accessor[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviteHandle, setInviteHandle] = useState('')
  const [addressDomain, setAddressDomain] = useState(CLIENT_BRAND.domain)
  const [addressDomains, setAddressDomains] = useState<string[]>([])
  const [inviteDomain, setInviteDomain] = useState('')
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [renameHandle, setRenameHandle] = useState('')
  const [renameDomain, setRenameDomain] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [accessorsMsg, setAccessorsMsg] = useState('')
  const isAdmin = account?.role === 'admin'

  const [composeOpen, setComposeOpen] = useState(false)
  const [compose, setCompose] = useState<ComposeData>(EMPTY_COMPOSE)
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  // Index of the file whose password sheet is open, or null.
  const [lockTarget, setLockTarget] = useState<number | null>(null)
  const [attachExpanded, setAttachExpanded] = useState<string | null>(null)
  const [attachCopied, setAttachCopied] = useState<{ uid: string; ok: boolean } | null>(null)
  const previewUrls = useRef<string[]>([])
  useEffect(() => {
    const urls = previewUrls.current
    return () => urls.forEach(url => URL.revokeObjectURL(url))
  }, [])
  const [lockValue, setLockValue] = useState('')
  // 'armed' = a file is loose over the window, 'over' = it's above the drop target.
  const [dragState, setDragState] = useState<'idle' | 'armed' | 'over'>('idle')
  const dragDepth = useRef(0)
  const [sending, setSending] = useState(false)
  const [composeError, setComposeError] = useState('')
  const [draftId, setDraftId] = useState<string | null>(null)
  const [quickReply, setQuickReply] = useState('')
  const [replyError, setReplyError] = useState('')
  // Collapsed by default: the signature is long, and the composer is for the message.
  const [sigExpanded, setSigExpanded] = useState(false)
  const [sigPreviewOpen, setSigPreviewOpen] = useState(false)
  /**
   * Measured at the click, not on mount: before the content has settled it reports several
   * times its real height, and the reveal then finishes long before the animation does.
   */
  /** Clicking the folded signature opens it, unless the click was on a link inside it. */
  const expandSignatureFromBody = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (sigExpanded) return
    if ((event.target as HTMLElement).closest('a')) return
    const body = event.currentTarget
    body.style.setProperty('--sig-h', `${body.scrollHeight}px`)
    setSigExpanded(true)
  }, [sigExpanded])

  const toggleSignature = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const fold = event.currentTarget.closest(`.${styles.composeSignature}`)
    const body = fold?.querySelector<HTMLElement>(`.${styles.composeSignatureBody}`)
    if (body) body.style.setProperty('--sig-h', `${body.scrollHeight}px`)
    setSigExpanded(open => !open)
  }, [])
  const [quickSending, setQuickSending] = useState(false)
  const [replyMode, setReplyMode] = useState<ReplyMode>('write')
  const [replySig, setReplySig] = useState(true)
  const [replyHtml, setReplyHtml] = useState('')
  const [replyHtmlDirty, setReplyHtmlDirty] = useState(false)
  const [replyToList, setReplyToList] = useState<string[]>([])
  const [replyCc, setReplyCc] = useState<string[]>([])
  const [replyBcc, setReplyBcc] = useState<string[]>([])
  const [replyRecipsOpen, setReplyRecipsOpen] = useState(false)
  // Once the recipients have been touched they are the writer's, including when emptied.
  const [replyRecipsEdited, setReplyRecipsEdited] = useState(false)
  const quickReplyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    setQuickReply('')
    setReplyMode('write')
    setReplySig(true)
    setReplyHtml('')
    setReplyHtmlDirty(false)
    setReplyToList([])
    setReplyCc([])
    setReplyBcc([])
    setReplyRecipsOpen(false)
    setReplyRecipsEdited(false)
  }, [selectedId])
  // Grow the reply box to fit its content; the CSS max-height caps it (8 lines) and scrolls past it.
  useEffect(() => {
    const field = quickReplyRef.current
    if (!field || replyMode !== 'write') return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [quickReply, replyMode])

  const [undo, setUndo] = useState<{ id: string; sendAt: number; snapshot: ComposeData; attachments: Attachment[] } | null>(null)
  const [sentFlash, setSentFlash] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const fileRef = useRef<HTMLInputElement>(null)
  // The composer's own input is unmounted while the composer is closed, so the reply
  // tray keeps one of its own rather than reaching for a ref that is null.
  const replyFileRef = useRef<HTMLInputElement>(null)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The password rides along only for the tab that typed it, and only until the session
  // cookie set by /api/mail/login takes over. It is never persisted.
  const apiHeaders = useCallback(
    (): Record<string, string> => ({
      'Content-Type': 'application/json',
      'x-dev-email': email,
      ...(password ? { 'x-dev-password': password } : {}),
    }),
    [email, password],
  )
  const [threads, setThreads] = useState<ConversationRow[]>([])
  const [threadsResolved, setThreadsResolved] = useState(false)
  const threadFolder = folder === 'archived' ? 'archive' : folder === 'trash' ? 'trash' : folder === 'starred' ? 'starred' : folder === 'snoozed' ? 'snoozed' : 'inbox'
  const threadsFetch = useRef<string | null>(null)
  const threadsLoadedFolder = useRef<string | null>(null)
  const [threadsCursor, setThreadsCursor] = useState<string | null>(null)
  const THREAD_PAGE = 500
  const loadThreads = useCallback(async () => {
    if (!isLoggedIn) return
    if (threadsFetch.current === threadFolder) return
    threadsFetch.current = threadFolder
    try {
      const response = await fetch(`/api/mail/threads?folder=${threadFolder}&limit=${THREAD_PAGE}`, { headers: apiHeaders() })
      const data = await response.json().catch(() => null)
      if (data?.ok && Array.isArray(data.threads)) {
        const fresh = data.threads as ConversationRow[]
        const replace = threadsLoadedFolder.current !== threadFolder
        threadsLoadedFolder.current = threadFolder
        setThreads(current => {
          if (replace || current.length === 0) return fresh
          const freshIds = new Set(fresh.map(entry => entry.threadId))
          return [...fresh, ...current.filter(entry => !freshIds.has(entry.threadId))]
        })
        setThreadsCursor(current => (replace ? (data.nextCursor ?? null) : current ?? (data.nextCursor ?? null)))
      }
    } catch {
    } finally {
      if (threadsFetch.current === threadFolder) threadsFetch.current = null
      setThreadsResolved(true)
    }
  }, [isLoggedIn, threadFolder, apiHeaders])

  const threadPageInFlight = useRef(false)
  const loadMoreThreads = useCallback(async () => {
    if (!threadsCursor || threadPageInFlight.current) return
    threadPageInFlight.current = true
    setLoadingMore(true)
    try {
      const response = await fetch(`/api/mail/threads?folder=${threadFolder}&limit=${THREAD_PAGE}&cursor=${encodeURIComponent(threadsCursor)}`, { headers: apiHeaders() })
      const data = await response.json().catch(() => null)
      if (!data?.ok || !Array.isArray(data.threads)) return
      const fresh = data.threads as ConversationRow[]
      setThreads(current => {
        const seen = new Set(current.map(entry => entry.threadId))
        return [...current, ...fresh.filter(entry => !seen.has(entry.threadId))]
      })
      setThreadsCursor(data.nextCursor ?? null)
    } catch {
    } finally {
      threadPageInFlight.current = false
      setLoadingMore(false)
    }
  }, [threadsCursor, threadFolder, apiHeaders])

  useEffect(() => {
    setThreadsResolved(false)
    void loadThreads()
  }, [loadThreads])

  useEffect(() => {
    const saved = localStorage.getItem(LS_EMAIL_KEY) ? (JSON.parse(localStorage.getItem(LS_EMAIL_KEY)!) as string) : ''
    setEmail(saved)
    setLoginRaw(saved.split('@')[0])
    const savedDomain = localStorage.getItem(LS_DOMAIN_KEY)
    if (saved.includes('@')) setLoginDomain(saved.split('@')[1])
    else if (savedDomain) setLoginDomain(savedDomain)
    // A saved address means this browser was signed in before. Draw the mailbox now on
    // that assumption and let the session check correct it: waiting for the check first
    // held even the cached list behind a round trip, on every single visit.
    if (saved) {
      setIsLoggedIn(true)
      setChecking(false)
    }
    // Earlier builds kept the plaintext password here. Drop it on sight.
    localStorage.removeItem(LS_PASSWORD_KEY)
    const storedTheme = localStorage.getItem(LS_THEME_KEY)
    if (storedTheme === 'light' || storedTheme === 'dim' || storedTheme === 'dark' || storedTheme === 'system') setThemePref(storedTheme)
    const storedAccent = localStorage.getItem(LS_ACCENT_KEY)
    if (storedAccent && hexToHsl(storedAccent)) setAccent(storedAccent)
    try {
      const storedCustom = localStorage.getItem(LS_THEME_CUSTOM_KEY)
      if (storedCustom) setThemeCustom(JSON.parse(storedCustom) as ThemeCustom)
    } catch {}
    const storedLayout = localStorage.getItem(LS_LAYOUT_KEY)
    if (storedLayout === 'list' || storedLayout === 'bubbles') setReaderLayout(storedLayout)
    // Read before the account's settings arrive, so the interface does not resize under
    // the reader a second after it opens.
    const storedScale = Number(localStorage.getItem(LS_SCALE_KEY))
    if (storedScale >= SCALE_MIN && storedScale <= SCALE_MAX) {
      setMailSettings(current => ({ ...current, uiScale: storedScale }))
    }
  }, [])

  // The signature the firm maintains, which everyone without one of their own sends under.
  const [companySignature, setCompanySignature] = useState('')
  const [companySignatureEdited, setCompanySignatureEdited] = useState(false)
  const [companyLogo, setCompanyLogo] = useState('')
  const [signatureTab, setSignatureTab] = useState<'personal' | 'company'>('personal')
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  useEffect(() => {
    if (!isLoggedIn || !prefsLoaded) return
    const timer = window.setTimeout(() => {
      setMailSettings(current => {
        const prefs = { theme: themePref, accent, themeCustom, layout: readerLayout }
        if (JSON.stringify(current.prefs ?? {}) === JSON.stringify(prefs)) return current
        const next = { ...current, prefs }
        void fetch('/api/mail/settings', { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(next) }).catch(() => {})
        return next
      })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [isLoggedIn, prefsLoaded, themePref, accent, themeCustom, readerLayout, apiHeaders])

  useEffect(() => {
    const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(settings.uiScale || 100)))
    // zoom rather than a font size: every measurement in this interface is in pixels, and
    // scaling only the type would leave the type in boxes that no longer fit it.
    document.documentElement.style.zoom = scale === 100 ? '' : `${scale}%`
    try {
      localStorage.setItem(LS_SCALE_KEY, String(scale))
    } catch {}
  }, [settings.uiScale])

  const chooseLayout = useCallback((layout: 'list' | 'bubbles') => {
    setReaderLayout(layout)
    localStorage.setItem(LS_LAYOUT_KEY, layout)
  }, [])

  // Resolve 'system' against the device theme and keep it live if the OS theme flips.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => setResolvedTheme(themePref === 'system' ? (media.matches ? 'dark' : 'light') : themePref)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [themePref])

  const cycleTheme = useCallback(() => {
    setThemePref(prev => {
      const order: ThemePref[] = ['system', 'light', 'dim', 'dark']
      const next = order[(order.indexOf(prev) + 1) % order.length]
      localStorage.setItem(LS_THEME_KEY, next)
      return next
    })
  }, [])

  const chooseTheme = useCallback((pref: ThemePref) => {
    setThemePref(pref)
    localStorage.setItem(LS_THEME_KEY, pref)
  }, [])

  const chooseAccent = useCallback((hex: string) => {
    setAccent(hex)
    localStorage.setItem(LS_ACCENT_KEY, hex)
  }, [])

  const setThemeField = useCallback((key: string, value: string | null) => {
    setThemeCustom(current => {
      const next = { ...current }
      if (value) next[key] = value
      else delete next[key]
      localStorage.setItem(LS_THEME_CUSTOM_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const applyPreset = useCallback((key: string) => {
    const preset = THEME_PRESETS.find(entry => entry.key === key)
    if (!preset) return
    // Drop any hover preview so the applied preset's own surfaces show immediately.
    setThemePreview(null)
    setThemePref(preset.base)
    localStorage.setItem(LS_THEME_KEY, preset.base)
    setAccent(preset.accent)
    localStorage.setItem(LS_ACCENT_KEY, preset.accent)
    setThemeCustom(preset.vars)
    localStorage.setItem(LS_THEME_CUSTOM_KEY, JSON.stringify(preset.vars))
  }, [])

  const resetTheme = useCallback(() => {
    setThemeCustom({})
    localStorage.removeItem(LS_THEME_CUSTOM_KEY)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const attemptLogin = useCallback(
    async (candidateEmail: string, candidatePassword: string, silent: boolean) => {
      if (!silent) {
        setLoginBusy(true)
        setLoginDetail('')
      }
      try {
        const response = await fetch('/api/mail/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dev-email': candidateEmail,
            'x-dev-password': candidatePassword,
          },
        })
        const raw = await response.text()
        let data: { ok?: boolean; error?: string } = {}
        try {
          data = JSON.parse(raw)
        } catch {}
        if (data.ok) {
          setIsLoggedIn(true)
          localStorage.setItem(LS_EMAIL_KEY, JSON.stringify(candidateEmail))
        } else if (!silent) {
          // Say what actually happened — a 500 is not a wrong password.
          if (response.status === 401 || response.status === 403) {
            setLoginError('That email and password don’t match an account.')
          } else if (response.status >= 500) {
            setLoginError('The mail server hit an error. This is usually temporary — try again.')
          } else if (response.status === 429) {
            setLoginError('Too many attempts. Wait a moment and try again.')
          } else {
            setLoginError('Sign-in failed.')
          }
          setLoginDetail(`HTTP ${response.status} ${response.statusText || ''}`.trim() + (data.error ? ` · ${data.error}` : raw ? ` · ${raw.slice(0, 200)}` : ''))
        }
      } catch (err) {
        if (!silent) {
          setLoginError('Couldn’t reach the server. Check your connection and try again.')
          setLoginDetail(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setChecking(false)
        setLoginBusy(false)
      }
    },
    [],
  )

  // Staying signed in is the session cookie's job now, so the check is "does the cookie
  // still work", not "replay the password we saved".
  useEffect(() => {
    let live = true
    fetch('/api/mail/me')
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!live) return
        if (data?.ok) {
          setIsLoggedIn(true)
          if (data.email) setEmail(data.email)
        } else {
          // The optimistic paint above assumed the session was alive; it was not.
          setIsLoggedIn(false)
        }
      })
      .catch(() => {
        if (live) setIsLoggedIn(false)
      })
      .finally(() => {
        if (live) setChecking(false)
      })
    return () => {
      live = false
    }
  }, [])

  const mailboxQuery = ''

  // Nobody browses another mailbox any more, so mail always goes out as the signed-in
  // account and there is no one to act as.
  const actingAs: string | null = null

  const loadSent = useCallback(async () => {
    try {
      const response = await fetch(`/api/mail/emails${mailboxQuery}`, { headers: apiHeaders() })
      const data = await response.json()
      if (data.ok) {
        const flags: Record<string, { starred: boolean; archived: boolean; trashed: boolean }> = data.flags ?? {}
        const opens: Record<string, { opened: boolean; openCount: number; openedAt: string | null }> = data.opens ?? {}
        setSentEmails(
          (data.emails as Array<Omit<SentEmail, 'starred' | 'archived' | 'trashed' | 'opened' | 'openCount' | 'openedAt'>>).map(entry => ({
            ...entry,
            starred: flags[entry.id]?.starred ?? false,
            archived: flags[entry.id]?.archived ?? false,
            trashed: flags[entry.id]?.trashed ?? false,
            opened: opens[entry.id]?.opened ?? false,
            openCount: opens[entry.id]?.openCount ?? 0,
            openedAt: opens[entry.id]?.openedAt ?? null,
          })),
        )
      }
    } catch {}
  }, [apiHeaders, mailboxQuery])

  // One request of 150 rows costs about two seconds; three of fifty cost five, because
  // the wait is the distance, not the data. Fetch the screenful in one trip.
  const INBOX_PAGE = 150

  const loadInbox = useCallback(
    async (cursor: string | null = null) => {
      // Only the first page is ever asked for twice on mount. Paging must never be
      // suppressed: a page that is skipped is a page that never arrives, and the cursor
      // stops advancing with it.
      const key = cursor ? null : `${mailboxQuery}|${threadFolder}|${search.trim()}`
      if (key && inboxFetch.current === key) return
      if (key) inboxFetch.current = key
      try {
        const params = new URLSearchParams(mailboxQuery.replace(/^\?/, ''))
        params.set('limit', String(INBOX_PAGE))
        params.set('folder', threadFolder)
        // A cursor asks for the page after a known row; without one this is the first page.
        if (cursor) params.set('cursor', cursor)
        const text = search.trim()
        if (text) params.set('q', text)
        const response = await fetch(`/api/mail/inbox?${params.toString()}`, { headers: apiHeaders() })
        if (!response.ok) throw new Error(describeHttp(response.status))
        const data = await response.json().catch(() => null)
        if (!data?.ok) throw new Error(data?.error || 'The mail server sent a response we could not read.')
        const fresh = (data.emails as InboundEmail[]).map(entry =>
          pendingRead.current.has(entry.id) && !entry.read ? { ...entry, read: true } : entry,
        )
        setInboxEmails(current => {
          if (!cursor) return fresh
          // Appending: a message can arrive while paging and shift the boundary.
          const seen = new Set(current.map(entry => entry.id))
          return [...current, ...fresh.filter(entry => !seen.has(entry.id))]
        })
        // Only the first page carries a count; later pages keep the figure we hold.
        if (typeof data.total === 'number') setInboxTotal(data.total)
        setInboxCursor(data.nextCursor ?? null)
        setLoadError(null)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Could not reach the mail server')
      } finally {
        if (key && inboxFetch.current === key) inboxFetch.current = null
        if (!cursor) setSearching(false)
      }
    },
    [apiHeaders, mailboxQuery, search, threadFolder],
  )

  /**
   * The periodic refresh must not throw away pages the reader has already scrolled
   * through. It re-reads the newest page and merges: rows it returns replace their
   * counterparts, genuinely new mail lands on top, and everything loaded below is kept —
   * so the list grows and updates without ever collapsing back to one page.
   */
  const refreshInbox = useCallback(async () => {
    // A search re-runs when it is typed; re-running it on every poll tick charged the
    // full-text scan again for a result set that was not changing.
    if (search.trim()) return
    const key = `${mailboxQuery}|${threadFolder}|${search.trim()}`
    if (inboxFetch.current === key) return
    inboxFetch.current = key
    try {
      const params = new URLSearchParams(mailboxQuery.replace(/^\?/, ''))
      params.set('limit', String(INBOX_PAGE))
      params.set('folder', threadFolder)
      const text = search.trim()
      if (text) params.set('q', text)
      const response = await fetch(`/api/mail/inbox?${params.toString()}`, { headers: apiHeaders() })
      if (!response.ok) throw new Error(describeHttp(response.status))
      const data = await response.json().catch(() => null)
      if (!data?.ok) throw new Error(data?.error || 'The mail server sent a response we could not read.')
      const fresh = (data.emails as InboundEmail[]).map(entry =>
        pendingRead.current.has(entry.id) && !entry.read ? { ...entry, read: true } : entry,
      )
      setInboxEmails(current => {
        if (current.length === 0) return fresh
        const freshIds = new Set(fresh.map(entry => entry.id))
        // A body fetched for an open message lives only on the loaded row; carry it over.
        const loaded = new Map(current.map(entry => [entry.id, entry]))
        const merged = fresh.map(entry => {
          const previous = loaded.get(entry.id)
          return previous?.html ? { ...entry, html: previous.html, text: previous.text ?? entry.text } : entry
        })
        return [...merged, ...current.filter(entry => !freshIds.has(entry.id))]
      })
      if (typeof data.total === 'number') setInboxTotal(data.total)
      // Deeper pages keep the cursor they already have — this refresh only ever sees the
      // first page. But when nothing has set one yet, this response is the first page, and
      // without adopting its cursor here scrolling for more would never arm.
      setInboxCursor(current => current ?? (data.nextCursor ?? null))
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not reach the mail server')
    } finally {
      if (inboxFetch.current === key) inboxFetch.current = null
    }
  }, [apiHeaders, mailboxQuery, search, threadFolder])

  /**
   * Folder totals come from the database rather than from the rows on hand: counting what
   * is loaded describes the page, not the mailbox, and grows as you scroll.
   */
  const lastCountAt = useRef(0)
  const loadCounts = useCallback(async (force = false) => {
    // Counting reads the whole mailbox — about seventy thousand rows here — so it runs when
    // the figures can actually have changed, not on the periodic refresh. A minute's
    // throttle keeps a burst of actions from re-counting once each.
    if (!force && Date.now() - lastCountAt.current < 300000) return
    if (!force && document.visibilityState !== 'visible') return
    lastCountAt.current = Date.now()
    setCountsLoading(true)
    try {
      const params = new URLSearchParams(mailboxQuery.replace(/^\?/, ''))
      // A forced count follows an action that just changed the figures, so it has to skip
      // the server's own cache as well as this one — otherwise a folder someone just moved
      // mail into reads zero for another twenty seconds.
      if (force) params.set('fresh', '1')
      const response = await fetch(`/api/mail/inbox/counts?${params.toString()}`, { headers: apiHeaders() })
      if (!response.ok) return
      const data = await response.json().catch(() => null)
      if (data?.ok && data.counts) setServerCounts(data.counts)
    } catch {
      // A failed count leaves the previous figures in place rather than blanking them.
    } finally {
      setCountsLoading(false)
    }
  }, [apiHeaders, mailboxQuery])

  useEffect(() => { void loadCounts() }, [loadCounts])

  const newestSeen = useRef('')
  useEffect(() => {
    if (inboxEmails.length === 0) return
    const newest = inboxEmails.reduce((latest, entry) => (entry.receivedAt > latest ? entry.receivedAt : latest), '')
    if (!newestSeen.current) {
      newestSeen.current = newest
      return
    }
    if (newest > newestSeen.current) {
      newestSeen.current = newest
      void loadCounts(true)
    }
  }, [inboxEmails, loadCounts])

  // Settings opens on the profile tab, which is long enough that the password fields sit
  // below the fold; bring them into view and mark them so it is obvious what was asked for.
  useEffect(() => {
    if (!pwFocusRequest || !settingsOpen || settingsTab !== 'profile') return
    const node = pwSectionRef.current
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setPwHighlight(true)
    const timer = window.setTimeout(() => setPwHighlight(false), 2400)
    return () => window.clearTimeout(timer)
  }, [pwFocusRequest, settingsOpen, settingsTab])

  // Typing re-queries the server rather than filtering an in-memory array.
  // Debounced so one word does not fire six requests.
  // The mailbox a person opens is almost always the one they closed. Painting the last
  // page from storage means the first frame has their mail in it, and the request that
  // follows corrects it — rather than a skeleton held for a round trip to another continent.
  useEffect(() => {
    if (!isLoggedIn) return
    try {
      const cached = localStorage.getItem(`${LS_INBOX_CACHE_KEY}:${email}`)
      if (!cached) return
      const saved = JSON.parse(cached) as { at?: number; rows?: InboundEmail[]; threads?: ConversationRow[]; folder?: string; counts?: typeof serverCounts }
      if (saved?.counts) setServerCounts(current => current ?? saved.counts!)
      const rows = Array.isArray(saved?.rows) ? saved.rows : null
      if (!rows?.length) return
      if (saved.folder !== threadFolder) return
      setInboxEmails(current => (current.length ? current : rows))
      if (Array.isArray(saved.threads) && saved.threads.length) {
        setThreads(current => (current.length ? current : saved.threads!))
      }
      setMailboxLoading(false)
      setMailboxStale(true)
    } catch {
      // A cache that will not parse is not worth a broken mailbox.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, email])

  useEffect(() => {
    if (!isLoggedIn || mailboxStale || inboxEmails.length === 0) return
    try {
      localStorage.setItem(
        `${LS_INBOX_CACHE_KEY}:${email}`,
        JSON.stringify({
          at: Date.now(),
          folder: threadFolder,
          rows: inboxEmails.slice(0, INBOX_PAGE).map(entry => ({ ...entry, html: null })),
          threads: threads.slice(0, 200),
          counts: serverCounts,
        }),
      )
    } catch {
      // Storage full or blocked: the cache is an optimisation, never a requirement.
    }
  }, [inboxEmails, threads, threadFolder, isLoggedIn, mailboxStale, email, serverCounts])

  const typedOnce = useRef(false)
  useEffect(() => {
    const delay = typedOnce.current ? 250 : 0
    typedOnce.current = true
    if (search.trim()) setSearching(true)
    const timer = window.setTimeout(() => { setInboxCursor(null); void loadInbox(null) }, delay)
    return () => window.clearTimeout(timer)
    // loadInbox changes identity on every keystroke; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, mailboxQuery, threadFolder])

  // A ref, not state: one page must be in flight at a time, and the check has to see the
  // current value synchronously — two observer callbacks can fire in the same tick.
  const pageInFlight = useRef(false)
  const loadMoreInbox = useCallback(async () => {
    if (!inboxCursor || pageInFlight.current) return
    pageInFlight.current = true
    setLoadingMore(true)
    try {
      await loadInbox(inboxCursor)
    } finally {
      pageInFlight.current = false
      setLoadingMore(false)
    }
  }, [loadInbox, inboxCursor])

  // The observer must not be rebuilt on every render: it would disconnect and re-observe
  // continuously, and each re-observe fires again while the sentinel is on screen — which
  // is an endless request loop. The effect therefore depends only on the cursor, and
  // reaches the current loader through a ref.
  const usingThreads = threads.length > 0 && !search.trim()
  const moreCursor = usingThreads ? threadsCursor : inboxCursor
  const loadMoreRef = useRef(loadMoreInbox)
  useEffect(() => { loadMoreRef.current = usingThreads ? loadMoreThreads : loadMoreInbox }, [usingThreads, loadMoreThreads, loadMoreInbox])

  // The list is its own scroll container, so this watches that element rather than the
  // viewport: it fires a screen early, and unlike an intersection observer it does not
  // depend on the document being visible. Also checked on mount, for a list that starts
  // shorter than its container and would otherwise never scroll.
  useEffect(() => {
    const node = listRef.current
    if (!node || !moreCursor) return
    const check = () => {
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 600) void loadMoreRef.current()
    }
    check()
    node.addEventListener('scroll', check, { passive: true })
    return () => node.removeEventListener('scroll', check)
  }, [moreCursor])

  /**
   * Swiping a row. Desktop reveals a row's actions on hover, which a phone cannot do, so
   * the same two actions live on a horizontal drag instead. The action is named and
   * coloured behind the row before it commits, and nothing fires below the threshold.
   */
  /**
   * Snooze. The times are the ones people actually mean when they say "not now": the rest
   * of today, first thing tomorrow, and the start of next week. Everything is computed in
   * the reader's own timezone, because "tomorrow morning" is a local idea.
   */
  const snoozeChoices = useMemo(() => {
    const at = (days: number, hour: number) => {
      const when = new Date()
      when.setDate(when.getDate() + days)
      when.setHours(hour, 0, 0, 0)
      return when
    }
    const laterToday = new Date(Date.now() + 3 * 60 * 60 * 1000)
    const tomorrow = at(1, 8)
    const monday = (() => {
      const when = at(1, 8)
      while (when.getDay() !== 1) when.setDate(when.getDate() + 1)
      return when
    })()
    const weekend = (() => {
      const when = at(1, 9)
      while (when.getDay() !== 6) when.setDate(when.getDate() + 1)
      return when
    })()
    return [
      // Past the end of the working day this stops meaning "later today".
      ...(laterToday.getHours() >= 7 && laterToday.getHours() <= 20
        ? [{ key: 'later', label: 'Later today', at: laterToday }]
        : []),
      { key: 'tomorrow', label: 'Tomorrow morning', at: tomorrow },
      { key: 'weekend', label: 'This weekend', at: weekend },
      { key: 'monday', label: 'Next week', at: monday },
    ]
  }, [])

  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false)
  const applySnooze = useCallback(
    (threadId: string | null, until: Date | null) => {
      if (!threadId) return
      setSnoozeMenuOpen(false)
      setThreads(list => list.filter(thread => thread.threadId !== threadId))
      setSelectedId(null)
      setReaderOpenMobile(false)
      fetch('/api/mail/inbox', {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ threadId, snoozedUntil: until ? until.toISOString() : null }),
      })
        .then(() => loadCounts(true))
        .catch(() => {})
    },
    [apiHeaders, loadCounts],
  )

  const SWIPE_COMMIT = 96
  const [swipe, setSwipe] = useState<{ id: string; dx: number; top: number; height: number } | null>(null)
  const swipeRef = useRef<{ id: string; threadId: string | null; x: number; y: number; dx: number; axis: '' | 'x' | 'y'; moved: boolean; top: number; height: number } | null>(null)
  const swipeCommitRef = useRef<(id: string, threadId: string | null, flags: Partial<Pick<InboundEmail, 'archived' | 'trashed'>>) => void>(() => {})

  const swipeActions = useMemo(() => {
    type SwipeAction = { label: string; flags: Partial<Pick<InboundEmail, 'archived' | 'trashed'>> } | null
    const set = (right: SwipeAction, left: SwipeAction) => ({ right, left })
    if (folder === 'trash') return set({ label: 'Restore', flags: { trashed: false } }, null)
    if (folder === 'archived') return set({ label: 'To inbox', flags: { archived: false } }, { label: 'Delete', flags: { trashed: true } })
    return set({ label: 'Archive', flags: { archived: true } }, { label: 'Delete', flags: { trashed: true } })
  }, [folder])

  const onRowTouchStart = useCallback((id: string, threadId: string | null, event: React.TouchEvent<HTMLButtonElement>) => {
    if (event.touches.length !== 1) return
    const row = event.currentTarget
    swipeRef.current = {
      id,
      threadId,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      dx: 0,
      axis: '',
      moved: false,
      top: row.offsetTop,
      height: row.offsetHeight,
    }
  }, [])

  const onRowTouchMove = useCallback((event: React.TouchEvent) => {
    const gesture = swipeRef.current
    if (!gesture) return
    const dx = event.touches[0].clientX - gesture.x
    const dy = event.touches[0].clientY - gesture.y
    if (!gesture.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      // Whichever way it went first owns the gesture; otherwise a scroll drags rows sideways.
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    }
    if (gesture.axis !== 'x') return
    event.stopPropagation()
    gesture.moved = true
    const allowed = dx > 0 ? swipeActions.right : swipeActions.left
    gesture.dx = allowed ? Math.max(-160, Math.min(160, dx)) : 0
    setSwipe({ id: gesture.id, dx: gesture.dx, top: gesture.top, height: gesture.height })
  }, [swipeActions])

  const onRowTouchEnd = useCallback(() => {
    const gesture = swipeRef.current
    // Cleared first, so the touchcancel that can follow a touchend is a no-op.
    swipeRef.current = null
    setSwipe(null)
    if (!gesture || gesture.axis !== 'x') return
    const action = gesture.dx > 0 ? swipeActions.right : swipeActions.left
    // Deliberately not inside the state updater: React calls those twice in development
    // to check they are pure, and the archive went out twice because of it.
    if (action && Math.abs(gesture.dx) >= SWIPE_COMMIT) {
      swipeCommitRef.current(gesture.id, gesture.threadId, action.flags)
    }
  }, [swipeActions])

  /**
   * Pull to refresh. A phone has no hover and the header has room for one small button, so
   * the gesture people already expect is the one worth supporting. The listener is not
   * passive because the pull has to win over the scroll once it starts, and it only ever
   * starts when the list is already at the top.
   */
  const PULL_TRIGGER = 72
  const [pullDistance, setPullDistance] = useState(0)
  useEffect(() => {
    const node = listRef.current
    if (!node) return
    let startY = 0
    let pulling = false

    const start = (event: TouchEvent) => {
      if (node.scrollTop > 0 || event.touches.length !== 1) return
      startY = event.touches[0].clientY
      pulling = true
    }
    const move = (event: TouchEvent) => {
      if (!pulling) return
      const delta = event.touches[0].clientY - startY
      if (delta <= 0) {
        pulling = false
        setPullDistance(0)
        return
      }
      event.preventDefault()
      // Resistance, so the sheet follows the finger without tracking it one to one.
      setPullDistance(Math.min(PULL_TRIGGER * 1.5, delta * 0.45))
    }
    const end = () => {
      if (!pulling) return
      pulling = false
      setPullDistance(current => {
        if (current >= PULL_TRIGGER * 0.75) void refreshAllRef.current()
        return 0
      })
    }

    node.addEventListener('touchstart', start, { passive: true })
    node.addEventListener('touchmove', move, { passive: false })
    node.addEventListener('touchend', end)
    node.addEventListener('touchcancel', end)
    return () => {
      node.removeEventListener('touchstart', start)
      node.removeEventListener('touchmove', move)
      node.removeEventListener('touchend', end)
      node.removeEventListener('touchcancel', end)
    }
  }, [isLoggedIn])

  // Far enough down that the button is wanted, not so far that it appears on a nudge.
  const TO_TOP_AFTER = 400
  const [listScrolled, setListScrolled] = useState(false)
  // Keyed on the sign-in, not on mount: the list does not exist until then, so an effect
  // that ran once on mount attached its listener to nothing and the button never appeared.
  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const check = () => setListScrolled(node.scrollTop > TO_TOP_AFTER)
    check()
    node.addEventListener('scroll', check, { passive: true })
    return () => node.removeEventListener('scroll', check)
  }, [isLoggedIn])

  const scrollListToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Every folder starts at the top, so the button must not linger from the last one.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
    setListScrolled(false)
  }, [folder])

  const loadEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/mail/events', { headers: apiHeaders() })
      if (!response.ok) throw new Error(describeHttp(response.status))
      const data = await response.json().catch(() => null)
      if (!data?.ok) throw new Error(data?.error || 'The mail server sent a response we could not read.')
      setEvents(data.events)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not reach the mail server')
    }
  }, [apiHeaders])

  const refreshAllRef = useRef<() => Promise<void>>(async () => {})

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([loadSent(), refreshInbox(), loadThreads(), loadEvents()])
      lastRefreshAt.current = Date.now()
    } finally {
      setRefreshing(false)
      // Clearing here (not at the call site) guarantees the skeleton always resolves,
      // whichever path kicked off the fetch.
      setMailboxLoading(false)
      setMailboxStale(false)
    }
  }, [loadSent, refreshInbox, loadEvents, loadThreads])
  useEffect(() => { refreshAllRef.current = refreshAll }, [refreshAll])

  const loadAccessors = useCallback(async () => {
    try {
      const response = await fetch('/api/mail/accessors', { headers: apiHeaders() })
      const data = await response.json()
      if (data.ok) {
        setAccessors(data.accessors)
        if (data.domain) setAddressDomain(data.domain)
        if (Array.isArray(data.domains) && data.domains.length) {
          setAddressDomains(data.domains)
          setInviteDomain(current => (current && data.domains.includes(current) ? current : data.domains[0]))
        }
      }
    } catch {}
  }, [apiHeaders])

  const peopleTabOpen = settingsOpen && settingsTab === 'people'
  useEffect(() => {
    if (!peopleTabOpen) return
    setAccessorsMsg('')
    setRenameTarget(null)
    loadAccessors()
  }, [peopleTabOpen, loadAccessors])

  // Populate the admin mailbox picker with every accessor's address.
  useEffect(() => {
    if (isAdmin) loadAccessors()
  }, [isAdmin, loadAccessors])

  const inviteAccessor = useCallback(async () => {
    const target = inviteEmail.trim().toLowerCase()
    if (!target.includes('@')) {
      setAccessorsMsg('Enter a valid email')
      return
    }
    setInviteBusy(true)
    setAccessorsMsg('')
    try {
      const response = await fetch('/api/mail/accessors', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          email: target,
          name: inviteName.trim() || undefined,
          role: inviteRole,
          handle: inviteHandle.trim() || undefined,
          domain: inviteDomain || undefined,
        }),
      })
      const data = await response.json()
      if (data.ok) {
        setAccessorsMsg(`Invite sent to ${data.email} — mailbox ${data.address}.`)
        setInviteEmail('')
        setInviteName('')
        setInviteHandle('')
        setInviteRole('member')
        loadAccessors()
      } else {
        setAccessorsMsg(data.error || 'Could not send the invite')
      }
    } catch {
      setAccessorsMsg('Could not reach the server')
    } finally {
      setInviteBusy(false)
    }
  }, [apiHeaders, inviteEmail, inviteName, inviteRole, inviteHandle, inviteDomain, loadAccessors])

  const saveMailboxName = useCallback(
    async (targetEmail: string) => {
      const handle = renameHandle.trim()
      if (!handle) {
        setRenameTarget(null)
        return
      }
      setAccessorsMsg('')
      try {
        const response = await fetch('/api/mail/accessors', {
          method: 'PATCH',
          headers: apiHeaders(),
          body: JSON.stringify({ email: targetEmail, handle, domain: renameDomain || undefined }),
        })
        const data = await response.json()
        if (data.ok) {
          setRenameTarget(null)
          setRenameHandle('')
          loadAccessors()
        } else {
          setAccessorsMsg(data.error || 'Could not update the mailbox')
        }
      } catch {
        setAccessorsMsg('Could not reach the server')
      }
    },
    [apiHeaders, renameHandle, renameDomain, loadAccessors],
  )

  const removeAccessor = useCallback(
    async (targetEmail: string) => {
      const agreed = await confirm({
        title: 'Remove access?',
        body: <>They will no longer be able to sign in as <strong>{targetEmail}</strong>. Their mail is not deleted.</>,
        confirmLabel: 'Remove access',
        danger: true,
      })
      if (!agreed) return
      try {
        const response = await fetch('/api/mail/accessors', {
          method: 'DELETE',
          headers: apiHeaders(),
          body: JSON.stringify({ email: targetEmail }),
        })
        const data = await response.json()
        if (data.ok) loadAccessors()
        else setAccessorsMsg(data.error || 'Could not remove')
      } catch {
        setAccessorsMsg('Could not reach the server')
      }
    },
    [apiHeaders, loadAccessors],
  )

  const changeAccessorRole = useCallback(
    async (targetEmail: string, role: 'admin' | 'member') => {
      try {
        const response = await fetch('/api/mail/accessors', {
          method: 'PATCH',
          headers: apiHeaders(),
          body: JSON.stringify({ email: targetEmail, role }),
        })
        const data = await response.json()
        if (data.ok) loadAccessors()
        else setAccessorsMsg(data.error || 'Could not update')
      } catch {
        setAccessorsMsg('Could not reach the server')
      }
    },
    [apiHeaders, loadAccessors],
  )

  // Admin-only: reassign a message to a mailbox (fixes historical/mis-sorted attribution).
  const assignOptions = useMemo(
    () => accessors.filter(entry => entry.address).map(entry => ({ value: entry.address!, label: entry.name || entry.email })),
    [accessors],
  )

  useEffect(() => {
    // Don't clear the loading flag here — auth resolves async, so the first pass runs
    // with isLoggedIn false and would kill the skeleton before any fetch starts.
    if (!isLoggedIn) return
    refreshAll()
    // Every tick reads a couple of thousand rows against a monthly quota, and a tab left
    // open on a second screen was spending most of it. Ninety seconds keeps mail feeling
    // live; a hidden tab has no one to keep it live for.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll()
    }, 90000)
    const onWake = () => {
      if (document.visibilityState !== 'visible') return
      void loadCounts()
      if (Date.now() - lastRefreshAt.current < 20000) return
      setMailboxStale(true)
      void refreshAll()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    const onWorkerMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'mail:new') {
        lastRefreshAt.current = 0
        onWake()
      }
    }
    navigator.serviceWorker?.addEventListener('message', onWorkerMessage)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      navigator.serviceWorker?.removeEventListener('message', onWorkerMessage)
    }
  }, [isLoggedIn, refreshAll, loadCounts])

  // Switching mailbox: wipe the view and show skeletons while the new mailbox loads.
  useEffect(() => {
    if (mailboxFirstRun.current) {
      mailboxFirstRun.current = false
      return
    }
    setMailboxLoading(true)
    setMailboxStale(false)
    cancelThreadOpen()
    setSelectedId(null)
    setReaderOpenMobile(false)
    setSelectedBulk(new Set())
    setInboxEmails([])
    setSentEmails([])
    setThreads([])
    setThreadsCursor(null)
    threadsLoadedFolder.current = null
    setThreadsResolved(false)
    refreshAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailbox])

  useEffect(() => {
    if (!isLoggedIn) return
    const headers = apiHeaders()
    fetchStash('draft', headers).then(items =>
      setDrafts(items.map(item => ({ id: item.id, savedAt: item.updatedAt, data: item.data as ComposeData }))),
    )
    fetch('/api/mail/settings', { headers })
      .then(response => response.json())
      .then(data => {
        if (data.ok && data.settings) {
          const stored = data.settings as MailSettings & { density?: string }
          // Only the roomy setting is named; anything else — unset, or the retired
          // "comfortable" — is the default. Treating every unrecognised value as roomy put
          // six of the seven mailboxes into a reduced reader none of them had asked for.
          const density: MailSettings['density'] = stored.density === 'relaxed' ? 'relaxed' : 'compact'
          setMailSettings(current => ({ ...current, ...data.settings, density }))
          const prefs = (data.settings as MailSettings).prefs
          if (prefs?.theme) { setThemePref(prefs.theme); localStorage.setItem(LS_THEME_KEY, prefs.theme) }
          if (prefs?.accent && hexToHsl(prefs.accent)) { setAccent(prefs.accent); localStorage.setItem(LS_ACCENT_KEY, prefs.accent) }
          if (prefs?.themeCustom) { setThemeCustom(prefs.themeCustom); localStorage.setItem(LS_THEME_CUSTOM_KEY, JSON.stringify(prefs.themeCustom)) }
          if (prefs?.layout) { setReaderLayout(prefs.layout); localStorage.setItem(LS_LAYOUT_KEY, prefs.layout) }
        }
        setPrefsLoaded(true)
      })
      .catch(() => {})
    fetch('/api/mail/company-signature', { headers })
      .then(response => response.json())
      .then(data => {
        if (data.ok && typeof data.signature === 'string') setCompanySignature(data.signature)
        if (data.ok && typeof data.logo === 'string') setCompanyLogo(data.logo)
      })
      .catch(() => {})
    fetch('/api/mail/me', { headers })
      .then(response => response.json())
      .then(data => {
        if (data.ok) setAccount({ email: data.email, address: data.address ?? null, name: data.name ?? null, role: data.role, defaultPassword: Boolean(data.defaultPassword) })
      })
      .catch(() => {})
  }, [isLoggedIn, apiHeaders])

  const scheduledEmails = useMemo(
    () =>
      sentEmails
        .filter(entry => entry.lastEvent === 'scheduled' || (entry.scheduledAt && new Date(entry.scheduledAt).getTime() > now))
        .sort((a, b) => new Date(a.scheduledAt ?? a.createdAt).getTime() - new Date(b.scheduledAt ?? b.createdAt).getTime()),
    [sentEmails, now],
  )
  const deliveredEmails = useMemo(
    () => sentEmails.filter(entry => !scheduledEmails.some(scheduled => scheduled.id === entry.id)),
    [sentEmails, scheduledEmails],
  )

  // Must match the list's own visibility rules, or hidden mail (forwards, which the inbox
  // filters out) leaves an unread badge the user has no way to clear.
  const threadKeys = useMemo(() => computeThreadKeys(inboxEmails), [inboxEmails])

  // Rows are conversations, so a page of messages is not a page of rows: one thread of
  // forty replies is a single line. Fifty messages can leave seven rows and a screen that
  // looks broken and never reaches the bottom, so nothing else pulls the next page in.
  // Enough rows to reach the fold is the goal — each extra page is another round trip to
  // another continent, and filling the list generously costs more than it is worth.
  const autoPages = useRef(0)
  useEffect(() => {
    if (!inboxCursor) return
    const rows = new Set(threadKeys.values()).size
    if (threads.length > 0 || rows >= 12 || autoPages.current >= 1) return
    autoPages.current += 1
    void loadMoreRef.current()
  }, [inboxCursor, threadKeys, threads.length])

  useEffect(() => {
    autoPages.current = 0
  }, [search, mailboxQuery])

  // Server figure when there is one: counting loaded rows undercounts a mailbox this size,
  // and counted unread messages against grouped conversations, which is how an unread
  // badge came to read higher than the folder total beside it.
  // The sidebar counts mail, the list header counts conversations. They answer different
  // questions — how much is in the folder, and how many rows that comes to — so they are
  // deliberately different numbers rather than one of them being wrong.
  const unreadCount = serverCounts?.unread ?? 0

  // Without a search the list total is the folder's own count, which the sidebar has
  // already fetched; asking the list query to count the same rows again is wasted work.
  useEffect(() => {
    if (search.trim() || !serverCounts) return
    const total = threadFolder === 'archive'
      ? serverCounts.archived
      : threadFolder === 'trash'
        ? serverCounts.trashed
        : threadFolder === 'starred'
          ? serverCounts.starred
          : threadFolder === 'snoozed'
            ? serverCounts.snoozed
            : serverCounts.inbox
    setInboxTotal(total)
  }, [serverCounts, search, threadFolder])

  const folderCounts = useMemo(
    () => ({
      inbox: serverCounts?.inbox ?? 0,
      starred: serverCounts?.starred ?? 0,
      archived: serverCounts?.archived ?? 0,
      trashed: serverCounts?.trashed ?? 0,
      snoozed: serverCounts?.snoozed ?? 0,
    }),
    [serverCounts],
  )

  /**
   * What the folder holds, not what has been fetched. The header counted loaded rows, so a
   * mailbox of 14,974 conversations opened on "500 conversations" — the thread page size
   * showing through — and climbed as you scrolled. A search has no such total: the rows
   * are the result.
   */
  const folderConversationTotal = useMemo(() => {
    const tally = serverCounts?.conversations
    if (!tally || search.trim()) return null
    if (folder === 'archived') return tally.archived
    if (folder === 'trash') return tally.trashed
    if (folder === 'starred') return tally.starred
    if (folder === 'snoozed') return tally.snoozed
    if (folder === 'inbox') return tally.inbox
    return null
  }, [serverCounts, search, folder])

  const eventsByEmail = useMemo(() => {
    const map: Record<string, MailEvent[]> = {}
    for (const event of events) {
      if (!event.emailId) continue
      map[event.emailId] = map[event.emailId] ?? []
      map[event.emailId].push(event)
    }
    return map
  }, [events])

  const statusFor = useCallback(
    (entry: SentEmail): string => {
      const tracked = eventsByEmail[entry.id] ?? []
      const has = (type: string) => tracked.filter(event => event.type === `email.${type}`)
      if (has('complained').length) return 'complained'
      if (has('bounced').length) return 'bounced'
      if (has('failed').length) return 'failed'
      const clicks = has('clicked').length
      if (clicks) return clicks > 1 ? `clicked ×${clicks}` : 'clicked'
      const opens = has('opened').length
      if (opens) return opens > 1 ? `opened ×${opens}` : 'opened'
      if (has('delivered').length) return 'delivered'
      if (has('delivery_delayed').length) return 'delayed'
      return entry.lastEvent || 'sent'
    },
    [eventsByEmail],
  )

  const searchQuery = useMemo(() => parseQuery(search), [search])

  const matchesInbound = useCallback(
    (entry: InboundEmail) => {
      if (searchQuery.isEmpty) return true
      return matchesQuery(searchQuery, {
        from: entry.from,
        to: entry.to.join(' '),
        cc: (entry.cc ?? []).join(' '),
        bcc: (entry.bcc ?? []).join(' '),
        subject: entry.subject,
        body: entry.text ?? '',
        filenames: entry.attachments.map(file => file.filename).join(' '),
        date: new Date(entry.receivedAt).getTime(),
        size: null,
        read: entry.read,
        starred: entry.starred,
        hasAttachment: entry.attachments.length > 0,
        labels: entry.labels,
        folder: entry.trashed ? 'trash' : entry.archived ? 'archive' : 'inbox',
      })
    },
    [searchQuery],
  )

  const matchesSent = useCallback(
    (entry: SentEmail) => {
      if (searchQuery.isEmpty) return true
      return matchesQuery(searchQuery, {
        from: entry.from,
        to: entry.to.join(' '),
        cc: (entry.cc ?? []).join(' '),
        bcc: (entry.bcc ?? []).join(' '),
        subject: entry.subject,
        body: entry.searchText ?? '',
        filenames: '',
        date: new Date(entry.createdAt).getTime(),
        size: null,
        read: true,
        starred: entry.starred,
        hasAttachment: false,
        labels: [],
        folder: entry.trashed ? 'trash' : entry.archived ? 'archive' : 'sent',
      })
    },
    [searchQuery],
  )

  const matches = useCallback(
    (haystack: string) =>
      searchQuery.isEmpty ||
      matchesQuery(searchQuery, {
        from: haystack, to: haystack, cc: '', bcc: '', subject: haystack, body: haystack,
        filenames: '', date: Date.now(), size: null, read: true, starred: false,
        hasAttachment: false, labels: [], folder: '',
      }),
    [searchQuery],
  )

  // Autocomplete drawn from every message on the platform — inbox, sent and drafts.
  const searchSuggestions = useMemo(() => {
    const people = new Map<string, string>()
    const subjects = new Set<string>()
    const addPerson = (raw: string) => {
      const address = parseAddress(raw)
      if (address && address.includes('@')) people.set(address.toLowerCase(), raw.trim())
    }
    for (const entry of inboxEmails) {
      addPerson(entry.from)
      entry.to.forEach(addPerson)
      entry.cc.forEach(addPerson)
      if (entry.subject) subjects.add(normalizeSubject(entry.subject) ? entry.subject.trim() : entry.subject)
    }
    for (const entry of sentEmails) {
      entry.to.forEach(addPerson)
      if (entry.subject) subjects.add(entry.subject.trim())
    }
    for (const entry of drafts) {
      entry.data.to.forEach(addPerson)
      if (entry.data.subject) subjects.add(entry.data.subject.trim())
    }

    const raw = search
    const activeToken = raw.slice(raw.lastIndexOf(' ') + 1)
    const before = raw.slice(0, raw.lastIndexOf(' ') + 1)
    const lower = activeToken.toLowerCase()
    type Suggestion = { label: string; hint: string; apply: string }
    const out: Suggestion[] = []
    const push = (item: Suggestion) => {
      if (out.length < 8 && !out.some(existing => existing.apply === item.apply)) out.push(item)
    }

    const fieldMatch = lower.match(/^(from|to|label):(.*)$/)
    if (fieldMatch) {
      const [, field, partial] = fieldMatch
      if (field === 'label') {
        for (const label of LABELS) {
          if (label.id.includes(partial)) push({ label: `label:${label.id}`, hint: label.name, apply: `${before}label:${label.id} ` })
        }
      } else {
        for (const [address, display] of people) {
          if (!partial || address.includes(partial)) push({ label: `${field}:${address}`, hint: display === address ? 'contact' : display, apply: `${before}${field}:${address} ` })
        }
      }
      return out
    }

    const OPERATORS: Suggestion[] = [
      { label: 'is:unread', hint: 'only unread', apply: `${before}is:unread ` },
      { label: 'is:starred', hint: 'only starred', apply: `${before}is:starred ` },
      { label: 'has:attachment', hint: 'with files', apply: `${before}has:attachment ` },
      { label: 'from:', hint: 'sender', apply: `${before}from:` },
      { label: 'to:', hint: 'recipient', apply: `${before}to:` },
    ]
    for (const operator of OPERATORS) {
      if (!lower || operator.label.startsWith(lower)) push(operator)
    }
    if (lower.length >= 2) {
      for (const [address, display] of people) {
        if (address.includes(lower)) push({ label: address, hint: display === address ? 'contact' : display, apply: `${before}from:${address} ` })
      }
      for (const subject of subjects) {
        if (subject.toLowerCase().includes(lower)) push({ label: subject.slice(0, 60), hint: 'subject', apply: `${before}${subject} ` })
      }
    }
    return out
  }, [search, inboxEmails, sentEmails, drafts])

  const inboxFolderPredicate = useCallback(
    (entry: InboundEmail) => {
      const asleep = Boolean(entry.snoozedUntil && Date.parse(entry.snoozedUntil) > Date.now())
      if (folder === 'snoozed') return asleep && !entry.trashed
      if (folder === 'starred') return entry.starred && !entry.trashed
      if (folder === 'archived') return entry.archived && !entry.trashed
      if (folder === 'trash') return entry.trashed
      return !entry.archived && !entry.trashed && !asleep
    },
    [folder],
  )

  const threadMembers = useCallback(
    (id: string): InboundEmail[] => {
      const key = threadKeys.get(id)
      if (!key) return inboxEmails.filter(entry => entry.id === id)
      return inboxEmails
        .filter(entry => threadKeys.get(entry.id) === key)
        .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime())
    },
    [inboxEmails, threadKeys],
  )

  // An action on a thread applies to every message in it, not just the representative.
  const threadIds = useCallback((id: string): string[] => threadMembers(id).map(member => member.id), [threadMembers])
  useEffect(() => { threadIdsRef.current = threadIds }, [threadIds])

  // Sent replies that belong to an inbound thread: matched by the recorded In-Reply-To
  // Message-ID, falling back to normalized subject for historical sends with no linkage.
  const threadSentMembers = useCallback(
    (inboundId: string): SentEmail[] => {
      const members = threadMembers(inboundId)
      if (!members.length) return []
      const messageIds = new Set<string>()
      const subjects = new Set<string>()
      for (const member of members) {
        for (const token of messageTokens(member)) messageIds.add(token)
        const own = headerValue(member, 'message-id').replace(/[<>]/g, '').trim()
        if (own) messageIds.add(own)
        subjects.add(normalizeSubject(member.subject))
      }
      return sentEmails.filter(sent => {
        if (sent.trashed) return false
        const inReplyTo = (sent.inReplyTo ?? '').replace(/[<>]/g, '').trim()
        if (inReplyTo && messageIds.has(inReplyTo)) return true
        return subjects.has(normalizeSubject(sent.subject))
      })
    },
    [threadMembers, sentEmails],
  )

  // Merge inbound + our sent replies into one date-sorted conversation.
  const unifiedThread = useCallback(
    (inboundId: string): ThreadItem[] => {
      const items: ThreadItem[] = [
        ...threadMembers(inboundId).map(entry => ({ kind: 'inbound' as const, id: entry.id, date: entry.receivedAt, inbound: entry })),
        ...threadSentMembers(inboundId).map(entry => ({ kind: 'sent' as const, id: entry.id, date: entry.createdAt, sent: entry })),
      ]
      return items.sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
    },
    [threadMembers, threadSentMembers],
  )

  // Pull bodies for our own replies that are the newest message in a visible thread, so the
  // list preview can show the actual text instead of falling back to the subject.
  useEffect(() => {
    if (!inboxEmails.length) return
    const wanted: string[] = []
    for (const entry of inboxEmails) {
      const own = threadSentMembers(entry.id)
      if (!own.length) continue
      const newestOwn = own.reduce((newest, item) => (new Date(item.createdAt) > new Date(newest.createdAt) ? item : newest))
      if (new Date(newestOwn.createdAt).getTime() <= new Date(entry.receivedAt).getTime()) continue
      if (!detailCache[newestOwn.id] && !wanted.includes(newestOwn.id)) wanted.push(newestOwn.id)
    }
    for (const id of wanted.slice(0, 15)) {
      fetch(`/api/mail/emails/${id}`, { headers: apiHeaders() })
        .then(response => response.json())
        .then(data => {
          if (data.ok) setDetailCache(cache => (cache[data.email.id] ? cache : { ...cache, [data.email.id]: data.email }))
        })
        .catch(() => {})
    }
  }, [inboxEmails, threadSentMembers, detailCache, apiHeaders])

  // Scan every link in the open conversation once it's selected.
  useEffect(() => {
    if (!selectedId) return
    const inbound = inboxEmails.find(entry => entry.id === selectedId)
    if (!inbound) return
    const urls = threadMembers(inbound.id).flatMap(member =>
      extractUrls(`${member.text ?? ''} ${htmlToQuoteText(member.html, null)}`),
    )
    if (urls.length) scanLinksRef.current(Array.from(new Set(urls)))
  }, [selectedId, inboxEmails, threadMembers])

  /** The folders backed by the paged inbound list, as opposed to ones loaded whole. */
  const isInboundFolder =
    folder === 'inbox' || folder === 'starred' || folder === 'snoozed' || folder === 'archived' || folder === 'trash'

  const listItems = useMemo(() => {
    const sentToItem = (entry: SentEmail) => ({
      id: entry.id,
      kind: 'sent' as const,
      primary: `To: ${entry.to.join(', ')}`,
      subject: entry.subject,
      snippet: '',
      time:
        folder === 'scheduled' && entry.scheduledAt
          ? `in ${formatCountdown(new Date(entry.scheduledAt).getTime() - now)}`
          : formatRelative(entry.createdAt, now),
      unread: false,
      starred: entry.starred,
      hasAttachment: false,
      chip: (folder === 'scheduled' ? 'scheduled' : statusFor(entry)) as string | null,
      threadCount: 1,
      latestAt: new Date(entry.createdAt).getTime(),
      labels: [] as string[],
    })
    if (isInboundFolder) {
      const visible = inboxEmails
        .filter(inboxFolderPredicate)
        .filter(matchesInbound)
        .filter(entry => !(folder === 'inbox' && hideForwarded && isAppNotification(entry.subject)))
      const groups = new Map<string, InboundEmail[]>()
      for (const entry of visible) {
        const key = threadKeys.get(entry.id) ?? entry.id
        const list = groups.get(key)
        if (list) list.push(entry)
        else groups.set(key, [entry])
      }
      const inThreadFolder = (thread: ConversationRow) => {
        const asleep = Boolean(thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now())
        if (folder === 'snoozed') return asleep
        if (folder === 'archived') return thread.archivedCount > 0
        if (folder === 'trash') return thread.trashedCount > 0
        if (folder === 'starred') return thread.starredCount > 0
        return thread.inboxCount > 0 && !asleep
      }
      const threadItems = threads.length > 0 && !search.trim()
        ? threads
            .filter(inThreadFolder)
            .filter(thread => !(folder === 'inbox' && hideForwarded && isAppNotification(thread.subject)))
            .map(thread => {
              const senders = Array.from(new Set(thread.senders.map(sender => parseAddress(sender).split('@')[0] || sender)))
              return {
                id: thread.latestId ?? thread.threadId,
                threadId: thread.threadId as string | null,
                kind: 'inbound' as const,
                primary: senders.length > 1 ? `${senders.slice(0, 2).join(', ')}${senders.length > 2 ? ` +${senders.length - 2}` : ''}` : (thread.senders[0] ?? ''),
                subject: thread.subject,
                snippet: thread.snippet.slice(0, 120),
                time: formatRelative(thread.latestAt, now),
                unread: thread.unreadCount > 0,
                starred: thread.starredCount > 0,
                hasAttachment: thread.attachCount > 0,
                chip: null as string | null,
                threadCount: thread.count,
                latestAt: new Date(thread.latestAt).getTime(),
                labels: thread.labels,
              }
            })
        : null
      const inboundItems = threadItems ?? [...groups.values()].map(members => {
        const sorted = [...members].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
        const latest = sorted[0]
        const senders = Array.from(new Set(members.map(member => parseAddress(member.from).split('@')[0] || member.from)))
        // The preview reflects the newest message in the conversation — including our own
        // replies, which are stored separately from the inbound thread.
        const ownReplies = threadSentMembers(latest.id)
        const newestOwn = ownReplies.length
          ? ownReplies.reduce((newest, entry) => (new Date(entry.createdAt) > new Date(newest.createdAt) ? entry : newest))
          : null
        const ownIsNewest = Boolean(newestOwn && new Date(newestOwn.createdAt).getTime() > new Date(latest.receivedAt).getTime())
        const ownDetail = newestOwn ? detailCache[newestOwn.id] : null
        const ownSnippet = ownDetail ? htmlToSnippetText(ownDetail.html, ownDetail.text) : newestOwn?.subject ?? ''
        return {
          id: latest.id,
          threadId: null as string | null,
          kind: 'inbound' as const,
          primary: senders.length > 1 ? `${senders.slice(0, 2).join(', ')}${senders.length > 2 ? ` +${senders.length - 2}` : ''}` : latest.from,
          subject: latest.subject,
          snippet: ownIsNewest
            ? `You: ${ownSnippet}`.slice(0, 120)
            : htmlToSnippetText(latest.html, latest.text).slice(0, 120),
          time: ownIsNewest && newestOwn ? formatRelative(newestOwn.createdAt, now) : formatRelative(latest.receivedAt, now),
          unread: members.some(member => !member.read),
          starred: members.some(member => member.starred),
          hasAttachment: members.some(member => member.attachments.length > 0),
          chip: null as string | null,
          threadCount: members.length,
          latestAt: new Date(latest.receivedAt).getTime(),
          labels: Array.from(new Set(members.flatMap(member => member.labels))),
        }
      })
      const sentInFolder =
        folder === 'starred'
          ? deliveredEmails.filter(entry => entry.starred && !entry.trashed)
          : folder === 'archived'
            ? deliveredEmails.filter(entry => entry.archived && !entry.trashed)
            : folder === 'trash'
              ? deliveredEmails.filter(entry => entry.trashed)
              : []
      const sentItems = sentInFolder
        .filter(matchesSent)
        .map(entry => sentToItem(entry))
      return [...inboundItems, ...sentItems].sort((a, b) => b.latestAt - a.latestAt)
    }
    if (folder === 'drafts') {
      return drafts
        .filter(entry => matches(`${entry.data.subject} ${entry.data.to.join(' ')} ${entry.data.markdown}`))
        .map(entry => ({
          id: entry.id,
          kind: 'draft' as const,
          primary: entry.data.to.join(', ') || '(no recipients)',
          subject: entry.data.subject || '(no subject)',
          snippet: entry.data.markdown.slice(0, 120),
          time: formatRelative(entry.savedAt, now),
          unread: false,
          starred: false,
          hasAttachment: false,
          chip: 'draft' as string | null,
          threadCount: 1,
          latestAt: 0,
          labels: [] as string[],
        }))
    }
    const source = folder === 'scheduled' ? scheduledEmails : deliveredEmails
    return source
      .filter(entry => matches(`${entry.to.join(' ')} ${entry.subject}`))
      .filter(entry => !(folder === 'sent' && hideForwarded && isForwarded(entry.subject)))
      .filter(entry => !(folder === 'sent' && (entry.archived || entry.trashed)))
      .map(entry => sentToItem(entry))
  }, [folder, isInboundFolder, inboxEmails, drafts, scheduledEmails, deliveredEmails, matches, matchesInbound, matchesSent, inboxFolderPredicate, threadKeys, statusFor, now, hideForwarded, threadSentMembers, detailCache, threads, search])

  const listSettling = searching || ((mailboxLoading || !threadsResolved) && listItems.length === 0)
  const listRefreshing = !listSettling && (mailboxStale || mailboxLoading || !threadsResolved)

  const inboxFolder = isInboundFolder

  // Sent, drafts and scheduled really are lists of messages, so only the threaded folders
  // count in conversations. Where the folder total is known and the list has not reached
  // it, say both figures rather than let one grow silently towards the other.
  const loadedRows = listItems.length
  const listCountPaging = folderConversationTotal != null && loadedRows < folderConversationTotal
  const listCountFigure = listCountPaging
    ? `${loadedRows.toLocaleString()} of ${folderConversationTotal!.toLocaleString()}`
    : (folderConversationTotal ?? loadedRows).toLocaleString()
  const listCountUnit = !isInboundFolder
    ? loadedRows === 1 ? 'message' : 'messages'
    : listCountPaging
      ? 'conversations loaded'
      : (folderConversationTotal ?? loadedRows) === 1 ? 'conversation' : 'conversations'
  const listCountTitle = `${listCountFigure} ${listCountUnit}`

  const selectedInbound = selectedId ? inboxEmails.find(entry => entry.id === selectedId) ?? null : null
  const selectedSent = selectedId && !selectedInbound ? sentEmails.find(entry => entry.id === selectedId) ?? null : null
  const selectedDetail = selectedSent ? detailCache[selectedSent.id] ?? null : null
  const selectedIsThread = selectedInbound ? unifiedThread(selectedInbound.id).length > 1 : false

  useEffect(() => {
    setShowRemote(settings.showRemoteImages)
    setShowFullHeaders(false)
    setReaderMode('preview')
    setLabelMenuOpen(false)
  }, [selectedId, settings.showRemoteImages])

  // Auto-open the newest message in the conversation — which may be one of our own replies,
  // so it's the last item of the unified thread rather than the latest inbound.
  const autoOpenId = useMemo(() => {
    if (!selectedId) return null
    const items = unifiedThread(selectedId)
    return items[items.length - 1]?.id ?? selectedId
  }, [selectedId, unifiedThread])

  useEffect(() => {
    setThreadExpanded(autoOpenId ? new Set([autoOpenId]) : new Set())
  }, [autoOpenId])

  useEffect(() => {
    setAttachBar('open')
  }, [selectedId])

  // Reserve exactly as much room as the floating strip occupies, so the end of the message
  // stays reachable instead of sitting underneath it.
  useEffect(() => {
    const node = attachBarRef.current
    if (!node) {
      setAttachBarHeight(0)
      return
    }
    const measure = () => setAttachBarHeight(node.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [attachBar, selectedId, readerMode])

  useEffect(() => {
    setSelectedBulk(new Set())
  }, [folder])

  useEffect(() => {
    const node = actingBarRef.current
    if (!node) {
      setActingBarHeight(0)
      return
    }
    const measure = () => setActingBarHeight(node.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [actingAs])

  useEffect(() => {
    if (!selectedSent || detailCache[selectedSent.id]) return
    fetch(`/api/mail/emails/${selectedSent.id}`, { headers: apiHeaders() })
      .then(response => response.json())
      .then(data => {
        if (data.ok) setDetailCache(cache => ({ ...cache, [data.email.id]: data.email }))
      })
      .catch(() => {})
  }, [selectedSent, detailCache, apiHeaders])

  // Pull bodies for the sent replies inside the selected conversation, so they render inline.
  useEffect(() => {
    if (!selectedInbound) return
    const headers = apiHeaders()
    for (const sent of threadSentMembers(selectedInbound.id)) {
      if (detailCache[sent.id]) continue
      fetch(`/api/mail/emails/${sent.id}`, { headers })
        .then(response => response.json())
        .then(data => {
          if (data.ok) setDetailCache(cache => ({ ...cache, [data.email.id]: data.email }))
        })
        .catch(() => {})
    }
  }, [selectedInbound, threadSentMembers, detailCache, apiHeaders])

  // Imported archives keep HTML out of the database (in the bucket, or in the primary row of a
  // shared copy). The plain-text body shows at once; the HTML is fetched when the message opens.
  const bodyRequests = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!selectedInbound) return
    for (const member of threadMembers(selectedInbound.id)) {
      if (member.html !== null || bodyRequests.current.has(member.id)) continue
      bodyRequests.current.add(member.id)
      fetch(`/api/mail/inbox/body?id=${encodeURIComponent(member.id)}`, { headers: apiHeaders() })
        .then(response => response.json())
        .then(data => {
          if (!data.ok) return
          setInboxEmails(list =>
            list.map(entry =>
              entry.id === member.id
                ? { ...entry, html: data.html ?? entry.html, text: data.text ?? entry.text }
                : entry,
            ),
          )
        })
        .catch(() => bodyRequests.current.delete(member.id))
    }
  }, [selectedInbound, threadMembers, apiHeaders])

  useEffect(() => {
    if (!selectedInbound) return
    const members = threadMembers(selectedInbound.id)
    for (const member of members) {
      if (!member.attachments.length || inboundAttachments[member.id]) continue
      fetch(`/api/mail/inbox/attachments?id=${encodeURIComponent(member.id)}`, { headers: apiHeaders() })
        .then(response => response.json())
        .then(data => {
          if (data.ok) setInboundAttachments(cache => ({ ...cache, [member.id]: data.attachments }))
        })
        .catch(() => {})
    }
  }, [selectedInbound, threadMembers, inboundAttachments, apiHeaders])

  /**
   * Every selection bumps this. A conversation fetch that finishes after a later selection
   * finds the number moved on and does nothing — otherwise clicking B while A was still
   * loading showed A's skeleton over B and then replaced B with A when A arrived.
   */
  const openSeq = useRef(0)
  const openController = useRef<AbortController | null>(null)
  const cancelThreadOpen = () => {
    openSeq.current += 1
    openController.current?.abort()
    openController.current = null
    setThreadOpening(null)
  }

  // Failing to open is worth a word. It used to go through loadError, which only renders
  // when the list itself is empty, so on a phone the pane slid in and out and said nothing.
  const [openError, setOpenError] = useState<string | null>(null)
  useEffect(() => {
    if (!openError) return
    const timer = window.setTimeout(() => setOpenError(null), 4500)
    return () => window.clearTimeout(timer)
  }, [openError])

  const openThread = async (threadId: string, latestId: string) => {
    if (!inboxEmails.some(entry => entry.id === latestId)) {
      const seq = ++openSeq.current
      // Whatever the phone showed before the tap is what a failed open goes back to: the
      // list if they were on the list, the message if one was open. selectedId is the
      // wrong proxy for that, because Back on a phone hides the pane and leaves it set.
      // A pane still sliding in for an earlier tap does not count as open.
      const wasOpen = readerOpenMobile && !threadOpening
      setThreadOpening(threadId)
      setReaderOpenMobile(true)
      const controller = new AbortController()
      openController.current = controller
      const giveUp = window.setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`/api/mail/inbox?thread=${encodeURIComponent(threadId)}&limit=200`, {
          headers: apiHeaders(),
          signal: controller.signal,
        })
        const data = await response.json().catch(() => null)
        if (seq !== openSeq.current) return
        if (data?.ok && Array.isArray(data.emails)) {
          const fresh = data.emails as InboundEmail[]
          setInboxEmails(current => {
            const seen = new Set(current.map(entry => entry.id))
            return [...current, ...fresh.filter(entry => !seen.has(entry.id))]
          })
        } else {
          setThreadOpening(null)
          setReaderOpenMobile(wasOpen)
          setOpenError('Could not open that conversation')
          return
        }
      } catch (err) {
        if (seq !== openSeq.current) return
        console.warn('[mail] thread load failed', err)
        setThreadOpening(null)
        setReaderOpenMobile(wasOpen)
        setOpenError('Could not open that conversation')
        return
      } finally {
        window.clearTimeout(giveUp)
        if (openController.current === controller) openController.current = null
      }
      setThreadOpening(null)
    }
    openInbound(latestId)
  }

  const openInbound = (id: string) => {
    cancelThreadOpen()
    // Reading and writing share the same panel, so the composer has to give it up.
    // Closed through closeCompose rather than just hidden, so the draft is kept.
    if (composeOpen) closeCompose()
    setSelectedId(id)
    setReaderOpenMobile(true)
    const unreadIds = threadMembers(id).filter(member => !member.read).map(member => member.id)
    if (unreadIds.length) {
      setInboundFlag(unreadIds, { read: true })
    }
  }

  type InboundFlagPatch = Partial<Pick<InboundEmail, 'read' | 'starred' | 'archived' | 'trashed'>>
  const setInboundFlagRef = useRef<(ids: string[], flags: InboundFlagPatch) => void>(() => {})
  const threadIdsRef = useRef<(id: string) => string[]>(id => [id])

  const setInboundFlag = useCallback(
    (ids: string[], flags: Partial<Pick<InboundEmail, 'read' | 'starred' | 'archived' | 'trashed'>>) => {
      if (flags.read === true) ids.forEach(id => pendingRead.current.add(id))
      // Adjust the badge here rather than re-counting: a full count reads the whole
      // mailbox, and the figure has to move the moment a message is opened.
      setInboxEmails(list => {
        if (flags.read !== undefined) {
          const changed = list.filter(
            entry => ids.includes(entry.id) && entry.read !== flags.read && !entry.archived && !entry.trashed,
          ).length
          if (changed) {
            setServerCounts(current =>
              current
                ? { ...current, unread: Math.max(0, current.unread + (flags.read ? -changed : changed)) }
                : current,
            )
          }
        }
        setThreads(rows => applyThreadFlagDeltas(rows, list, ids, flags))
        return list.map(entry => (ids.includes(entry.id) ? { ...entry, ...flags } : entry))
      })
      fetch('/api/mail/inbox', {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ ids, ...flags }),
      })
        .catch(() => {})
        .finally(() => {
          if (flags.read === true) ids.forEach(id => pendingRead.current.delete(id))
        })
    },
    [apiHeaders],
  )

  /**
   * A row stands for a conversation, and the messages under it may not be loaded, so the
   * id the row carries is often not enough to act on. Naming the thread lets the server
   * find its messages; a row with no thread falls back to the ids we do hold.
   */
  const commitRowFlags = useCallback(
    (id: string, threadId: string | null, flags: Partial<Pick<InboundEmail, 'archived' | 'trashed'>>) => {
      if (!threadId) {
        setInboundFlag(threadIds(id), flags)
        return
      }
      setInboxEmails(list =>
        list.map(entry => (threadKeys.get(entry.id) === threadKeys.get(id) ? { ...entry, ...flags } : entry)),
      )
      setThreads(list =>
        list.filter(thread => {
          if (thread.threadId !== threadId) return true
          // The row leaves the folder it was swiped out of; the next refresh restates it.
          return false
        }),
      )
      fetch('/api/mail/inbox', {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ threadId, ...flags }),
      })
        .then(() => loadCounts(true))
        .catch(() => {})
    },
    [apiHeaders, setInboundFlag, threadIds, threadKeys, loadCounts],
  )
  useEffect(() => { swipeCommitRef.current = commitRowFlags }, [commitRowFlags])
  useEffect(() => { setInboundFlagRef.current = setInboundFlag }, [setInboundFlag])

  const setSentFlag = useCallback(
    (ids: string[], flags: Partial<Pick<SentEmail, 'starred' | 'archived' | 'trashed'>>) => {
      setSentEmails(list => list.map(entry => (ids.includes(entry.id) ? { ...entry, ...flags } : entry)))
      fetch('/api/mail/emails', {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ ids, ...flags }),
      }).catch(() => {})
    },
    [apiHeaders],
  )

  const toggleLabel = useCallback(
    (id: string, labelId: string) => {
      setInboxEmails(list =>
        list.map(entry => {
          if (entry.id !== id) return entry
          const labels = entry.labels.includes(labelId)
            ? entry.labels.filter(label => label !== labelId)
            : [...entry.labels, labelId]
          fetch('/api/mail/inbox', {
            method: 'PATCH',
            headers: apiHeaders(),
            body: JSON.stringify({ id, labels }),
          }).catch(() => {})
          return { ...entry, labels }
        }),
      )
    },
    [apiHeaders],
  )

  const toggleBulk = useCallback((id: string) => {
    setSelectedBulk(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // One selection can hold inbound and sent items (e.g. Archive/Trash/Starred),
  // so route each selected id to the right store and expand threads.
  const bulkFlag = useCallback(
    (flags: { read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean }) => {
      const ids = Array.from(selectedBulk)
      const inboundIds: string[] = []
      const sentIds: string[] = []
      for (const id of ids) {
        if (inboxEmails.some(entry => entry.id === id)) inboundIds.push(...threadIds(id))
        else if (sentEmails.some(entry => entry.id === id)) sentIds.push(id)
      }
      if (inboundIds.length) setInboundFlag(Array.from(new Set(inboundIds)), flags)
      if (sentIds.length) {
        const sentFlags: { starred?: boolean; archived?: boolean; trashed?: boolean } = {}
        if (flags.starred !== undefined) sentFlags.starred = flags.starred
        if (flags.archived !== undefined) sentFlags.archived = flags.archived
        if (flags.trashed !== undefined) sentFlags.trashed = flags.trashed
        if (Object.keys(sentFlags).length) setSentFlag(sentIds, sentFlags)
      }
      setSelectedBulk(new Set())
    },
    [selectedBulk, inboxEmails, sentEmails, threadIds, setInboundFlag, setSentFlag],
  )

  const bulkDeleteDrafts = useCallback(() => {
    const ids = new Set(selectedBulk)
    ids.forEach(id => deleteStashItem('draft', id, apiHeaders()))
    setDrafts(current => current.filter(entry => !ids.has(entry.id)))
    if (selectedId && ids.has(selectedId)) setSelectedId(null)
    setSelectedBulk(new Set())
  }, [selectedBulk, apiHeaders, selectedId])

  const bulkCancelScheduled = useCallback(async () => {
    const ids = Array.from(selectedBulk)
    if (!ids.length) return
    await Promise.all(
      ids.map(id => fetch(`/api/mail/emails/${id}`, { method: 'DELETE', headers: apiHeaders() }).catch(() => {})),
    )
    setSelectedBulk(new Set())
    setSentFlash('Canceled')
    window.setTimeout(() => setSentFlash(''), 2500)
    loadSent()
  }, [selectedBulk, apiHeaders, loadSent])

  // Admin: bulk-reassign the selection to a mailbox (routes inbound + sent ids separately).
  const bulkAssign = useCallback(
    async (ownerAddress: string) => {
      const ids = Array.from(selectedBulk)
      if (!ids.length || !ownerAddress) return
      const inboundIds = ids.filter(id => inboxEmails.some(entry => entry.id === id))
      const sentIds = ids.filter(id => sentEmails.some(entry => entry.id === id))
      await Promise.all([
        inboundIds.length
          ? fetch('/api/mail/inbox', { method: 'PATCH', headers: apiHeaders(), body: JSON.stringify({ ids: inboundIds, owner: ownerAddress }) })
          : Promise.resolve(),
        sentIds.length
          ? fetch('/api/mail/emails', { method: 'PATCH', headers: apiHeaders(), body: JSON.stringify({ ids: sentIds, owner: ownerAddress }) })
          : Promise.resolve(),
      ])
      setSelectedBulk(new Set())
      refreshAll()
    },
    [selectedBulk, inboxEmails, sentEmails, apiHeaders, refreshAll],
  )

  const suggestContacts = useCallback(
    async (query: string): Promise<Array<{ email: string; name: string | null }>> => {
      try {
        const response = await fetch(`/api/mail/contacts?q=${encodeURIComponent(query)}`, { headers: apiHeaders() })
        const data = await response.json()
        return data.ok ? data.contacts : []
      } catch {
        return []
      }
    },
    [apiHeaders],
  )

  const saveSettings = useCallback(
    (next: MailSettings) => {
      setMailSettings(next)
      fetch('/api/mail/settings', {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify(next),
      }).catch(() => {})
    },
    [apiHeaders],
  )

  const resetSignature = useCallback(async () => {
    const agreed = await confirm({
      title: 'Use the company signature?',
      body: <>Your own wording is replaced by the signature the firm maintains, which then follows any change to its details.</>,
      confirmLabel: 'Use the company one',
      danger: true,
    })
    if (!agreed) return
    setMailSettings(current => ({ ...current, signature: '' }))
  }, [confirm])

  const closeSettings = useCallback(() => {
    saveSettings(settings)
    if (companySignatureEdited) {
      void fetch('/api/mail/company-signature', {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify({ signature: companySignature, logo: companyLogo }),
      }).catch(() => {})
      setCompanySignatureEdited(false)
    }
    setSettingsOpen(false)
  }, [saveSettings, settings, companySignature, companyLogo, companySignatureEdited, apiHeaders])

  // Absolute, because the recipient's mail client has no idea what our origin is.
  const absoluteLogo = (path: string) =>
    path.startsWith('http') ? path : `${typeof window === 'undefined' ? '' : window.location.origin}${path}`
  // Nobody should send mail signed as "the team". A mailbox with nothing written of its
  // own gets the house signature under its own name, in the form the firm already uses.
  const identityFor = {
    name: settings.senderName.trim() || account?.name || '',
    email: account?.address || email || '',
    mobile: settings.mobile.trim(),
  }
  const houseSignature = companySignature.trim()
    ? fillSignature(companySignature, identityFor)
    : defaultSignature(identityFor.name, identityFor.email, identityFor.mobile || undefined, CLIENT_BRAND)
  const ownSignature = settings.signature.trim()
  const signatureBody = ownSignature || houseSignature
  // A hand-written signature replaces the house one wholesale, mark included, so the firm's
  // mark goes back on top unless that signature already carries an image of its own.
  const signatureMarkSrc = /<img\b/i.test(signatureBody) ? '' : settings.signatureLogo || companyLogo || CLIENT_BRAND.markUrl
  const signatureLogoHtml = signatureMarkSrc
    ? `<div style="margin-bottom:12px;"><img src="${absoluteLogo(signatureMarkSrc)}" alt="${escapeHtml(CLIENT_BRAND.name)}" width="200" style="${clientSignatureMarkStyle(200)}" /></div>`
    : ''
  const signatureHtml = `<div style="margin-top:26px;padding-top:18px;border-top:1px solid #E8E2F4;">${signatureLogoHtml}${asRichHtml(dropUnreachableImages(signatureBody))}</div>`
  const signatureText = `\n\n${htmlToPlainText(asRichHtml(signatureBody))}`
  // Airy is not only more room: it is the setting for someone who never wants to see the
  // source of a message or how it was authenticated.
  const plainSpoken = settings.density === 'relaxed'
  useEffect(() => {
    if (!plainSpoken) return
    setReaderMode(current => (current === 'html' || current === 'raw' ? 'preview' : current))
    setReplyMode(current => (current === 'html' || current === 'raw' ? 'write' : current))
  }, [plainSpoken])
  const fontCss = fontFaceCss(settings.fonts ?? [], CLIENT_BRAND.publicUrl)
  const defaultFont = settings.defaultFont ?? EMPTY_FONT

  const [logoBusy, setLogoBusy] = useState(false)
  const [logoMsg, setLogoMsg] = useState('')

  // Returns a stable, unauthenticated URL: an image pasted into a body has to keep
  // loading for the recipient long after any signed link would have expired.
  const uploadInlineImage = useCallback(
    async (file: File) => {
      const response = await fetch('/api/mail/signature-logo', {
        method: 'POST',
        headers: { ...apiHeaders(), 'content-type': file.type },
        body: file,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'That image could not be stored.')
      return data.url as string
    },
    [apiHeaders],
  )

  const [fontName, setFontName] = useState('')
  const [fontBusy, setFontBusy] = useState(false)
  const [fontMsg, setFontMsg] = useState('')
  const addFont = (font: CustomFont) =>
    setMailSettings(current => ({ ...current, fonts: [...(current.fonts ?? []).filter(entry => entry.name !== font.name), font] }))
  const uploadFont = async (file: File) => {
    setFontBusy(true)
    setFontMsg('')
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      const response = await fetch(`/api/mail/fonts?ext=${encodeURIComponent(extension)}`, { method: 'POST', headers: apiHeaders(), body: file })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'That font could not be stored.')
      addFont({ name: fontName.trim() || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), url: data.url as string })
      setFontName('')
    } catch (err) {
      setFontMsg(err instanceof Error ? err.message : 'That font could not be stored.')
    } finally {
      setFontBusy(false)
    }
  }

  const uploadSignatureLogo = useCallback(
    async (file: File) => {
      setLogoBusy(true)
      setLogoMsg('')
      try {
        const url = await uploadInlineImage(file)
        setMailSettings(current => ({ ...current, signatureLogo: url }))
      } catch (err) {
        setLogoMsg(err instanceof Error ? err.message : 'That image could not be stored.')
      } finally {
        setLogoBusy(false)
      }
    },
    [uploadInlineImage],
  )

  const uploadCompanyLogo = useCallback(
    async (file: File) => {
      setLogoBusy(true)
      setLogoMsg('')
      try {
        setCompanyLogo(await uploadInlineImage(file))
        setCompanySignatureEdited(true)
      } catch (err) {
        setLogoMsg(err instanceof Error ? err.message : 'That image could not be stored.')
      } finally {
        setLogoBusy(false)
      }
    },
    [uploadInlineImage],
  )

  const saveDraftNow = useCallback(
    (data: ComposeData, id: string | null): string => {
      const draftKey = id ?? uid()
      const hasContent = data.subject.trim() || data.markdown.trim() || data.to.length || data.htmlSource.trim()
      const savedAt = new Date().toISOString()
      const headers = apiHeaders()
      if (hasContent) {
        putStash('draft', draftKey, data, headers)
        setDrafts(current => [{ id: draftKey, savedAt, data }, ...current.filter(entry => entry.id !== draftKey)])
      } else {
        deleteStashItem('draft', draftKey, headers)
        setDrafts(current => current.filter(entry => entry.id !== draftKey))
      }
      return draftKey
    },
    [apiHeaders],
  )

  useEffect(() => {
    if (!composeOpen) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      setDraftId(current => saveDraftNow(compose, current))
    }, 800)
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    }
  }, [compose, composeOpen, saveDraftNow])

  const openCompose = (data?: Partial<ComposeData>, existingDraftId?: string, options?: { keepAttachments?: boolean }) => {
    // Full width unless a message is open — replying wants the original in view.
    setComposeExpanded(!selectedId)
    // The sender name is whoever is signed in — their profile name, else the account
    // name, else the local part of their address — not a fixed company name.
    setCompose({ ...EMPTY_COMPOSE, fromName: identityName, ...data })
    // A reply handed over from the dock brings its files with it; everything else starts clean.
    if (!options?.keepAttachments) setAttachments([])
    setComposeError('')
    setShowCcBcc(Boolean(data?.cc?.length || data?.bcc?.length))
    setDraftId(existingDraftId ?? null)
    setComposeOpen(true)
  }

  const closeCompose = () => {
    setDraftId(current => saveDraftNow(compose, current))
    setComposeOpen(false)
  }

  const discardCompose = async () => {
    const hasWork = compose.bodyHtml.trim() || compose.subject.trim() || compose.to.length || attachments.length
    if (hasWork) {
      const agreed = await confirm({
        title: 'Discard this message?',
        body: 'What you have written and attached will be thrown away.',
        confirmLabel: 'Discard',
        danger: true,
      })
      if (!agreed) return
    }
    if (draftId) {
      deleteStashItem('draft', draftId, apiHeaders())
      setDrafts(current => current.filter(entry => entry.id !== draftId))
    }
    setComposeOpen(false)
  }

  const openDraft = (id: string) => {
    cancelThreadOpen()
    const draft = drafts.find(entry => entry.id === id)
    if (!draft) return
    openCompose(draft.data, draft.id)
  }

  const deleteDraft = (id: string) => {
    deleteStashItem('draft', id, apiHeaders())
    setDrafts(current => current.filter(entry => entry.id !== id))
    if (selectedId === id) setSelectedId(null)
  }






  const buildCampaign = async () => {
    setComposeError('')
    const campaign = compose.campaign
    try {
      const response = await fetch('/api/mail/render-template', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          template: campaign.kind,
          firstName: campaign.firstName,
          courses: campaign.courses.join(', '),
          cohortDate: campaign.cohortDate,
          projectType: campaign.projectType,
          includeAcademy: campaign.includeAcademy,
        }),
      })
      const data = await response.json()
      if (!data.ok) {
        setComposeError(data.error ?? 'Could not build the email')
        return
      }
      setCompose(current => ({ ...current, subject: data.subject, htmlSource: data.html, htmlDirty: true }))
    } catch {
      setComposeError('Network error — try again')
    }
  }

  // Arm the drop hint as soon as files enter the window, so the target is visible before
  // the cursor gets there. Depth-counted: dragleave also fires moving between children.
  useEffect(() => {
    // Armed wherever a message is being written, not only in the full composer: the
    // reply tray is where most replies are written, and a file dragged onto it was
    // simply opened by the browser.
    if (!composeOpen && !selectedId) {
      dragDepth.current = 0
      setDragState('idle')
      return
    }
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      dragDepth.current += 1
      setDragState(current => (current === 'over' ? current : 'armed'))
    }
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragState('idle')
    }
    const onOver = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault() // otherwise the browser opens the file
    }
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragState('idle')
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [composeOpen, selectedId])

  /**
   * A PUT that cannot hang. XHR has no timeout that suits an upload — its own applies to
   * the whole request, so a legitimate two-gigabyte transfer would trip it — but a stalled
   * connection stops firing progress without ever failing, leaving a chip frozen at some
   * percentage for good. This fails the upload when the bytes stop moving instead.
   */
  const putWithProgress = useCallback(
    (url: string, file: File, contentType: string | null, onProgress: (percent: number) => void) =>
      new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest()
        let lastMovement = Date.now()
        const watchdog = setInterval(() => {
          if (Date.now() - lastMovement > STALL_AFTER_MS) {
            clearInterval(watchdog)
            request.abort()
            reject(new Error('Upload stalled. Check your connection and retry.'))
          }
        }, 2000)
        const settle = () => clearInterval(watchdog)

        request.open('PUT', url)
        if (contentType) request.setRequestHeader('content-type', contentType)
        request.upload.onprogress = event => {
          lastMovement = Date.now()
          if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
        }
        request.onload = () => {
          settle()
          if (request.status >= 200 && request.status < 300) resolve()
          else reject(new Error(`Upload failed (${request.status})`))
        }
        request.onerror = () => { settle(); reject(new Error('Upload failed. Check your connection and retry.')) }
        request.onabort = () => settle()
        request.send(file)
      }),
    [],
  )

  /**
   * Anything past the mail-attachment ceiling goes to object storage and travels
   * as a link, because providers bounce oversized messages and Resend caps a send
   * well below what people routinely drag in.
   */
  const uploadAsShare = useCallback(
    async (file: File, uid: string): Promise<Attachment> => {
      const register = await fetch('/api/mail/share', {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          expiresInDays: 30,
        }),
      })
      const registered = await register.json().catch(() => null)
      if (!register.ok || !registered?.ok) throw new Error(registered?.error ?? 'Could not prepare the upload')

      await putWithProgress(registered.uploadUrl, file, null, progress =>
        setAttachments(current => current.map(entry => (entry.uid === uid ? { ...entry, progress } : entry))),
      )

      return {
        filename: file.name,
        url: '',
        size: file.size,
        shareId: registered.id as string,
        shareUrl: `${window.location.origin}/share/${registered.id}`,
      }
    },
    [apiHeaders, putWithProgress],
  )

  /**
   * Straight to the bucket with a short-lived signed URL: XHR rather than fetch because it
   * reports progress, and an upload with no feedback reads as a hang.
   */
  const uploadToBucket = useCallback(
    async (file: File, uid: string): Promise<Attachment> => {
      const prepared = await fetch('/api/mail/outgoing-upload', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type }),
      })
      const info = await prepared.json().catch(() => null)
      if (!prepared.ok || !info?.ok) throw new Error(info?.error || 'Could not prepare the upload.')

      await putWithProgress(info.uploadUrl, file, file.type || null, progress =>
        setAttachments(current => current.map(entry => (entry.uid === uid ? { ...entry, progress } : entry))),
      )

      return { filename: file.name, url: '', key: info.key, size: file.size }
    },
    [apiHeaders, putWithProgress],
  )

  /**
   * One attempt at one file. A retry is the same call again, so a resumed upload behaves
   * exactly as the first one did rather than following a second, less-tested path.
   */
  const runUpload = useCallback(
    async (file: File, uid: string) => {
      try {
        const finished =
          file.size > ATTACH_LIMIT_BYTES ? await uploadAsShare(file, uid) : await uploadToBucket(file, uid)
        // The file is kept: a message can sit in the composer for a while, and a
        // send that fails later should still be retryable without re-picking it.
        setAttachments(current =>
          current.map(entry => (entry.uid === uid ? { ...entry, ...finished, uid, uploading: false, uploaded: true, file } : entry)),
        )
        // The confirmation is temporary; the size is what stays useful afterwards.
        window.setTimeout(
          () =>
            setAttachments(current =>
              current.map(entry => (entry.uid === uid ? { ...entry, uploaded: false } : entry)),
            ),
          2500,
        )
      } catch (err) {
        setAttachments(current =>
          current.map(entry =>
            entry.uid === uid
              ? {
                  ...entry,
                  uploading: false,
                  progress: 0,
                  file,
                  error: err instanceof Error ? err.message : 'Upload failed',
                }
              : entry,
          ),
        )
      }
    },
    [uploadAsShare, uploadToBucket],
  )

  const retryUpload = useCallback(
    (target: Attachment) => {
      const uid = target.uid
      if (!target.file || !uid) return
      setAttachments(current =>
        current.map(entry =>
          entry.uid === uid
            ? { uid, filename: target.filename, url: '', size: target.size, uploading: true, progress: 0, file: target.file, preview: target.preview }
            : entry,
        ),
      )
      void runUpload(target.file, uid)
    },
    [runUpload],
  )

  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setComposeError('')
    for (const file of Array.from(files)) {
      if (file.size > 2 * 1024 * 1024 * 1024) {
        setComposeError(`${file.name} is larger than 2GB`)
        continue
      }
      const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      let preview: string | undefined
      if (file.type.startsWith('image/')) {
        preview = URL.createObjectURL(file)
        previewUrls.current.push(preview)
      }
      setAttachments(current => [
        ...current,
        { uid, filename: file.name, url: '', size: file.size, uploading: true, progress: 0, file, preview },
      ])
      await runUpload(file, uid)
    }
  }


  const applyLock = useCallback(async () => {
    if (lockTarget == null) return
    const target = attachments[lockTarget]
    if (!target?.shareId) return
    const next = lockValue.trim()
    setAttachments(list =>
      list.map((entry, index) => (index === lockTarget ? { ...entry, password: next || undefined } : entry)),
    )
    setLockTarget(null)
    setLockValue('')
    await fetch('/api/mail/share', {
      method: 'PATCH',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: target.shareId, password: next }),
    }).catch(() => {})
  }, [apiHeaders, attachments, lockTarget, lockValue])

  const resolveScheduledAt = (): string | null => {
    if (compose.delayKey === '0') return null
    if (compose.delayKey === 'custom') {
      if (!compose.customDate) return null
      return new Date(compose.customDate).toISOString()
    }
    return new Date(Date.now() + Number(compose.delayKey) * 1000).toISOString()
  }

  const sendEmail = async () => {
    setComposeError('')
    const badAddress = [...compose.to, ...compose.cc, ...compose.bcc].find(addr => !EMAIL_RE.test(addr))
    if (badAddress) {
      setComposeError(`"${badAddress}" is not a valid address`)
      return
    }
    if (!compose.to.length) {
      setComposeError('Add at least one recipient')
      return
    }
    if (!compose.subject.trim()) {
      setComposeError('Add a subject')
      return
    }
    if (attachments.some(entry => entry.uploading)) {
      setComposeError('One of the files is still uploading')
      return
    }
    const failedUpload = attachments.find(entry => entry.error)
    if (failedUpload) {
      setComposeError(`${failedUpload.filename} did not upload. Remove it or try again.`)
      return
    }
    let html = buildEmailHtml(compose, signatureHtml, fontCss, defaultFont)
    let text = buildEmailText(compose, signatureText)
    if (!html.trim() && !text.trim()) {
      setComposeError('Write something first')
      return
    }

    const attachable = attachments.filter(entry => entry.size <= ATTACH_LIMIT_BYTES)
    const linked = attachments.filter(entry => entry.size > ATTACH_LIMIT_BYTES)
    if (linked.length) {
      const rows = linked
        .map(
          entry =>
            `<tr><td style="padding:6px 0"><a href="${entry.shareUrl ?? entry.url}" style="display:inline-block;background:${CLIENT_BRAND.accent};color:#fff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:8px;font-family:Arial,sans-serif;font-size:14px">Download ${escapeHtml(entry.filename)} (${formatBytes(entry.size)})</a></td></tr>`,
        )
        .join('')
      html += `<div style="margin-top:20px"><p style="font-family:Arial,sans-serif;font-size:14px;color:#5A5170;margin:0 0 8px">Large files:</p><table role="presentation">${rows}</table></div>`
      text += `\n\nLarge files:\n${linked.map(entry => `${entry.filename} — ${entry.shareUrl ?? entry.url}`).join('\n')}`
    }

    // Resend can't schedule a send that carries attachments, so those go out
    // immediately — the delay/undo window only applies to attachment-free emails.
    const scheduledAt = attachable.length ? null : resolveScheduledAt()

    if (settings.confirmSend && !scheduledAt) {
      const recipientList = [...compose.to, ...compose.cc, ...compose.bcc].join(', ')
      const agreed = await confirm({
        title: 'Send this message?',
        body: <>It will go to <strong>{recipientList}</strong>.</>,
        confirmLabel: 'Send',
      })
      if (!agreed) return
    }

    setSending(true)
    try {
      const response = await fetch('/api/mail/send', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          to: compose.to,
          cc: compose.cc,
          bcc: compose.bcc,
          replyTo: compose.replyTo || undefined,
          fromName: compose.fromName,
          subject: compose.subject,
          html,
          text,
          scheduledAt: scheduledAt ?? undefined,
          inReplyTo: compose.inReplyTo || undefined,
          actAs: actingAs ?? undefined,
          attachments: attachable.map(({ filename, url, key }) => (key ? { filename, key } : { filename, path: url })),
        }),
      })
      const data = await response.json()
      if (!data.ok) {
        setComposeError(data.error ?? 'Send failed')
        return
      }
      const snapshot = compose
      const sentAttachments = attachments
      if (draftId) {
        deleteStashItem('draft', draftId, apiHeaders())
        setDrafts(current => current.filter(entry => entry.id !== draftId))
      }
      setComposeOpen(false)
      setCompose(EMPTY_COMPOSE)
      setAttachments([])
      setDraftId(null)
      if (scheduledAt && data.id) {
        setUndo({ id: data.id, sendAt: new Date(scheduledAt).getTime(), snapshot, attachments: sentAttachments })
      } else {
        setSentFlash('Sent')
        window.setTimeout(() => setSentFlash(''), 2500)
      }
      window.setTimeout(loadSent, 1200)
    } catch {
      setComposeError('Network error — try again')
    } finally {
      setSending(false)
    }
  }

  const undoSend = async () => {
    if (!undo) return
    const { id, snapshot, attachments: restoredAttachments } = undo
    setUndo(null)
    try {
      const response = await fetch(`/api/mail/emails/${id}`, { method: 'DELETE', headers: apiHeaders() })
      const data = await response.json()
      if (data.ok) {
        setCompose(snapshot)
        setAttachments(restoredAttachments)
        setComposeOpen(true)
        setSentFlash('Canceled — back to draft')
        window.setTimeout(() => setSentFlash(''), 2500)
        loadSent()
      } else {
        setSentFlash(data.error?.includes('cancel') ? 'Too late — already sent' : `Could not cancel: ${data.error}`)
        window.setTimeout(() => setSentFlash(''), 3000)
      }
    } catch {
      setSentFlash('Could not cancel')
      window.setTimeout(() => setSentFlash(''), 3000)
    }
  }

  useEffect(() => {
    if (undo && undo.sendAt <= now) {
      setUndo(null)
      setSentFlash('Sent')
      window.setTimeout(() => setSentFlash(''), 2500)
      loadSent()
    }
  }, [undo, now, loadSent])

  const cancelScheduled = async (id: string) => {
    try {
      const response = await fetch(`/api/mail/emails/${id}`, { method: 'DELETE', headers: apiHeaders() })
      const data = await response.json()
      setSentFlash(data.ok ? 'Canceled' : `Could not cancel: ${data.error}`)
      window.setTimeout(() => setSentFlash(''), 2500)
      if (data.ok) {
        setSelectedId(null)
        loadSent()
      }
    } catch {}
  }

  const rescheduleScheduled = async (id: string, iso: string) => {
    try {
      const response = await fetch(`/api/mail/emails/${id}`, {
        method: 'PATCH',
        headers: apiHeaders(),
        body: JSON.stringify({ scheduledAt: iso }),
      })
      const data = await response.json()
      setSentFlash(data.ok ? 'Rescheduled' : `Could not reschedule: ${data.error}`)
      window.setTimeout(() => setSentFlash(''), 2500)
      if (data.ok) loadSent()
    } catch {}
  }

  const quotedBody = (from: string, when: string, html: string | null, text: string | null) => {
    const body = htmlToQuoteText(html, text)
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n')
    return `\n\nOn ${new Date(when).toLocaleString()}, ${from} wrote:\n\n${body}`
  }

  const quoteBlock = (from: string, when: string, html: string | null, text: string | null) =>
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#030712;">${inlineEmailStyles(markdownToHtml(quotedBody(from, when, html, text)))}</div>`

  const replyTo = (entry: InboundEmail) => {
    const target = entry.replyTo.length ? parseAddress(entry.replyTo[0]) : parseAddress(entry.from)
    openCompose({
      to: [target],
      subject: entry.subject.startsWith('Re:') ? entry.subject : `Re: ${entry.subject}`,
      quoteHtml: quoteBlock(entry.from, entry.receivedAt, entry.html, entry.text),
      useSignature: true,
      inReplyTo: headerValue(entry, 'message-id') || entry.id,
    })
  }

  // Aggregate every conversation participant into to/cc — a cc'd party may only appear
  // on an earlier reply, not on the latest message. Shared by Reply-all (modal + inline bar).
  const replyAllRecipients = (entry: InboundEmail): { to: string[]; cc: string[] } => {
    // MAIL_ADDRESSES is the floor for members, who never load the accessor list. The
    // live addresses go on top so a seat added after this build still gets recognised
    // as us rather than being replied to.
    const self = new Set(
      [
        email,
        account?.address,
        actingAs,
        ...MAIL_ADDRESSES,
        ...accessors.map(entry => entry.address),
      ]
        .filter(Boolean)
        .map(address => String(address).toLowerCase()),
    )
    const notSelf = (address: string) => Boolean(address) && !self.has(address.toLowerCase())
    const members = threadMembers(entry.id)
    const latest = members[members.length - 1] ?? entry
    const primary = latest.replyTo.length ? parseAddress(latest.replyTo[0]) : parseAddress(latest.from)
    const direct: string[] = []
    const ccPool: string[] = []
    for (const member of members) {
      direct.push(parseAddress(member.from), ...member.to.map(parseAddress))
      ccPool.push(...member.cc.map(parseAddress))
    }
    const to = Array.from(new Set([primary, ...direct])).filter(notSelf)
    const cc = Array.from(new Set(ccPool)).filter(address => notSelf(address) && !to.includes(address))
    return { to, cc }
  }

  const replyAllTo = (entry: InboundEmail) => {
    const members = threadMembers(entry.id)
    const latest = members[members.length - 1] ?? entry
    const { to, cc } = replyAllRecipients(entry)
    openCompose({
      to,
      cc,
      subject: latest.subject.startsWith('Re:') ? latest.subject : `Re: ${latest.subject}`,
      quoteHtml: quoteBlock(latest.from, latest.receivedAt, latest.html, latest.text),
      useSignature: true,
      inReplyTo: headerValue(latest, 'message-id') || latest.id,
    })
  }

  // The chat reply bar answers the newest message in the conversation.
  const quickReplyTarget = (entry: InboundEmail): InboundEmail => {
    const members = threadMembers(entry.id)
    return members[members.length - 1] ?? entry
  }

  const defaultReplyRecipient = (entry: InboundEmail): string => {
    const target = quickReplyTarget(entry)
    const address = target.replyTo.length ? parseAddress(target.replyTo[0]) : parseAddress(target.from)
    return EMAIL_RE.test(address) ? address : ''
  }

  // Reply as a full ComposeData so it reuses the composer's html/text builders + Brand/Sig toggles.
  // Recipients come from the (collapsible) To/Cc/Bcc fields; an untouched To falls back to the sender.
  const buildReplyDraft = (entry: InboundEmail): ComposeData => {
    const target = quickReplyTarget(entry)
    const fallback = defaultReplyRecipient(entry)
    // Replying to everyone is the default: a conversation that reached four people is
    // answered to those four, and trimming the list is the deliberate act.
    const everyone = settings.replyAllDefault ? replyAllRecipients(entry) : { to: [], cc: [] }
    return {
      ...EMPTY_COMPOSE,
      to: replyRecipsEdited || replyToList.length
        ? replyToList
        : everyone.to.length
          ? everyone.to
          : fallback
            ? [fallback]
            : [],
      cc: replyRecipsEdited || replyCc.length ? replyCc : everyone.cc,
      bcc: replyBcc,
      subject: target.subject.startsWith('Re:') ? target.subject : `Re: ${target.subject}`,
      markdown: quickReply,
      htmlSource: replyHtml,
      htmlDirty: replyHtmlDirty,
      useSignature: replySig,
      inReplyTo: headerValue(target, 'message-id') || target.id,
    }
  }

  // Fill the fields with everyone the reply is already going to, so opening the panel shows
  // what will happen rather than an empty box.
  const toggleReplyRecips = (entry: InboundEmail) => {
    setReplyRecipsOpen(open => {
      if (!open && !replyToList.length) {
        const sender = defaultReplyRecipient(entry)
        const { to, cc } = settings.replyAllDefault ? replyAllRecipients(entry) : { to: [], cc: [] }
        setReplyToList(to.length ? to : sender ? [sender] : [])
        if (cc.length) setReplyCc(cc)
      }
      return !open
    })
  }

  // Insert a markdown snippet at the reply cursor (mirrors the composer's insertAtCursor).
  const insertReply = (snippet: string) => {
    setReplyMode('write')
    setReplyHtmlDirty(false)
    const field = quickReplyRef.current
    if (!field) {
      setQuickReply(value => value + snippet)
      return
    }
    const start = field.selectionStart
    const end = field.selectionEnd
    setQuickReply(value => value.slice(0, start) + snippet + value.slice(end))
    requestAnimationFrame(() => {
      field.focus()
      field.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }




  const sendQuickReply = async (entry: InboundEmail) => {
    const body = quickReply.trim() || (replyHtmlDirty ? replyHtml.trim() : '')
    if (!body || quickSending) return
    const draft = buildReplyDraft(entry)
    if (!draft.to.length) {
      openReplySettings(entry)
      return
    }
    setQuickSending(true)
    setReplyError('')
    try {
      // Files ride along the same way the full composer sends them: anything past the
      // attachment ceiling becomes a download link rather than being dropped.
      const attachable = attachments.filter(entry => entry.size <= ATTACH_LIMIT_BYTES && !entry.error)
      const linked = attachments.filter(entry => entry.size > ATTACH_LIMIT_BYTES && !entry.error)
      const linkRows = linked
        .map(
          entry =>
            `<tr><td style="padding:6px 0"><a href="${entry.shareUrl ?? entry.url}" style="display:inline-block;background:${CLIENT_BRAND.accent};color:#fff;text-decoration:none;font-weight:600;padding:9px 16px;border-radius:8px;font-family:Arial,sans-serif;font-size:14px">Download ${escapeHtml(entry.filename)} (${formatBytes(entry.size)})</a></td></tr>`,
        )
        .join('')
      const linkBlock = linkRows ? `<table role="presentation" style="margin-top:18px">${linkRows}</table>` : ''

      const response = await fetch('/api/mail/send', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          fromName: draft.fromName,
          subject: draft.subject,
          html: buildEmailHtml(draft, signatureHtml, fontCss, defaultFont) + linkBlock,
          text: buildEmailText(draft, signatureText),
          attachments: attachable.map(({ filename, url, key }) => (key ? { filename, key } : { filename, path: url })),
          inReplyTo: draft.inReplyTo || undefined,
          actAs: actingAs ?? undefined,
        }),
      })
      const data = await response.json().catch(() => null)
      // Saying nothing was the bug: a refusal from the server looked exactly like the
      // button not working, and the commonest refusal — replying to your own address —
      // is one the sender can act on immediately.
      if (!response.ok || !data?.ok) {
        setReplyError(data?.error ?? `Send failed (${response.status})`)
        return
      }
      setAttachments([])
      setQuickReply('')
      setReplyHtml('')
      setReplyHtmlDirty(false)
      setReplyMode('write')
      setReplyToList([])
      setReplyCc([])
      setReplyBcc([])
      setReplyRecipsOpen(false)
      setSentFlash('Sent')
      window.setTimeout(() => setSentFlash(''), 2500)
      window.setTimeout(loadSent, 1200)
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : 'Could not reach the server.')
    } finally {
      setQuickSending(false)
    }
  }

  // The settings icon on the reply bar hands the typed text off to the full composer (Cc/Bcc/formatting/attachments).
  /**
   * Replying to something you sent writes to the same people again, quoting what went out.
   * The message's own id stands in for a Message-ID, as it already does for inbound mail.
   */
  const replyToSent = (sent: SentEmail, detail: SentDetail | null, everyone: boolean) => {
    const to = sent.to.map(parseAddress)
    const cc = everyone ? (detail?.cc ?? sent.cc ?? []).map(parseAddress).filter(address => !to.includes(address)) : []
    openCompose({
      to,
      cc,
      subject: sent.subject.startsWith('Re:') ? sent.subject : `Re: ${sent.subject}`,
      quoteHtml: quoteBlock(sent.from, sent.createdAt, detail?.html ?? null, detail?.text ?? null),
      useSignature: true,
      inReplyTo: sent.id,
    })
  }

  /**
   * On a phone the docked reply becomes the composer as its own page. Everything typed or
   * attached in the dock travels with it — the older hand-off quietly dropped the files.
   */
  const openReplyPage = (entry: InboundEmail) => {
    const draft = buildReplyDraft(entry)
    const target = quickReplyTarget(entry)
    const typed = quickReply.trim()
    const bodyHtml = draft.htmlDirty && draft.htmlSource.trim() ? draft.htmlSource : typed ? markdownToHtml(typed) : ''
    openCompose(
      {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        bodyHtml,
        quoteHtml: quoteBlock(target.from, target.receivedAt, target.html, target.text),
        useSignature: draft.useSignature,
        inReplyTo: draft.inReplyTo,
      },
      undefined,
      { keepAttachments: true },
    )
    setComposeExpanded(true)
    setQuickReply('')
    setReplyHtml('')
    setReplyHtmlDirty(false)
    setReplyMode('write')
    setReplyToList([])
    setReplyCc([])
    setReplyBcc([])
    setReplyRecipsOpen(false)
    setReplyRecipsEdited(false)
  }

  const openReplySettings = (entry: InboundEmail) => {
    replyAllTo(entry)
    const typed = quickReply.trim()
    if (typed) setCompose(data => ({ ...data, bodyHtml: markdownToHtml(typed) + data.bodyHtml, useSignature: replySig }))
    setQuickReply('')
  }

  /**
   * Forwarding carries the files as well as the words. The originals live under a key the
   * send route will not accept — deliberately, so a caller cannot name any object in the
   * bucket — so the server copies them into the outgoing space first.
   */
  const carryForwardAttachments = async (messageId: string, kind: 'inbound' | 'sent' = 'inbound') => {
    setAttachmentsLoading(true)
    try {
      const response = await fetch(
        kind === 'sent'
          ? `/api/mail/emails/${encodeURIComponent(messageId)}/attachments/forward`
          : '/api/mail/inbox/attachments/forward',
        {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: messageId }),
        },
      )
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok || !data.attachments?.length) return
      setAttachments(
        (data.attachments as Array<{ filename: string; size: number; key: string }>).map(entry => ({
          filename: entry.filename,
          url: '',
          key: entry.key,
          size: entry.size,
          uid: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        })),
      )
    } catch {
      // The message still forwards; the files simply are not carried.
    } finally {
      setAttachmentsLoading(false)
    }
  }

  const forwardEmail = (
    subject: string,
    html: string | null,
    text: string | null,
    messageId?: string,
    kind: 'inbound' | 'sent' = 'inbound',
  ) => {
    const fwSubject = subject.startsWith('Fwd:') ? subject : `Fwd: ${subject}`
    if (html && html.trim()) {
      // Carry the whole original mail (full HTML), not a stripped snippet.
      const header = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#5A5170;border-left:3px solid ${CLIENT_BRAND.accent};padding:4px 0 4px 12px;margin:0 0 16px;">---------- Forwarded message ----------<br>Subject: ${escapeHtml(subject)}</div>`
      openCompose({ subject: fwSubject, quoteHtml: `${header}${html}` })
    } else {
      openCompose({
        subject: fwSubject,
        quoteHtml: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#030712;">${inlineEmailStyles(markdownToHtml(`---\n\nForwarded message:\n\n${text ?? ''}`))}</div>`,
      })
    }
    // After openCompose, which clears the list the files are about to go into.
    if (messageId) void carryForwardAttachments(messageId, kind)
  }

  const printMessage = (subject: string, from: string, when: string, html: string | null, text: string | null, recipients: { to?: string[]; cc?: string[] } = {}) => {
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    document.body.appendChild(frame)
    const doc = frame.contentWindow?.document
    if (!doc) return
    // A printed message leaves the building — on a client's desk, in a file, attached to a
    // claim — so it carries the mark. Right-aligned against the header so it reads as
    // letterhead rather than as part of the message.
    const meta = `<table role="presentation" width="100%" style="font-family:Arial,sans-serif;font-size:13px;color:#333;border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px;border-collapse:collapse;">
      <tr>
        <td style="vertical-align:top;">
          <div style="font-size:18px;font-weight:600;color:#111;margin-bottom:6px;">${escapeHtml(subject)}</div>
          <div><strong>From:</strong> ${escapeHtml(from)}</div>
          ${recipients.to?.length ? `<div><strong>To:</strong> ${escapeHtml(recipients.to.join(', '))}</div>` : ''}
          ${recipients.cc?.length ? `<div><strong>Cc:</strong> ${escapeHtml(recipients.cc.join(', '))}</div>` : ''}
          <div><strong>Date:</strong> ${new Date(when).toLocaleString()}</div>
        </td>
        <td style="vertical-align:top;text-align:right;width:110px;">
          <img src="${PRINT_MARK_URL}" alt="${escapeHtml(CLIENT_BRAND.name)}" width="64" height="46"
               style="display:inline-block;width:64px;height:auto;border:0;vertical-align:top;" />
          <div style="font-size:11px;color:#6B6480;padding-top:4px;">${CLIENT_BRAND.website}</div>
        </td>
      </tr>
    </table>`
    // print-color-adjust keeps the mark from being dropped by "background graphics off".
    const printCss = `<style>
      @page { margin: 14mm; }
      body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      img { max-width: 100%; }
    </style>`
    doc.open()
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title>${printCss}</head><body>${meta}${html ? stripOwnPixel(html) : `<pre style="font-family:Arial,sans-serif;white-space:pre-wrap;">${escapeHtml(text ?? '')}</pre>`}</body></html>`)
    doc.close()
    frame.contentWindow?.focus()
    window.setTimeout(() => {
      frame.contentWindow?.print()
      window.setTimeout(() => document.body.removeChild(frame), 1000)
    }, 250)
  }

  const downloadEml = (entry: { subject: string; from: string; to: string[]; receivedAt?: string; createdAt?: string; html: string | null; text: string | null }) => {
    const when = entry.receivedAt ?? entry.createdAt ?? new Date().toISOString()
    const lines = [
      `From: ${entry.from}`,
      `To: ${entry.to.join(', ')}`,
      `Subject: ${entry.subject}`,
      `Date: ${new Date(when).toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: ${entry.html ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      entry.html ?? entry.text ?? '',
    ]
    const blob = new Blob([lines.join('\r\n')], { type: 'message/rfc822' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${(entry.subject || 'message').replace(/[^\w.-]+/g, '_').slice(0, 60)}.eml`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const moveSelection = (direction: 1 | -1) => {
    if (!listItems.length) return
    const index = listItems.findIndex(item => item.id === selectedId)
    const nextIndex = index < 0 ? (direction === 1 ? 0 : listItems.length - 1) : Math.min(listItems.length - 1, Math.max(0, index + direction))
    const next = listItems[nextIndex]
    if (!next) return
    if (folder === 'drafts') setSelectedId(next.id)
    else if (inboxFolder) openInbound(next.id)
    else setSelectedId(next.id)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
      if (event.key === 'Escape') {
        if (composeOpen) closeCompose()
        else if (filesOpen) setFilesOpen(false)
        else if (settingsOpen) closeSettings()
        else if (threadOpening) { cancelThreadOpen(); setReaderOpenMobile(false) }
        else if (readerOpenMobile) setReaderOpenMobile(false)
        else if (selectedId) setSelectedId(null)
        return
      }
      // A shortcut here is a bare letter. Held with a modifier the key belongs to the browser
      // or the system — copy, select all, find, reload — and claiming it broke both that and
      // this: cmd+C opened the composer instead of copying the message you had selected.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (typing || composeOpen || !isLoggedIn) return
      if (event.key === '/') {
        event.preventDefault()
        document.querySelector<HTMLInputElement>(`.${styles.search} input`)?.focus()
        return
      }
      if (event.key === 'c') {
        event.preventDefault()
        openCompose()
        return
      }
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault()
        moveSelection(1)
        return
      }
      if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault()
        moveSelection(-1)
        return
      }
      if (!selectedInbound && selectedSent) {
        if (event.key === 'r') { event.preventDefault(); replyToSent(selectedSent, selectedDetail, settings.replyAllDefault); return }
        if (event.key === 'a') { event.preventDefault(); replyToSent(selectedSent, selectedDetail, true); return }
        if (event.key === 'f') {
          event.preventDefault()
          forwardEmail(selectedSent.subject, selectedDetail?.html ?? null, selectedDetail?.text ?? null, selectedSent.id, 'sent')
          return
        }
      }
      const inbound = selectedInbound
      if (!inbound) return
      switch (event.key) {
        case 'r':
          event.preventDefault()
          replyTo(inbound)
          break
        case 'a':
          event.preventDefault()
          replyAllTo(inbound)
          break
        case 'f':
          event.preventDefault()
          forwardEmail(inbound.subject, inbound.html, inbound.text, inbound.id)
          break
        case 's':
          event.preventDefault()
          setInboundFlag(threadIds(inbound.id), { starred: !inbound.starred })
          break
        case 'u':
          event.preventDefault()
          setInboundFlag(threadIds(inbound.id), { read: !inbound.read })
          break
        case 'e':
          if (folder !== 'trash') {
            event.preventDefault()
            setInboundFlag(threadIds(inbound.id), { archived: !inbound.archived })
            setSelectedId(null)
          }
          break
        case '#':
          event.preventDefault()
          setInboundFlag(threadIds(inbound.id), { trashed: folder !== 'trash' })
          setSelectedId(null)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => {
    if (!isLoggedIn || !settings.desktopNotifications || notifyPermission !== 'granted') return
    void subscribePush(apiHeaders())
  }, [isLoggedIn, settings.desktopNotifications, notifyPermission, apiHeaders, selectedSent, selectedDetail])

  useEffect(() => {
    announce(
      inboxEmails.map(item => ({
        id: item.id,
        from: item.from,
        subject: item.subject,
        read: item.read,
      })),
    )
  }, [inboxEmails, announce])

  const changePassword = useCallback(async () => {
    setPwMsg(null)
    if (pwNext !== pwRepeat) {
      setPwMsg({ tone: 'bad', text: 'The two new passwords do not match.' })
      return
    }
    setPwBusy(true)
    try {
      const response = await fetch('/api/mail/password', {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ current: pwCurrent, next: pwNext }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        setPwMsg({ tone: 'bad', text: data?.error ?? 'Could not change your password.' })
        return
      }
      setPwCurrent(''); setPwNext(''); setPwRepeat('')
      setPwMsg({ tone: 'ok', text: 'Password changed. Other devices have been signed out.' })
      // The nudge should go the moment the reason for it does.
      setAccount(current => (current ? { ...current, defaultPassword: false } : current))
    } catch {
      setPwMsg({ tone: 'bad', text: 'Could not reach the server. Try again.' })
    } finally {
      setPwBusy(false)
    }
  }, [apiHeaders, pwCurrent, pwNext, pwRepeat])

  // Tracked so the panel can show it is working. Without it an empty list and a list
  // that has not arrived look the same, and the panel claims there are no files while
  // it is still fetching them.
  const [sharesLoading, setSharesLoading] = useState(true)
  const [libraryLoading, setLibraryLoading] = useState(true)

  const loadShares = useCallback(async () => {
    setSharesLoading(true)
    try {
      const response = await fetch('/api/mail/share', { headers: apiHeaders() })
      const data = await response.json()
      if (data.ok) setShares(data.shares)
    } catch {
      // Keep whatever list was already showing.
    } finally {
      setSharesLoading(false)
    }
  }, [apiHeaders])

  const [libraryInbox, setLibraryInbox] = useState<LibraryFile[]>([])
  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true)
    try {
      const response = await fetch('/api/mail/attachments', { headers: apiHeaders() })
      const data = await response.json()
      if (data.ok) setLibraryInbox(data.files)
    } catch {
      // Keep whatever list was already showing.
    } finally {
      setLibraryLoading(false)
    }
  }, [apiHeaders])

  useEffect(() => {
    if (!filesOpen) {
      setShareDraft(null)
      setShareResult(null)
      setFilesMsg('')
      return
    }
    loadShares()
    loadLibrary()
  }, [filesOpen, loadShares, loadLibrary])

  const libraryFiles = useMemo<LibraryFile[]>(() => {
    const fromInbox = libraryInbox
    const fromSent = Object.values(detailCache).flatMap(detail =>
      detail.attachments
        .filter(file => file.downloadUrl && !file.shareId)
        .map(file => ({
          messageId: detail.id,
          filename: file.filename,
          size: file.size,
          url: file.downloadUrl,
          subject: detail.subject,
          from: detail.from,
          at: (detail as unknown as { createdAt?: string }).createdAt ?? '',
          sent: true,
        })),
    )
    return [...fromInbox, ...fromSent].sort((first, second) => (first.at < second.at ? 1 : -1))
  }, [libraryInbox, detailCache])

  const openShareDialog = (file: LibraryFile) => {
    setShareDraft(file)
    setShareResult(null)
    setSharePassword('')
    setShareMax('')
    setShareExpiry(7)
    setFilesMsg('')
  }

  const createShareLink = async () => {
    if (!shareDraft) return
    setShareBusy(true)
    setFilesMsg('')
    try {
      const response = await fetch('/api/mail/share/attachment', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          messageId: shareDraft.messageId,
          filename: shareDraft.filename,
          expiresInDays: shareExpiry || undefined,
          password: sharePassword || undefined,
          maxDownloads: shareMax ? Number(shareMax) : undefined,
        }),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error || 'Could not create the link.')
      setShareResult(data.url)
      loadShares()
    } catch (err) {
      setFilesMsg(err instanceof Error ? err.message : 'Could not create the link.')
    } finally {
      setShareBusy(false)
    }
  }

  const revokeShareLink = async (id: string) => {
    if (!window.confirm('Revoke this link? Anyone holding it loses access immediately.')) return
    await fetch(`/api/mail/share?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: apiHeaders() }).catch(() => {})
    loadShares()
  }

  const changeSharePassword = async (id: string) => {
    const next = window.prompt('Password for this link (leave blank to remove it):')
    if (next === null) return
    await fetch('/api/mail/share', {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ id, password: next }),
    }).catch(() => {})
    loadShares()
  }

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setFilesMsg('Link copied.')
    } catch {
      setFilesMsg(value)
    }
  }

  const accountName = account?.name ?? null
  const identityName =
    settings.senderName.trim() || accountName || (account?.address || email || '').split('@')[0] || 'Not signed in'
  const identityInitial = identityName.trim().charAt(0).toUpperCase() || '?'

  const signOut = async () => {
    const agreed = await confirm({
      title: 'Sign out?',
      body: 'You will need your password to get back in.',
      confirmLabel: 'Sign out',
    })
    if (!agreed) return
    // The cookie is httpOnly, so only the server can retire it. Awaited rather than
    // fired off: clearing local state first would show a signed-out screen while the
    // session was still live, and a reload would walk straight back in.
    try {
      await fetch('/api/mail/logout', { method: 'POST' })
    } catch {
      await confirm({
        title: 'Still signed in',
        body: 'We could not reach the server to end your session. Check your connection and try again.',
        confirmLabel: 'OK',
      })
      return
    }
    localStorage.removeItem(LS_EMAIL_KEY)
    localStorage.removeItem(LS_PASSWORD_KEY)
    setEmail('')
    setPassword('')
    setIsLoggedIn(false)
    window.location.reload()
  }

  const requestReset = async () => {
    setLoginError('')
    if (!email) {
      setLoginError('Enter your account email first')
      return
    }
    setResetBusy(true)
    try {
      await fetch('/api/mail/request-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setResetSent(true)
    } catch {
      setLoginError('Network error — try again')
    } finally {
      setResetBusy(false)
    }
  }

  // Whoever the message will actually leave as: the mailbox being acted on when an
  // admin is standing in for someone, otherwise the signed-in one. The server picks
  // the sender the same way, so what compose shows is what the recipient sees.
  const sendingAddress = actingAs ?? account?.address ?? email
  const scheduledForSelected = selectedSent?.scheduledAt ? new Date(selectedSent.scheduledAt).getTime() : null
  const folderTitles: Record<Folder, string> = {
    inbox: 'Inbox',
    starred: 'Starred',
    snoozed: 'Snoozed',
    sent: 'Sent',
    scheduled: 'Scheduled',
    drafts: 'Drafts',
    archived: 'Archive',
    trash: 'Trash',
  }

  if (checking) return <AccessCheck />

  if (!isLoggedIn) {
    if (resetMode) {
      return (
        <div className={styles.loginWrap}>
          <div className={styles.loginCard}>
            <div className={styles.loginBrand}>
              <span className={styles.brandMark} role="img" aria-label={CLIENT_BRAND.name} />
              <h1 className={styles.loginTitle}>Reset password</h1>
            </div>
            {resetSent ? (
              <>
                <p className={styles.loginSub}>
                  If {email} is an account, a reset link is on its way. The link expires in 30 minutes.
                </p>
                <button className={styles.loginBtn} onClick={() => { setResetMode(false); setResetSent(false) }}>
                  Back to sign in
                </button>
              </>
            ) : (
              <>
                <p className={styles.loginSub}>Enter your account email and we&apos;ll send a reset link.</p>
                <label className={styles.loginField}>
                  <span>Email</span>
                  <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" />
                </label>
                {loginError && <p className={styles.loginError}>{loginError}</p>}
                <button className={styles.loginBtn} onClick={requestReset} disabled={resetBusy}>
                  {resetBusy ? 'Sending…' : 'Send reset link'}
                </button>
                <button className={styles.loginTextLink} onClick={() => { setResetMode(false); setLoginError('') }}>
                  ← Back to sign in
                </button>
              </>
            )}
          </div>
        </div>
      )
    }
    return (
      <div className={styles.loginWrap}>
        <form
          className={styles.loginCard}
          onSubmit={event => {
            event.preventDefault()
            setLoginError('')
            attemptLogin(email, password, false)
          }}
        >
          <div className={styles.loginBrand}>
            <span className={styles.brandMark} role="img" aria-label={CLIENT_BRAND.name} />
            <h1 className={styles.loginTitle}>{CLIENT_BRAND.name} Mail</h1>
          </div>
          <p className={styles.loginSub}>Admin access only. Sign in with your account credentials.</p>
          <label className={styles.loginField}>
            <span>Email</span>
            {/* Everyone here is at the same domain, so only the part before it is typed.
                The domain stays editable for the occasional account somewhere else. */}
            <div className={styles.loginAddr}>
              <input
                className={styles.loginLocal}
                value={loginRaw}
                onChange={event => {
                  const typed = event.target.value
                  setLoginRaw(typed)
                  setEmail(`${typed.split('@')[0].trim()}@${loginDomain}`)
                }}
                autoComplete="username"
                placeholder="you"
                required
              />
              {!loginRaw.includes('@') && (LOGIN_DOMAINS.length > 1 ? (
                <MailSelect
                  value={loginDomain}
                  options={LOGIN_DOMAINS.map(entry => ({ value: entry, label: `@${entry}` }))}
                  ariaLabel="Domain"
                  buttonClassName={styles.loginDomain}
                  onChange={value => {
                    setLoginDomain(value)
                    setEmail(current => `${current.split('@')[0]}@${value}`)
                    try { localStorage.setItem(LS_DOMAIN_KEY, value) } catch {}
                  }}
                />
              ) : domainOpen ? (
                <input
                  className={styles.loginDomainEdit}
                  value={loginDomain}
                  autoFocus
                  aria-label="Domain"
                  onChange={event => {
                    const next = event.target.value.replace(/^@+/, '')
                    setLoginDomain(next)
                    setEmail(current => `${current.split('@')[0]}@${next}`)
                  }}
                  onBlur={() => {
                    setDomainOpen(false)
                    localStorage.setItem(LS_DOMAIN_KEY, loginDomain)
                  }}
                  onKeyDown={event => event.key === 'Enter' && event.currentTarget.blur()}
                />
              ) : (
                <button
                  type="button"
                  className={styles.loginDomain}
                  onClick={() => setDomainOpen(true)}
                  title="Change the domain"
                >
                  @{loginDomain}
                </button>
              ))}
              {/* Appears once there is something to copy: the address is often needed
                  elsewhere, and it is only ever half-visible here. */}
              {email.split('@')[0] && (
                <button
                  type="button"
                  className={styles.loginCopy}
                  title={`Copy ${email}`}
                  aria-label={`Copy ${email}`}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(email)
                      setAddrCopied(true)
                      window.setTimeout(() => setAddrCopied(false), 1600)
                    } catch {
                      setAddrCopied(false)
                    }
                  }}
                >
                  {addrCopied ? ICONS.check : ICONS.copy}
                </button>
              )}
            </div>
          </label>
          <label className={styles.loginField}>
            <span>Password</span>
            <div className={styles.pwWrap}>
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" className={styles.pwToggle} onClick={() => setShowPassword(show => !show)}>
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {loginError && (
            <div className={styles.loginErrorBox} role="alert">
              <p className={styles.loginError}>{loginError}</p>
              {loginDetail && (
                <>
                  <button
                    type="button"
                    className={styles.loginDetailToggle}
                    onClick={() => setLoginDetailOpen(open => !open)}
                    aria-expanded={loginDetailOpen}
                  >
                    {loginDetailOpen ? 'Hide details' : 'View more'}
                  </button>
                  {loginDetailOpen && <pre className={styles.loginDetail}>{loginDetail}</pre>}
                </>
              )}
            </div>
          )}
          <button type="submit" className={styles.loginBtn} disabled={loginBusy}>
            {loginBusy ? <><span className={styles.loginSpinner} aria-hidden />Signing in…</> : 'Sign in'}
          </button>
          <button type="button" className={styles.loginTextLink} onClick={() => { setResetMode(true); setLoginError('') }}>
            Forgot password?
          </button>
        </form>
      </div>
    )
  }

  const toggleThreadMsg = (message: InboundEmail) => {
    const isOpen = threadExpanded.has(message.id)
    if (!isOpen && !message.read) setInboundFlag([message.id], { read: true })
    setThreadExpanded(isOpen ? new Set() : new Set([message.id]))
  }

  /** Only some kinds open in the lightbox; a zip has nothing to show, so it only downloads. */
  const previewable = (attachment: DownloadAttachment) =>
    ['image', 'pdf', 'text', 'video', 'audio'].includes(attachmentKind(attachment.filename))

  // Attachment strip: thumbnail (images) or typed card, each with Preview + Download.
  const renderAttachmentTiles = (fullList: DownloadAttachment[]) => {
    const embedded = fullList.filter(isEmbeddedImage)
    const embeddedKey = embedded[0]?.downloadUrl ?? embedded[0]?.filename ?? ''
    const list = embedded.length && !showEmbedded[embeddedKey]
      ? fullList.filter(entry => !isEmbeddedImage(entry))
      : fullList
    // A share is a page behind a password, not bytes we can put in the lightbox.
    const ready: PreviewItem[] = list
      .filter(entry => entry.downloadUrl && !entry.shareId)
      .map(entry => ({
        filename: entry.filename,
        url: entry.downloadUrl,
        size: entry.size,
        contentType: entry.contentType,
      }))
    return (
      <div className={styles.attachGrid}>
        {list.map((attachment, index) => {
          const kind = attachmentKind(attachment.filename)
          const usable = Boolean(attachment.downloadUrl) && !attachment.shareId
          const previewIndex = ready.findIndex(entry => entry.url === attachment.downloadUrl)
          return (
            <div key={`${attachment.filename}-${index}`} className={styles.attachTile}>
              <button
                type="button"
                className={styles.attachThumb}
                disabled={!usable && !attachment.shareId}
                title={usable || attachment.shareId ? undefined : 'This file is no longer stored'}
                onClick={() =>
                  attachment.shareId
                    ? window.open(attachment.downloadUrl, '_blank', 'noopener')
                    : usable && setPreview({ items: ready, index: Math.max(0, previewIndex) })
                }
                aria-label={attachment.shareId ? `Open ${attachment.filename}` : `Preview ${attachment.filename}`}
              >
                {usable && kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attachment.downloadUrl} alt={attachment.filename} loading="lazy" />
                ) : (
                  <span className={styles.attachGlyph}>
                    {kind === 'pdf' ? 'PDF'
                      : kind === 'text' ? 'TXT'
                      : kind === 'video' ? ICONS.play
                      : kind === 'audio' ? ICONS.music
                      : ICONS.file}
                  </span>
                )}
              </button>
              <div className={styles.attachInfo}>
                <span className={styles.attachName} title={attachment.filename}>{attachment.filename}</span>
                <span className={styles.attachMeta}>
                  {attachment.size ? formatSize(attachment.size) : null}
                  {attachment.shareId ? `${attachment.size ? ' · ' : ''}shared link` : null}
                </span>
              </div>
              <div className={styles.attachActions}>
                {attachment.shareId ? (
                  <a className={styles.attachAction} href={attachment.downloadUrl} target="_blank" rel="noopener noreferrer">
                    Open link
                  </a>
                ) : usable ? (
                  <>
                    {previewable(attachment) && (
                      <button
                        type="button"
                        className={styles.attachAction}
                        onClick={() => setPreview({ items: ready, index: Math.max(0, previewIndex) })}
                      >
                        Preview
                      </button>
                    )}
                    <a className={styles.attachAction} href={attachment.downloadUrl} target="_blank" rel="noopener noreferrer">
                      Download
                    </a>
                  </>
                ) : (
                  // No bytes and no link: say so, rather than offer a button that does nothing.
                  <span className={styles.attachGone}>Not available</span>
                )}
              </div>
            </div>
          )
        })}
        {embedded.length > 0 && (
          <button
            type="button"
            className={styles.attachEmbeddedNote}
            onClick={() => setShowEmbedded(current => ({ ...current, [embeddedKey]: !current[embeddedKey] }))}
          >
            {showEmbedded[embeddedKey]
              ? `Hide ${embedded.length} embedded image${embedded.length === 1 ? '' : 's'}`
              : `${embedded.length} embedded image${embedded.length === 1 ? '' : 's'} from the signature — show`}
          </button>
        )}
      </div>
    )
  }

  const toggleAttachPreview = (uid?: string) =>
    setAttachExpanded(current => (current === uid ? null : uid ?? null))

  /** Files off the clipboard attach exactly as dropped ones do. Returns whether any were taken. */
  const pasteAttachments = (event: React.ClipboardEvent): boolean => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.size > 0)
    if (!files.length) return false
    event.preventDefault()
    const carrier = new DataTransfer()
    files.forEach(file => carrier.items.add(file))
    void onPickFiles(carrier.files)
    return true
  }

  const copyAttachment = async (attachment: Attachment) => {
    const file = attachment.file
    if (!file) return
    try {
      let blob: Blob = file
      // Browsers accept only PNG on the clipboard, so anything else is redrawn first.
      if (file.type !== 'image/png') {
        const bitmap = await createImageBitmap(file)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(out => (out ? resolve(out) : reject(new Error('Could not convert the image'))), 'image/png'),
        )
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setAttachCopied({ uid: attachment.uid ?? '', ok: true })
    } catch {
      setAttachCopied({ uid: attachment.uid ?? '', ok: false })
    }
    window.setTimeout(() => setAttachCopied(null), 1800)
  }

  const renderAttachChip = (attachment: Attachment, index: number, withExtras: boolean) => {
    const extension = (attachment.filename.split('.').pop() ?? '').slice(0, 4).toUpperCase()
    const open = attachExpanded === attachment.uid && Boolean(attachment.preview)
    const state = attachment.error
      ? attachment.error
      : attachment.uploading
        ? `${attachment.progress ?? 0}%`
        : attachment.uploaded
          ? 'Uploaded'
          : formatBytes(attachment.size)
    return (
      <span
        key={attachment.uid ?? `${attachment.filename}-${index}`}
        className={`${styles.attachChip} ${attachment.uploading ? styles.attachChipBusy : ''} ${attachment.error ? styles.attachChipBad : ''} ${attachment.uploaded ? styles.attachChipDone : ''} ${open ? styles.attachChipOpen : ''}`}
      >
        {attachment.uploading && (
          <span
            className={styles.attachProgress}
            style={{ transform: `scaleX(${(attachment.progress ?? 0) / 100})` }}
            aria-hidden
          />
        )}
        <span
          className={`${styles.attachChipRow} ${attachment.preview ? styles.attachChipRowOpens : ''}`}
          onClick={event => {
            // The row is the target, but the controls sitting in it keep their own jobs.
            if (!attachment.preview || (event.target as HTMLElement).closest('button')) return
            toggleAttachPreview(attachment.uid)
          }}
        >
          {attachment.preview ? (
            <button
              type="button"
              className={`${styles.attachThumb} ${styles.attachThumbBtn} ${attachment.uploading ? styles.attachThumbBusy : ''}`}
              aria-expanded={open}
              title={open ? 'Hide the image' : 'Show the image'}
              onClick={() => toggleAttachPreview(attachment.uid)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.preview} alt="" />
            </button>
          ) : (
            <span className={styles.attachThumb} aria-hidden>
              <span className={styles.attachThumbExt}>{extension || 'FILE'}</span>
            </span>
          )}
          <span className={styles.attachChipName} title={attachment.filename}>{attachment.filename}</span>
          <span className={styles.attachChipSize}>{state}</span>
          {attachment.error && attachment.file && (
            <button type="button" className={styles.attachRetry} onClick={() => retryUpload(attachment)}>
              Retry
            </button>
          )}
          {withExtras && !attachment.uploading && !attachment.error && attachment.shareId && (
            <>
              <span className={styles.attachLink} title="Sent as a download link, not an attachment">
                link
              </span>
              <button
                type="button"
                className={`${styles.attachLock} ${attachment.password ? styles.attachLockOn : ''}`}
                onClick={() => { setLockValue(attachment.password ?? ''); setLockTarget(index) }}
              >
                {attachment.password ? 'Password set' : 'Add password'}
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.attachChipDrop}
            aria-label={`Remove ${attachment.filename}`}
            onClick={() => setAttachments(list => list.filter(entry => entry !== attachment))}
          >
            ×
          </button>
        </span>
        {attachment.preview && (
          <span className={styles.attachChipShot}>
            <span className={styles.attachChipShotInner}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={attachment.preview} alt={attachment.filename} />
              {attachment.uploading && (
                <span className={styles.attachShotVeil}>
                  <span className={styles.attachShotRing} aria-hidden />
                  <span className={styles.attachShotPct}>{attachment.progress ?? 0}%</span>
                </span>
              )}
              {attachment.file && (
                <button
                  type="button"
                  className={`${styles.attachShotCopy} ${attachCopied && attachCopied.uid === attachment.uid && !attachCopied.ok ? styles.attachShotCopyBad : ''}`}
                  onClick={() => void copyAttachment(attachment)}
                >
                  {attachCopied && attachCopied.uid === attachment.uid ? (attachCopied.ok ? 'Copied' : 'Blocked') : 'Copy'}
                </button>
              )}
              <span className={styles.attachShotFoot}>{formatBytes(attachment.size)}</span>
            </span>
          </span>
        )}
      </span>
    )
  }

  const renderInboundAttachments = (message: InboundEmail) => {
    if (!message.attachments.length) return null
    // The stored-blob lookup answers with an empty array for anything it does not
    // hold, which is every file sent as a share link. Falling back only on null
    // left the header counting attachments the grid then refused to draw.
    const fetched = inboundAttachments[message.id]
    const list: DownloadAttachment[] = fetched?.length
      ? fetched
      : message.attachments.map(entry => ({
          filename: entry.filename,
          size: entry.size ?? 0,
          downloadUrl: entry.shareId ? `/share/${entry.shareId}` : '',
          shareId: entry.shareId,
        }))
    return renderAttachmentTiles(list)
  }

  const renderInboundBody = (message: InboundEmail, framed: boolean) => {
    if (readerMode === 'plain') {
      return <pre className={styles.readerText}>{message.text?.trim() || htmlToSnippetText(message.html, null) || '(no text part)'}</pre>
    }
    if (readerMode === 'html') return <pre className={styles.readerSource}>{formatHtmlSource(message.html ?? '')}</pre>
    if (readerMode === 'raw') return <pre className={styles.readerSource}>{rawInboundMessage(message)}</pre>
    // preview
    if (!message.html) return <pre className={styles.readerText}>{message.text ?? '(no content)'}</pre>
    if (framed) {
      // Thread messages auto-size to content (whole conversation scrolls as one).
      // sandbox omits allow-scripts, so no email JS runs; CSP still blocks fetches.
      return (
        <iframe
          className={styles.threadFrame}
          sandbox="allow-same-origin"
          srcDoc={frameHtml(message.html, showRemote)}
          title="Email content"
          onLoad={event => {
            try {
              const doc = event.currentTarget.contentDocument
              if (doc) event.currentTarget.style.height = `${Math.min(1600, doc.documentElement.scrollHeight + 8)}px`
            } catch {}
          }}
        />
      )
    }
    return <iframe className={styles.readerFrame} sandbox="" srcDoc={frameHtml(message.html, showRemote)} title="Email content" />
  }

  // One message open at a time — opening another collapses the rest.
  const toggleExpanded = (id: string) => {
    setThreadExpanded(prev => (prev.has(id) ? new Set() : new Set([id])))
  }

  const renderSentBody = (sent: SentEmail) => {
    const detail = detailCache[sent.id]
    if (!detail) return <div className={styles.threadPending}>Loading message…</div>
    if (detail.html && detail.html.trim()) {
      return (
        <iframe
          className={styles.threadFrame}
          sandbox="allow-same-origin"
          srcDoc={frameHtml(detail.html, true)}
          title="Sent email"
          onLoad={event => {
            try {
              const doc = event.currentTarget.contentDocument
              if (doc) event.currentTarget.style.height = `${Math.min(1600, doc.documentElement.scrollHeight + 8)}px`
            } catch {}
          }}
        />
      )
    }
    return <pre className={styles.readerText}>{detail.text?.trim() || '(no content)'}</pre>
  }

  /** What we attached to a message we sent. The inbound side has always shown these. */
  const renderSentAttachments = (sent: SentEmail) => {
    const list = detailCache[sent.id]?.attachments ?? []
    return list.length ? renderAttachmentTiles(list) : null
  }

  // Bubble body: just the new message text (quoted history + signature stripped) with any
  // real images shown on top, like a chat message.
  // Queue any URLs we haven't judged yet for a reputation check; heuristics render instantly.
  // Plain function (not a hook) — it lives below an early return and is called through a ref.
  const scanLinks = (urls: string[]) => {
    const pending = urls.filter(url => !linkVerdicts[url])
    if (!pending.length) return
    setLinkVerdicts(current => {
      const next = { ...current }
      for (const url of pending) next[url] = inspectUrl(url)
      return next
    })
    fetch('/api/mail/link-check', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ links: pending.map(url => ({ url })) }),
    })
      .then(response => response.json())
      .then(data => {
        if (!data?.ok || !data.results) return
        setLinkVerdicts(current => ({ ...current, ...data.results }))
      })
      .catch(() => {})
  }

  scanLinksRef.current = scanLinks

  // Turn bare URLs in plain-text bodies into real links, flagged by their safety verdict.
  const linkifyText = (body: string) => {
    // Cap the alternation: a sender controls how many URLs land here, and an
    // unbounded pattern turns a crafted message into a tab-hanging split().
    const urls = extractUrls(body).slice(0, 200)
    if (!urls.length) return body
    const pattern = new RegExp(`(${urls.map(url => url.replace(/^https:\/\/(?=www\.)/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    return body.split(pattern).map((chunk, index) => {
      if (!chunk) return null
      const match = urls.find(url => url === chunk || url === `https://${chunk}`)
      if (!match) return <Fragment key={index}>{chunk}</Fragment>
      const judged = linkVerdicts[match] ?? inspectUrl(match)
      const danger = judged.verdict === 'dangerous'
      const warn = judged.verdict === 'suspicious'
      return (
        <a
          key={index}
          href={match}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={`${styles.msgLink} ${danger ? styles.msgLinkBad : warn ? styles.msgLinkWarn : ''}`}
          title={judged.reasons.length ? judged.reasons.join(' · ') : match}
          onClick={event => {
            if (!danger) return
            // The dialog resolves after the click, so the navigation is cancelled
            // here and re-issued only once the answer is in.
            event.preventDefault()
            void confirm({
              title: 'This link looks unsafe',
              body: (
                <>
                  {judged.reasons.join(' · ')}
                  <br />
                  Only open it if you were expecting it from this sender.
                </>
              ),
              confirmLabel: 'Open anyway',
              danger: true,
            }).then(agreed => {
              if (agreed) window.open(match, '_blank', 'noopener,noreferrer')
            })
          }}
        >
          {chunk}
          {(danger || warn) && (
            <span className={danger ? styles.linkBadgeBad : styles.linkBadgeWarn}>
              <span className={styles.linkBadgeIcon}>{ICONS.alert}</span>
              {danger ? 'unsafe' : 'check'}
            </span>
          )}
        </a>
      )
    })
  }

  const renderBubbleBody = (html: string | null, text: string | null) => {
    const images = extractBubbleImages(html)
    const body = cleanBubbleText(html, text)
    return (
      <div className={styles.bubbleContent}>
        {images.length > 0 && (
          <div className={styles.bubbleImages}>
            {images.map((src, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={index} className={styles.bubbleImg} src={src} alt="" loading="lazy" />
            ))}
          </div>
        )}
        {body ? (
          <div className={styles.bubbleText}>{linkifyText(body)}</div>
        ) : (
          images.length === 0 && <div className={styles.bubbleText}>(no text)</div>
        )}
      </div>
    )
  }

  // One message in a conversation (inbound or our sent reply) — shared by list + bubble layouts.
  const renderThreadMessage = (item: ThreadItem, open: boolean, layout: 'list' | 'bubbles') => {
    const mine = item.kind === 'sent'
    const from = mine ? 'You' : parseAddress(item.inbound.from)
    const initial = (mine ? 'N' : parseAddress(item.inbound.from)[0] ?? '?').toUpperCase()
    const when = mine ? item.sent.createdAt : item.inbound.receivedAt
    const detail = mine ? detailCache[item.sent.id] : null
    const snippet = (
      mine ? (detail ? htmlToSnippetText(detail.html, detail.text) : item.sent.subject) : htmlToSnippetText(item.inbound.html, item.inbound.text)
    ).slice(0, 100)
    const unread = !mine && !item.inbound.read
    const hasAttach = mine ? (detail?.attachments?.length ?? 0) > 0 : item.inbound.attachments.length > 0
    const shellClass =
      layout === 'bubbles'
        ? `${styles.bubble} ${mine ? styles.bubbleOut : styles.bubbleIn} ${open ? styles.bubbleOpen : ''}`
        : `${styles.threadMsg} ${open ? styles.threadMsgOpen : ''}`
    // Body stays mounted once opened so collapsing animates too, instead of snapping shut.
    const toggleOpen = () => {
      setThreadEverOpen(current => (current.has(item.id) ? current : new Set(current).add(item.id)))
      if (mine) toggleExpanded(item.id)
      else toggleThreadMsg(item.inbound)
    }
    return (
      <div key={item.id} className={shellClass}>
        {/* A container rather than a button: the print control has to sit in this row beside
            the attachment mark, and a button cannot hold another button. */}
        <div
          className={styles.threadMsgHead}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={toggleOpen}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              toggleOpen()
            }
          }}
        >
          <span className={styles.avatar}>{initial}</span>
          <span className={styles.threadMsgMeta}>
            <span className={styles.threadMsgFrom}>
              {unread && <span className={styles.unreadDot} />}
              {from}
            </span>
            {!open && <span className={styles.threadMsgSnippet}>{snippet}</span>}
          </span>
          {hasAttach && (
            <span className={styles.threadMsgTool} title="Carries an attachment" aria-label="Carries an attachment">
              {ICONS.attach}
            </span>
          )}
          {/* Printing one message out of a conversation, which is how a claim or a renewal
              gets filed. */}
          {open && (
          <button
            type="button"
            className={`${styles.threadMsgTool} ${styles.threadMsgToolBtn}`}
            title="Print this message"
            aria-label="Print this message"
            onClick={event => {
              event.stopPropagation()
              if (mine) {
                printMessage(
                  item.sent.subject,
                  detail?.from ?? item.sent.from,
                  item.sent.createdAt,
                  detail?.html ?? null,
                  detail?.text ?? null,
                  { to: item.sent.to, cc: detail?.cc ?? item.sent.cc },
                )
              } else {
                printMessage(
                  item.inbound.subject,
                  item.inbound.from,
                  item.inbound.receivedAt,
                  item.inbound.html,
                  item.inbound.text,
                  { to: item.inbound.to, cc: item.inbound.cc },
                )
              }
            }}
          >
            {ICONS.print}
          </button>
          )}
          <span className={styles.threadMsgDate}>{formatRelative(when, now)}</span>
          <span className={styles.threadChevron} aria-hidden>{ICONS.chevron}</span>
        </div>
        {(open || threadEverOpen.has(item.id)) && (
          <div className={`${styles.threadMsgWrap} ${open ? styles.threadMsgWrapOpen : ''}`}>
          <div className={styles.threadMsgBody}>
            {layout === 'bubbles' ? (
              mine && !detail ? (
                <div className={styles.threadPending}>Loading message…</div>
              ) : (
                renderBubbleBody(mine ? detail?.html ?? null : item.inbound.html, mine ? detail?.text ?? null : item.inbound.text)
              )
            ) : mine ? (
              <>
                {renderSentBody(item.sent)}
                {renderSentAttachments(item.sent)}
              </>
            ) : (
              <>
                {renderInboundBody(item.inbound, true)}
                {renderInboundAttachments(item.inbound)}
              </>
            )}
          </div>
          </div>
        )}
      </div>
    )
  }

  const reader = (() => {
    if (threadOpening) return <ReaderSkeleton />
    if (selectedInbound) {
      const inbound = selectedInbound
      const inboundMembers = threadMembers(inbound.id)
      const unified = unifiedThread(inbound.id)
      const isThread = unified.length > 1
      const remoteRefs = inboundMembers.reduce((total, message) => total + countRemoteRefs(message.html), 0)
      return (
        <>
          <div className={styles.readerHead}>
            <div className={styles.readerTitleRow}>
              <h2 className={styles.readerSubject}>
                {inbound.subject}
                {isThread && <span className={styles.threadCount}>{unified.length}</span>}
              </h2>
              <button
                className={`${styles.iconBtn} ${inbound.starred ? styles.iconBtnStarOn : ''}`}
                title={inbound.starred ? 'Unstar' : 'Star'}
                onClick={() => setInboundFlag(threadIds(inbound.id), { starred: !inbound.starred })}
              >
                {ICONS.star}
              </button>
            </div>
            {inbound.labels.length > 0 && (
              <div className={styles.readerLabels}>
                {inbound.labels.map(labelId => {
                  const label = LABEL_BY_ID.get(labelId)
                  if (!label) return null
                  return (
                    <span
                      key={labelId}
                      className={styles.labelPill}
                      style={{ color: label.color, borderColor: label.color } as React.CSSProperties}
                    >
                      {label.name}
                      <button
                        type="button"
                        aria-label={`Remove ${label.name}`}
                        onClick={() => toggleLabel(inbound.id, labelId)}
                      >
                        ×
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            <div className={styles.readerMeta}>
              <div className={styles.avatar}>{(parseAddress(inbound.from)[0] ?? '?').toUpperCase()}</div>
              <div className={styles.readerMetaText}>
                <div className={styles.readerFrom}>{inbound.from}</div>
                <div className={styles.readerTo}>to {inbound.to.join(', ') || 'you'}</div>
                {inbound.cc.length > 0 && <div className={styles.readerTo}>cc {inbound.cc.join(', ')}</div>}
              </div>
              <div className={styles.readerDate}>
                {new Date(inbound.receivedAt).toLocaleString()}
                <button className={styles.headerToggle} onClick={() => setShowFullHeaders(open => !open)}>
                  {showFullHeaders ? 'Hide details' : 'Details'}
                </button>
              </div>
            </div>
            {showFullHeaders && (
              <dl className={styles.fullHeaders}>
                <div><dt>From</dt><dd>{inbound.from}</dd></div>
                <div><dt>To</dt><dd>{inbound.to.join(', ') || '—'}</dd></div>
                {inbound.cc.length > 0 && <div><dt>Cc</dt><dd>{inbound.cc.join(', ')}</dd></div>}
                {inbound.bcc.length > 0 && <div><dt>Bcc</dt><dd>{inbound.bcc.join(', ')}</dd></div>}
                {inbound.replyTo.length > 0 && <div><dt>Reply-To</dt><dd>{inbound.replyTo.join(', ')}</dd></div>}
                <div><dt>Date</dt><dd>{new Date(inbound.receivedAt).toUTCString()}</dd></div>
                <div><dt>Message ID</dt><dd>{headerValue(inbound, 'message-id') || inbound.id}</dd></div>
                {!plainSpoken && authSummary(inbound) && <div><dt>Security</dt><dd>{authSummary(inbound)}</dd></div>}
                {inbound.labels.length > 0 && <div><dt>Labels</dt><dd>{inbound.labels.join(', ')}</dd></div>}
              </dl>
            )}
          </div>
          <div className={styles.actions}>
            <button className={styles.actionBtn} onClick={() => replyTo(inbound)}>
              {ICONS.reply} Reply
            </button>
            {!settings.replyAllDefault && (
              <button className={styles.actionBtn} onClick={() => replyAllTo(inbound)}>
                {ICONS.replyAll} Reply all
              </button>
            )}
            <button className={styles.actionBtn} onClick={() => forwardEmail(inbound.subject, inbound.html, inbound.text, inbound.id)}>
              {ICONS.forward} Forward
            </button>
            <span className={styles.actionSpacer} />
            <span className={styles.labelWrap}>
              <button
                className={`${styles.iconBtn} ${labelMenuOpen ? styles.iconBtnOn : ''}`}
                title="Label"
                onClick={() => setLabelMenuOpen(open => !open)}
              >
                {ICONS.tag}
              </button>
              {labelMenuOpen && (
                <div className={styles.labelMenu}>
                  {LABELS.map(label => {
                    const applied = inbound.labels.includes(label.id)
                    return (
                      <button
                        key={label.id}
                        type="button"
                        className={`${styles.labelOption} ${applied ? styles.labelOptionOn : ''}`}
                        onClick={() => toggleLabel(inbound.id, label.id)}
                      >
                        <span className={styles.labelDot} style={{ background: label.color } as React.CSSProperties} />
                        {label.name}
                        {applied && <span className={styles.labelCheck}>✓</span>}
                      </button>
                    )
                  })}
                </div>
              )}
            </span>
            {folder !== 'trash' && (
              <button
                className={styles.iconBtn}
                title={inbound.archived ? 'Move to inbox' : 'Archive'}
                onClick={() => {
                  setInboundFlag(threadIds(inbound.id), { archived: !inbound.archived })
                  setSelectedId(null)
                  setReaderOpenMobile(false)
                }}
              >
                {inbound.archived ? ICONS.restore : ICONS.archive}
              </button>
            )}
            {inbound.threadId && (() => {
              // A snooze that has already come round leaves its timestamp behind, since
              // nothing runs to clear it. Asleep means the time is still ahead, which is
              // what every folder query asks too.
              const wakesAt = inbound.snoozedUntil ? Date.parse(inbound.snoozedUntil) : 0
              const asleep = wakesAt > Date.now()
              return (
              <span className={styles.snoozeWrap}>
                <button
                  className={`${styles.iconBtn} ${snoozeMenuOpen ? styles.iconBtnOn : ''}`}
                  title={
                    asleep
                      ? `Snoozed until ${new Date(wakesAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} — wake it now`
                      : 'Snooze'
                  }
                  aria-haspopup="menu"
                  aria-expanded={snoozeMenuOpen}
                  onClick={() => {
                    if (asleep) applySnooze(inbound.threadId ?? null, null)
                    else setSnoozeMenuOpen(open => !open)
                  }}
                >
                  {ICONS.snooze}
                </button>
                {snoozeMenuOpen && (
                  <div className={styles.snoozeMenu} role="menu">
                    {snoozeChoices.map(choice => (
                      <button
                        key={choice.key}
                        role="menuitem"
                        className={styles.snoozeItem}
                        onClick={() => applySnooze(inbound.threadId ?? null, choice.at)}
                      >
                        <span>{choice.label}</span>
                        <span className={styles.snoozeWhen}>
                          {choice.at.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </span>
              )
            })()}
            <button
              className={styles.iconBtn}
              title={inbound.read ? 'Mark unread' : 'Mark read'}
              onClick={() => setInboundFlag(threadIds(inbound.id), { read: !inbound.read })}
            >
              {ICONS.unread}
            </button>
            {folder === 'trash' ? (
              <button
                className={styles.iconBtn}
                title="Restore"
                onClick={() => {
                  setInboundFlag(threadIds(inbound.id), { trashed: false })
                  setSelectedId(null)
                }}
              >
                {ICONS.restore}
              </button>
            ) : (
              <button
                className={styles.iconBtn}
                title="Delete"
                onClick={() => {
                  setInboundFlag(threadIds(inbound.id), { trashed: true })
                  setSelectedId(null)
                  setReaderOpenMobile(false)
                }}
              >
                {ICONS.trash}
              </button>
            )}
            <button className={styles.iconBtn} title="Print" onClick={() => printMessage(inbound.subject, inbound.from, inbound.receivedAt, inbound.html, inbound.text, { to: inbound.to, cc: inbound.cc })}>
              {ICONS.print}
            </button>
            <button className={styles.iconBtn} title="Download .eml" onClick={() => downloadEml(inbound)}>
              {ICONS.download}
            </button>
          </div>
          <div className={styles.readerModeBar}>
            <div className={styles.readerModeTabs}>
              {(([
                ['preview', 'Preview'],
                ['plain', 'Plain text'],
                ['html', 'HTML'],
                ['raw', 'Raw'],
              ] as const).filter(([mode]) => !plainSpoken || mode === 'preview' || mode === 'plain')).map(([mode, label]) => (
                <button
                  key={mode}
                  className={`${styles.modeTab} ${readerMode === mode ? styles.modeTabActive : ''}`}
                  onClick={() => setReaderMode(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={styles.readerLayoutTabs}>
              <button
                className={`${styles.modeTab} ${readerLayout === 'list' ? styles.modeTabActive : ''}`}
                onClick={() => chooseLayout('list')}
                title="Conversation list"
              >
                Conversation
              </button>
              <button
                className={`${styles.modeTab} ${readerLayout === 'bubbles' ? styles.modeTabActive : ''}`}
                onClick={() => chooseLayout('bubbles')}
                title="Chat bubbles"
              >
                Bubbles
              </button>
              {isThread && readerLayout === 'list' && (
                <>
                  <span className={styles.orderDivider} />
                  <button
                    className={styles.orderToggle}
                    onClick={() => setThreadOrder(current => (current === 'newest' ? 'oldest' : 'newest'))}
                    title={threadOrder === 'newest' ? 'Newest first — click for oldest first' : 'Oldest first — click for newest first'}
                  >
                    {threadOrder === 'newest' ? '↓ Newest' : '↑ Oldest'}
                  </button>
                </>
              )}
            </div>
          </div>
          {remoteRefs > 0 && !showRemote && readerMode === 'preview' && (
            <div className={styles.remoteBanner}>
              {ICONS.image}
              <span>Remote images blocked ({remoteRefs}) to protect against tracking.</span>
              <button className={styles.remoteShow} onClick={() => setShowRemote(true)}>
                Show images
              </button>
            </div>
          )}
          {isThread || readerLayout === 'bubbles' ? (
            <div className={readerLayout === 'bubbles' ? styles.bubbles : styles.thread}>
              {/* Bubbles stay chronological — a chat reads oldest to newest. */}
              {(readerLayout === 'bubbles' || threadOrder === 'oldest' ? unified : [...unified].reverse()).map(item =>
                renderThreadMessage(item, threadExpanded.has(item.id), readerLayout),
              )}
            </div>
          ) : (
            <div className={styles.readerBodyWrap}>
              <div
                className={styles.readerBody}
                style={attachBarHeight ? { marginBottom: attachBarHeight + 22 } : undefined}
              >
                {renderInboundBody(inbound, false)}
              </div>
              {inbound.attachments.length > 0 &&
                (attachBar === 'closed' ? (
                  <div className={styles.attachPillWrap} ref={attachBarRef}>
                    <button
                      type="button"
                      className={styles.attachPill}
                      onClick={() => setAttachBar('open')}
                      title="Show attachments"
                    >
                      {ICONS.attach} {inbound.attachments.length}
                    </button>
                  </div>
                ) : (
                  <div className={styles.attachFloat} ref={attachBarRef}>
                    <div className={styles.attachFloatHead}>
                      <button
                        type="button"
                        className={styles.attachFloatToggle}
                        onClick={() => setAttachBar(attachBar === 'open' ? 'collapsed' : 'open')}
                        title={attachBar === 'open' ? 'Collapse attachments' : 'Expand attachments'}
                        aria-expanded={attachBar === 'open'}
                      >
                        <span
                          className={`${styles.attachFloatChevron} ${attachBar === 'open' ? styles.attachFloatChevronOpen : ''}`}
                          aria-hidden
                        >
                          {ICONS.chevron}
                        </span>
                        <span className={styles.attachFloatTitle}>
                          {inbound.attachments.length} attachment{inbound.attachments.length > 1 ? 's' : ''}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.attachFloatClose}
                        onClick={() => setAttachBar('closed')}
                        title="Hide attachments"
                        aria-label="Hide attachments"
                      >
                        ✕
                      </button>
                    </div>
                    {attachBar === 'open' && (
                      <div className={styles.attachFloatBody}>{renderInboundAttachments(inbound)}</div>
                    )}
                  </div>
                ))}
            </div>
          )}
          {folder !== 'trash' && (() => {
            if (isPhone) {
              return (
                <div className={styles.replyLaunch}>
                  <button type="button" className={styles.replyLaunchBtn} onClick={() => openReplyPage(inbound)}>
                    {ICONS.reply}
                    <span>{quickReply.trim() ? quickReply.trim().slice(0, 60) : `Reply${settings.replyAllDefault ? ' to everyone' : ''}…`}</span>
                  </button>
                  {!settings.replyAllDefault && (
                    <button
                      type="button"
                      className={styles.replyLaunchAll}
                      title="Reply all"
                      aria-label="Reply all"
                      onClick={() => { replyAllTo(inbound); setComposeExpanded(true) }}
                    >
                      {ICONS.replyAll}
                    </button>
                  )}
                </div>
              )
            }
            const replyDraft = buildReplyDraft(inbound)
            const replyEffHtml = buildEmailHtml(replyDraft, signatureHtml, fontCss, defaultFont)
            const replyEffText = buildEmailText(replyDraft, signatureText)
            const replyRaw = [
              `To: ${replyDraft.to.join(', ') || '—'}`,
              `Subject: ${replyDraft.subject}`,
              replyDraft.inReplyTo ? `In-Reply-To: <${replyDraft.inReplyTo.replace(/[<>]/g, '')}>` : null,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=utf-8',
              '',
              replyEffHtml,
            ].filter(line => line !== null).join('\n')
            const canSend = (quickReply.trim() || (replyHtmlDirty && replyHtml.trim())) && !quickSending
            const recipSummary = [
              `To ${replyDraft.to.join(', ') || '—'}`,
              replyDraft.cc.length ? `Cc ${replyDraft.cc.length}` : null,
              replyDraft.bcc.length ? `Bcc ${replyDraft.bcc.length}` : null,
            ].filter(Boolean).join('  ·  ')
            return (
            <div
              className={`${styles.quickReplyBar} ${dragState !== 'idle' ? styles.quickReplyBarArmed : ''} ${dragState === 'over' ? styles.quickReplyBarOver : ''}`}
              onDragEnter={event => {
                if (Array.from(event.dataTransfer.types).includes('Files')) setDragState('over')
              }}
              onDragOver={event => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                setDragState('over')
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragState(dragDepth.current > 0 ? 'armed' : 'idle')
                }
              }}
              onDrop={event => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                dragDepth.current = 0
                setDragState('idle')
                void onPickFiles(event.dataTransfer.files)
              }}
            >
              {dragState !== 'idle' && (
                <div className={`${styles.dropVeil} ${dragState === 'over' ? styles.dropVeilOver : ''}`}>
                  <div className={styles.dropVeilInner}>
                    {ICONS.attach}
                    <strong>{dragState === 'over' ? 'Release to attach' : 'Drop files to attach'}</strong>
                    <span>They go out with this reply</span>
                  </div>
                </div>
              )}
              <div className={styles.replyRecips}>
                <div className={`${styles.replyRecipsHead} ${replyRecipsOpen ? styles.replyRecipsHeadOpen : ''}`}>
                  <button
                    type="button"
                    className={styles.replyRecipsToggle}
                    onClick={() => toggleReplyRecips(inbound)}
                    title="Recipients — Cc, Bcc"
                  >
                    <span className={styles.replyRecipsChevron}>{ICONS.chevron}</span>
                    <span className={styles.replyRecipsSummary}>{recipSummary}</span>
                  </button>
                </div>
                {replyRecipsOpen && (
                  <div className={styles.replyRecipsFields}>
                    <div className={styles.replyRecipRow}>
                      <span className={styles.replyRecipLabel}>To</span>
                      <ChipField chips={replyToList} onChange={next => { setReplyRecipsEdited(true); setReplyToList(next) }} placeholder="someone@example.com" suggest={suggestContacts} />
                    </div>
                    <div className={styles.replyRecipRow}>
                      <span className={styles.replyRecipLabel}>Cc</span>
                      <ChipField chips={replyCc} onChange={next => { setReplyRecipsEdited(true); setReplyCc(next) }} placeholder="cc@example.com" suggest={suggestContacts} />
                    </div>
                    <div className={styles.replyRecipRow}>
                      <span className={styles.replyRecipLabel}>Bcc</span>
                      <ChipField chips={replyBcc} onChange={next => { setReplyRecipsEdited(true); setReplyBcc(next) }} placeholder="bcc@example.com" suggest={suggestContacts} />
                    </div>
                  </div>
                )}
              </div>
              <div className={styles.replyToolbar}>
                <button className={styles.toolBtn} onClick={() => insertReply('**bold**')} title="Bold" type="button">B</button>
                <button className={styles.toolBtn} onClick={() => insertReply('*italic*')} title="Italic" type="button"><em>I</em></button>
                <button className={styles.toolBtn} onClick={() => insertReply('\n## Heading\n')} title="Heading" type="button">H2</button>
                <button className={styles.toolBtn} onClick={() => insertReply('\n- item one\n- item two\n')} title="List" type="button">••</button>
                <button className={styles.toolBtn} onClick={() => insertReply('[link text](https://)')} title="Link" type="button">↗</button>
                <button className={styles.toolBtn} onClick={() => insertReply('\n![alt text](https://)\n')} title="Image" type="button">IMG</button>
                <button className={styles.toolBtn} onClick={() => insertReply(`\n[button:Call to action](${CLIENT_BRAND.websiteUrl})\n`)} title="CTA button" type="button">BTN</button>
                <button className={styles.toolBtn} onClick={() => insertReply('\n---\n')} title="Divider" type="button">—</button>
                <span className={styles.toolDivider} />
                <button
                  className={`${styles.toolBtn} ${replySig ? styles.toolToggleOn : ''}`}
                  onClick={() => { setReplySig(value => !value); setReplyHtmlDirty(false) }}
                  title="Signature"
                  type="button"
                >
                  Sig
                </button>
                <div className={styles.modeTabs}>
                  {(([
                    ['write', 'Write'],
                    ['preview', 'Preview'],
                    ['plain', 'Plain text'],
                    ['html', 'HTML'],
                    ['raw', 'Raw'],
                  ] as [ReplyMode, string][]).filter(([mode]) => !plainSpoken || mode === 'write' || mode === 'preview')).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className={`${styles.modeTab} ${replyMode === mode ? styles.modeTabActive : ''}`}
                      onClick={() => {
                        if (mode === 'html' && !replyHtmlDirty) setReplyHtml(buildEmailHtml(buildReplyDraft(inbound), signatureHtml, fontCss, defaultFont))
                        setReplyMode(mode)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {replyError && (
                <p className={styles.replyError} role="alert">{replyError}</p>
              )}
              {/* The tray and the composer share one attachment list, and both are mounted at
                  once — showing the chips in both made a single file look like two. The
                  composer owns them while it is open. */}
              {!composeOpen && attachments.length > 0 && (
                <>
                  <div className={styles.replyAttachRow}>
                    {attachments.map((attachment, index) => renderAttachChip(attachment, index, false))}
                  </div>
                </>
              )}
              <div className={styles.replyInputRow}>
                <button
                  className={styles.quickReplyIcon}
                  title="More — Cc, Bcc, schedule"
                  onClick={() => openReplySettings(inbound)}
                >
                  {ICONS.sliders}
                </button>
                {/* Attaching from here rather than only after switching to the full
                    composer: a reply with a document is the ordinary case, not an
                    advanced one. */}
                <button
                  className={styles.quickReplyIcon}
                  title="Attach a file"
                  aria-label="Attach a file"
                  onClick={() => replyFileRef.current?.click()}
                >
                  {ICONS.attach}
                </button>
                <input
                  ref={replyFileRef}
                  type="file"
                  multiple
                  hidden
                  onChange={event => {
                    void onPickFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
                {replyMode === 'write' && (
                  <textarea
                    ref={quickReplyRef}
                    className={styles.quickReplyInput}
                    style={{ fontFamily: fontStack(defaultFont.family), fontSize: defaultFont.size || undefined }}
                    value={quickReply}
                    onChange={event => { setQuickReply(event.target.value); setReplyHtmlDirty(false) }}
                    onPaste={event => {
                      if (pasteAttachments(event)) return
                      const markdown = pastedMarkdown(event)
                      if (!markdown) return
                      event.preventDefault()
                      insertReply(markdown)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        sendQuickReply(inbound)
                      }
                    }}
                    placeholder={`Reply to ${parseAddress(quickReplyTarget(inbound).from) || 'sender'}…`}
                    rows={1}
                  />
                )}
                {replyMode === 'html' && (
                  <textarea
                    className={`${styles.quickReplyInput} ${styles.quickReplyHtml}`}
                    value={replyHtml}
                    onChange={event => { setReplyHtml(event.target.value); setReplyHtmlDirty(true) }}
                    onPaste={event => { pasteAttachments(event) }}
                    placeholder="Advanced: edit the message HTML directly. Changes here replace what you wrote."
                    spellCheck={false}
                  />
                )}
                {replyMode === 'preview' && (
                  // The wrapper scrolls, not the iframe: iOS expands iframes instead of
                  // scrolling them, so the frame is sized to its content on load.
                  <div className={styles.replyPreviewWrap}>
                    <iframe
                      className={styles.replyPreview}
                      sandbox="allow-same-origin"
                      srcDoc={frameHtml(replyEffHtml, true)}
                      title="Reply preview"
                      onLoad={event => {
                        try {
                          const doc = event.currentTarget.contentDocument
                          if (doc) event.currentTarget.style.height = `${Math.max(180, doc.documentElement.scrollHeight + 8)}px`
                        } catch {}
                      }}
                    />
                  </div>
                )}
                {replyMode === 'plain' && <pre className={styles.replySource}>{replyEffText || '(empty)'}</pre>}
                {replyMode === 'raw' && <pre className={styles.replySource}>{replyRaw}</pre>}
                <button
                  className={styles.quickReplySend}
                  title="Send reply (Cmd/Ctrl + Enter)"
                  disabled={!canSend}
                  onClick={() => sendQuickReply(inbound)}
                >
                  {ICONS.send}
                </button>
              </div>
                {replyMode === 'write' && replySig && signatureBody.trim() && (
                <div className={`${styles.composeSignature} ${sigExpanded ? styles.composeSignatureOpen : ''}`}>
                    <div className={styles.composeSignatureBar}>
                      <button
                        type="button"
                        className={styles.composeSignatureLabel}
                        onClick={toggleSignature}
                        aria-expanded={sigExpanded}
                      >
                        {ownSignature ? 'Signature' : 'Signature · default'}
                        <span className={styles.composeSignatureChevron} aria-hidden>{sigExpanded ? '▾' : '▸'}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.composeSignatureEdit}
                        onClick={() => { setSettingsTab('profile'); setSettingsOpen(true) }}
                      >
                        Edit
                      </button>
                    </div>
                  {signatureMarkSrc && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.composeSignatureLogo} src={signatureMarkSrc} alt="" />
                  )}
                  <div
                    className={styles.composeSignatureBody}
                    onClick={expandSignatureFromBody}
                    dangerouslySetInnerHTML={{ __html: asRichHtml(signatureBody) }}
                  />
                  <button
                    type="button"
                    className={styles.composeSignatureMore}
                    onClick={toggleSignature}
                    aria-expanded={sigExpanded}
                  >
                    {sigExpanded ? 'Show less' : 'Show full signature'}
                  </button>
                </div>
              )}
            </div>
            )
          })()}
        </>
      )
    }
    if (selectedSent) {
      const isScheduled = scheduledEmails.some(entry => entry.id === selectedSent.id)
      return (
        <>
          <div className={styles.readerHead}>
            <h2 className={styles.readerSubject}>{selectedSent.subject}</h2>
            <div className={styles.readerMeta}>
              <div className={styles.avatar}>N</div>
              <div className={styles.readerMetaText}>
                <div className={styles.readerFrom}>{selectedDetail?.from ?? selectedSent.from}</div>
                <div className={styles.readerTo}>to {selectedSent.to.join(', ')}</div>
              </div>
              <div className={styles.readerDate}>
                {isScheduled && selectedSent.scheduledAt
                  ? `sends ${new Date(selectedSent.scheduledAt).toLocaleString()}`
                  : new Date(selectedSent.createdAt).toLocaleString()}
              </div>
            </div>
          </div>
          <div className={styles.actions}>
            {isScheduled && scheduledForSelected ? (
              <>
                <span className={styles.countdownChip}>sends in {formatCountdown(scheduledForSelected - now)}</span>
                <button
                  className={styles.actionBtn}
                  onClick={() => rescheduleScheduled(selectedSent.id, new Date(Date.now() + 5000).toISOString())}
                >
                  Send now
                </button>
                <input
                  type="datetime-local"
                  className={styles.datetime}
                  onChange={event => {
                    if (event.target.value) rescheduleScheduled(selectedSent.id, new Date(event.target.value).toISOString())
                  }}
                  aria-label="Reschedule"
                />
                <button className={`${styles.actionBtn} ${styles.actionDanger}`} onClick={() => cancelScheduled(selectedSent.id)}>
                  Cancel send
                </button>
              </>
            ) : (
              <>
                <span className={styles.chip}>{statusFor(selectedSent)}</span>
                {selectedSent.opened && (
                  <span
                    className={`${styles.chip} ${styles.chipOpened}`}
                    title={`Opened${selectedSent.openCount > 1 ? ` ${selectedSent.openCount} times` : ''}${selectedSent.openedAt ? ` — first at ${new Date(selectedSent.openedAt).toLocaleString()}` : ''}`}
                  >
                    opened{selectedSent.openCount > 1 ? ` ×${selectedSent.openCount}` : ''}
                  </span>
                )}
                <button className={styles.actionBtn} onClick={() => replyToSent(selectedSent, selectedDetail, settings.replyAllDefault)}>
                  {ICONS.reply} Reply
                </button>
                {!settings.replyAllDefault && (
                  <button className={styles.actionBtn} onClick={() => replyToSent(selectedSent, selectedDetail, true)}>
                    {ICONS.replyAll} Reply all
                  </button>
                )}
                <button
                  className={styles.actionBtn}
                  onClick={() => forwardEmail(selectedSent.subject, selectedDetail?.html ?? null, selectedDetail?.text ?? null, selectedSent.id, 'sent')}
                >
                  {ICONS.forward} Forward
                </button>
                <span className={styles.actionSpacer} />
                <button
                  className={`${styles.iconBtn} ${selectedSent.starred ? styles.iconBtnOn : ''}`}
                  title={selectedSent.starred ? 'Unstar' : 'Star'}
                  onClick={() => setSentFlag([selectedSent.id], { starred: !selectedSent.starred })}
                >
                  {ICONS.star}
                </button>
                <button
                  className={styles.iconBtn}
                  title={selectedSent.archived ? 'Move to Sent' : 'Archive'}
                  onClick={() => {
                    setSentFlag([selectedSent.id], { archived: !selectedSent.archived })
                    if (!selectedSent.archived) {
                      setSelectedId(null)
                      setReaderOpenMobile(false)
                    }
                  }}
                >
                  {selectedSent.archived ? ICONS.restore : ICONS.archive}
                </button>
                {selectedSent.trashed ? (
                  <button
                    className={styles.iconBtn}
                    title="Restore"
                    onClick={() => setSentFlag([selectedSent.id], { trashed: false })}
                  >
                    {ICONS.restore}
                  </button>
                ) : (
                  <button
                    className={styles.iconBtn}
                    title="Delete"
                    onClick={() => {
                      setSentFlag([selectedSent.id], { trashed: true })
                      setSelectedId(null)
                      setReaderOpenMobile(false)
                    }}
                  >
                    {ICONS.trash}
                  </button>
                )}
                <button
                  className={styles.iconBtn}
                  title="Print"
                  onClick={() => printMessage(selectedSent.subject, selectedDetail?.from ?? selectedSent.from, selectedSent.createdAt, selectedDetail?.html ?? null, selectedDetail?.text ?? null, { to: selectedSent.to, cc: selectedDetail?.cc ?? selectedSent.cc })}
                >
                  {ICONS.print}
                </button>
                <button
                  className={styles.iconBtn}
                  title="Download .eml"
                  onClick={() => downloadEml({ subject: selectedSent.subject, from: selectedDetail?.from ?? selectedSent.from, to: selectedSent.to, createdAt: selectedSent.createdAt, html: selectedDetail?.html ?? null, text: selectedDetail?.text ?? null })}
                >
                  {ICONS.download}
                </button>
              </>
            )}
          </div>
          {(selectedDetail?.attachments?.length ?? 0) > 0 && (
            <div className={styles.readerAttach}>
              {/* The same tiles the inbox uses. These were bare download links, so a PDF
                  in the Sent folder saved itself instead of opening, which is not what a
                  file sitting on a message looks like it will do. */}
              {renderAttachmentTiles(selectedDetail!.attachments)}
            </div>
          )}
          {(() => {
            const ordered = [...(eventsByEmail[selectedSent.id] ?? [])].sort(
              (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
            )
            const seen = new Set<string>()
            const timeline = ordered
              .filter(event => {
                if (seen.has(event.type)) return false
                seen.add(event.type)
                return true
              })
              // sent/delivered often share a timestamp, so order by the email
              // lifecycle rather than time, which can flip them.
              .sort((a, b) => statusRank(a.type) - statusRank(b.type))
            if (!timeline.length) return null
            return (
              <div className={styles.activity}>
                {timeline.map((event, index) => (
                  <Fragment key={event.type}>
                    {index > 0 && (
                      <span className={styles.eventArrow} aria-hidden>
                        ↓
                      </span>
                    )}
                    <div className={styles.eventRow}>
                      <div className={styles.eventHead}>
                        <span
                          className={`${styles.eventDot} ${
                            event.type.includes('bounce') || event.type.includes('fail') || event.type.includes('complain')
                              ? styles.eventDotBad
                              : event.type.includes('open') || event.type.includes('click') || event.type.includes('deliver')
                                ? styles.eventDotGood
                                : ''
                          }`}
                        />
                        <span className={styles.eventType}>{event.type.replace('email.', '')}</span>
                        <span className={styles.eventTime}>{new Date(event.at).toLocaleString()}</span>
                      </div>
                      {event.meta?.link && (
                        <span className={styles.eventMeta} title={event.meta.link}>
                          {event.meta.link}
                        </span>
                      )}
                      {event.meta?.bounceMessage && <span className={styles.eventMeta}>{event.meta.bounceMessage}</span>}
                    </div>
                  </Fragment>
                ))}
              </div>
            )
          })()}
          <div className={styles.readerBody}>
            {!selectedDetail ? (
              <BodySkeleton />
            ) : selectedDetail.html ? (
              <iframe className={styles.readerFrame} sandbox="" srcDoc={frameHtml(selectedDetail.html, true)} title="Email content" />
            ) : (
              <pre className={styles.readerText}>{selectedDetail.text ?? '(no content)'}</pre>
            )}
          </div>
        </>
      )
    }
    return (
      <div className={styles.readerEmpty}>
        <span className={styles.emptyHex} />
        <p className={styles.emptyTitle}>Nothing open</p>
        <p className={styles.emptySub}>Pick a message from the list, or press C to write one.</p>
      </div>
    )
  })()

  return (
    <div
      className={styles.app}
      data-density={settings.density === 'relaxed' ? 'relaxed' : 'compact'}
      data-mail-theme={themePreview?.base ?? resolvedTheme}
      data-lenis-prevent
      style={{
        ...themeVars(
          themePreview?.accent ?? accent,
          themePreview?.base ?? resolvedTheme,
          themePreview?.vars ?? themeCustom,
        ),
        ['--acting-offset' as string]: `${actingBarHeight}px`,
        ['--brand-mark' as string]: `url('${CLIENT_BRAND.chromeMarkUrl}')`,
        ['--list-w' as string]: `${listWidth}px`,
      } as React.CSSProperties}
    >
      {actingAs && (
        <div className={styles.actingBar} role="status" ref={actingBarRef}>
          <span className={styles.actingDot} aria-hidden />
          Acting as <strong>{actingAs}</strong>. Anything you send goes out from this address.
          <button
            type="button"
            className={styles.actingExit}
            onClick={() => { setMailbox('all'); setSelectedId(null) }}
          >
            Back to all mailboxes
          </button>
        </div>
      )}
      {account?.defaultPassword && !pwNoticeHidden && (
        <div className={styles.pwNotice} role="status">
          <div className={styles.pwNoticeText}>
            <p className={styles.pwNoticeTitle}>Set your own password</p>
            <p className={styles.pwNoticeSub}>
              This mailbox still uses the password it was created with, which is your own
              address. Anyone who knows it could sign in as you.
            </p>
          </div>
          <div className={styles.pwNoticeActions}>
            <button
              type="button"
              className={styles.pwNoticeDismiss}
              onClick={() => setPwNoticeHidden(true)}
            >
              Not now
            </button>
            <button
              type="button"
              className={styles.pwNoticeGo}
              onClick={() => {
                setSettingsOpen(true)
                setSettingsTab('profile')
                setPwNoticeHidden(true)
                setPwFocusRequest(request => request + 1)
              }}
            >
              Change it
            </button>
          </div>
        </div>
      )}
      <div className={styles.topRight}>
      {canInstall && !installed && (
        <button
          className={styles.themeToggle}
          onClick={install}
          aria-label={`Install ${CLIENT_BRAND.name} Mail as an app`}
        >
          {ICONS.install}
        </button>
      )}
      <button
        className={styles.themeToggle}
        onClick={() => { setSettingsTab('notifications'); setSettingsOpen(true) }}
        aria-label={
          settings.desktopNotifications && notifyPermission === 'granted'
            ? 'Notifications are on. Open notification settings.'
            : 'Notifications are off. Open notification settings.'
        }
      >
        {settings.desktopNotifications && notifyPermission === 'granted' ? ICONS.bell : ICONS.bellOff}
      </button>
      <div
        className={styles.themeSwitcher}
        onMouseEnter={openThemeMenu}
        onMouseLeave={closeThemeMenuSoon}
      >
      {/* No title attribute: the native tooltip renders on top of the menu this same hover opens. */}
      <button
        className={styles.themeToggle}
        onClick={cycleTheme}
        aria-label={`Theme: ${themePref}${themePref === 'system' ? ` (following device — ${resolvedTheme})` : ''}. Click to change.`}
      >
        {resolvedTheme === 'dark' ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
            <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        )}
        {themePref === 'system' && <span className={styles.themeAuto}>auto</span>}
      </button>
      {themeMenuOpen && (
        <div
          className={styles.themeMenu}
          onMouseEnter={openThemeMenu}
          onMouseLeave={() => {
            setThemePreview(null)
            closeThemeMenuSoon()
          }}
        >
          <div className={styles.themeMenuHead}>Theme</div>
          {([
            ['system', 'Auto', 'Follows your device'],
            ['light', 'Light', 'Bright surfaces'],
            ['dim', 'Dim', 'Mid slate'],
            ['dark', 'Dark', 'Near-black'],
          ] as [ThemePref, string, string][]).map(([pref, label, hint]) => {
            const swatchBase: ThemeBase = pref === 'system' ? resolvedTheme : (pref as ThemeBase)
            const swatch = BASE_PREVIEW[swatchBase]
            return (
              <button
                key={pref}
                type="button"
                className={`${styles.themeOption} ${themePref === pref ? styles.themeOptionOn : ''}`}
                // Clearing per option repainted the whole app to the live theme for a frame
                // on every crossing between rows; the menu clears it on the way out instead.
                onMouseEnter={() => setThemePreview({ base: swatchBase, accent, vars: themeCustom })}
                onFocus={() => setThemePreview({ base: swatchBase, accent, vars: themeCustom })}
                onClick={() => {
                  chooseTheme(pref)
                  setThemePreview(null)
                  setThemeMenuOpen(false)
                }}
              >
                <span className={styles.themeSwatch} style={{ background: swatch.surface, borderColor: swatch.panel } as React.CSSProperties}>
                  <span className={styles.themeSwatchRail} style={{ background: swatch.sidebar } as React.CSSProperties} />
                  <span className={styles.themeSwatchBody}>
                    <span style={{ background: swatch.panel } as React.CSSProperties} />
                    <span style={{ background: accent } as React.CSSProperties} />
                    <span style={{ background: swatch.panel } as React.CSSProperties} />
                  </span>
                </span>
                <span className={styles.themeOptionText}>
                  <span className={styles.themeOptionLabel}>{label}</span>
                  <span className={styles.themeOptionHint}>{hint}</span>
                </span>
                {themePref === pref && <span className={styles.themeOptionTick}>✓</span>}
              </button>
            )
          })}
          <button
            type="button"
            className={styles.themeMenuLink}
            onClick={() => {
              setThemePreview(null)
              setThemeMenuOpen(false)
              setSettingsOpen(true)
            }}
          >
            {ICONS.settings} Theme settings…
          </button>
          <div className={styles.themeMenuFoot}>Hover to preview · click to apply</div>
        </div>
      )}
      </div>
      </div>
      {railOpen && <div className={styles.railScrim} onClick={() => setRailOpen(false)} />}
      <aside className={`${styles.rail} ${railOpen ? styles.railOpen : ''} ${railCollapsed ? styles.railCollapsed : ''}`}>
        <div className={styles.brand}>
          <span className={styles.brandLogo} role="img" aria-label={CLIENT_BRAND.name} />
          <span className={styles.brandName}>Mail</span>
          <span className={styles.brandTag}>{CLIENT_BRAND.name}</span>
          <button
            type="button"
            className={`${styles.railToggle} ${railCollapsed ? '' : styles.railToggleOn}`}
            onClick={event => {
              event.currentTarget.blur()
              toggleRail()
            }}
            aria-label={railCollapsed ? 'Pin the menu open at full width' : 'Unpin the menu, so it slides out on hover'}
            aria-pressed={!railCollapsed}
            title={railCollapsed ? 'Pin the menu open at full width' : 'Unpin the menu, so it slides out on hover'}
          >
            {ICONS.pin}
          </button>
          <button className={styles.railClose} onClick={() => setRailOpen(false)} aria-label="Close menu">
            {ICONS.close}
          </button>
        </div>
        <button className={styles.composeBtn} onClick={() => { openCompose(); setRailOpen(false) }}>
          <span className={styles.composePen}>{ICONS.pencil}</span>
          <span className={styles.railLabel}>Compose</span>
        </button>
        {(['inbox', 'starred', 'snoozed', 'sent', 'scheduled', 'drafts', 'archived', 'trash'] as Folder[]).map(key => {
          const count =
            key === 'inbox'
              ? folderCounts.inbox || ''
              : key === 'starred'
                ? folderCounts.starred || ''
                : key === 'snoozed'
                  ? folderCounts.snoozed || ''
                : key === 'sent'
                  ? deliveredEmails.filter(entry => !entry.archived && !entry.trashed).length || ''
                  : key === 'scheduled'
                    ? scheduledEmails.length || ''
                    : key === 'drafts'
                      ? drafts.length || ''
                      : key === 'archived'
                        ? folderCounts.archived || ''
                        : folderCounts.trashed || ''
          return (
            <button
              key={key}
              className={`${styles.folder} ${folder === key ? styles.folderActive : ''}`}
              title={folderTitles[key]}
              onClick={() => {
                cancelThreadOpen()
                setFolder(key)
                setSelectedId(null)
                setReaderOpenMobile(false)
                setRailOpen(false)
                setSelectedBulk(new Set())
              }}
            >
              {FOLDER_ICONS[key]}
              <span className={styles.railLabel}>{folderTitles[key]}</span>
              {/* Unread is a filled pill; the plain number is the folder total. */}
              <span className={styles.folderMeta}>
                {key === 'inbox' && unreadCount > 0 && (
                  <span className={styles.folderUnread} title={`${unreadCount} unread`}>
                    {unreadCount.toLocaleString()}
                  </span>
                )}
                {countsLoading ? (
                  <span className={styles.folderSpinner} role="status" aria-label="Refreshing counts" />
                ) : (
                  <span className={styles.folderCount} title={count ? `${count} messages` : undefined}>
                    {typeof count === 'number' ? count.toLocaleString() : count}
                  </span>
                )}
              </span>
            </button>
          )
        })}
        <div className={styles.railFoot}>
          <button className={styles.railSettings} onClick={() => { setFilesOpen(true); setRailOpen(false) }} title="Files">
            {ICONS.attach} <span className={styles.railLabel}>Files</span>
          </button>
          <button className={styles.railSettings} onClick={() => { setSettingsOpen(true); setRailOpen(false) }} title="Settings">
            {ICONS.settings} <span className={styles.railLabel}>Settings</span>
          </button>
          <button
            type="button"
            className={styles.railIdentity}
            onClick={() => { setSettingsTab('profile'); setSettingsOpen(true); setRailOpen(false) }}
            title="Open your profile"
          >
            <span className={styles.railAvatar} aria-hidden>{identityInitial}</span>
            <span className={styles.railIdentityText}>
              <span className={styles.railName}>{identityName}</span>
              <span className={styles.railAddress}>{account?.address || email || 'Not signed in'}</span>
            </span>
          </button>
          <button className={styles.railLink} onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <section className={styles.listPane} ref={listPaneRef}>
        <div
          className={styles.listResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the message list"
          title="Drag to resize"
          onPointerDown={startListResize}
          onDoubleClick={() => {
            setListWidth(LIST_W_DEFAULT)
            try {
              localStorage.setItem(LS_LIST_W_KEY, String(LIST_W_DEFAULT))
            } catch {}
          }}
        />
        <div className={styles.listHead}>
          <button className={styles.menuBtn} onClick={() => setRailOpen(true)} aria-label="Open menu">
            {ICONS.menu}
          </button>
          <h1 className={styles.listTitle}>{folderTitles[folder]}</h1>
          <span className={styles.listMeta} title={listCountTitle}>
            {listCountFigure}{' '}
            <span className={styles.listMetaUnit}>{listCountUnit}</span>
          </span>
          <button
            className={`${styles.refreshBtn} ${refreshing ? styles.spinning : ''}`}
            onClick={refreshAll}
            aria-label="Refresh"
          >
            {ICONS.refresh}
          </button>
        </div>
        <div className={styles.search}>
          {ICONS.search}
          <input
            value={search}
            placeholder="Search your mail"
            onChange={event => {
              setSearch(event.target.value)
              setSearchOpen(true)
              setSearchPick(0)
            }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)}
            onKeyDown={event => {
              if (!searchOpen || !searchSuggestions.length) return
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSearchPick(current => (current + 1) % searchSuggestions.length)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSearchPick(current => (current - 1 + searchSuggestions.length) % searchSuggestions.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                setSearch(searchSuggestions[searchPick].apply)
                setSearchPick(0)
              } else if (event.key === 'Escape') {
                setSearchOpen(false)
              }
            }}
          />
          {search && (
            <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">
              {ICONS.close}
            </button>
          )}
          {searchOpen && searchSuggestions.length > 0 && (
            <div className={styles.searchSuggest} role="listbox">
              {searchSuggestions.map((suggestion, index) => (
                <button
                  key={suggestion.apply}
                  type="button"
                  role="option"
                  aria-selected={index === searchPick}
                  className={`${styles.searchOption} ${index === searchPick ? styles.searchOptionOn : ''}`}
                  onMouseEnter={() => setSearchPick(index)}
                  onMouseDown={event => {
                    event.preventDefault()
                    setSearch(suggestion.apply)
                    setSearchPick(0)
                  }}
                >
                  <span className={styles.searchOptionLabel}>{suggestion.label}</span>
                  <span className={styles.searchOptionHint}>{suggestion.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {selectedBulk.size > 0 && (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{selectedBulk.size} selected</span>
            {folder === 'drafts' ? (
              <button className={styles.bulkBtn} onClick={bulkDeleteDrafts} title="Delete drafts">
                {ICONS.trash}
                <span className={styles.bulkBtnLabel}>Delete</span>
              </button>
            ) : folder === 'scheduled' ? (
              <button className={styles.bulkBtn} onClick={bulkCancelScheduled} title="Cancel sends">
                {ICONS.trash}
                <span className={styles.bulkBtnLabel}>Cancel</span>
              </button>
            ) : (
              <>
                {folder === 'inbox' && (
                  <>
                    <button className={styles.bulkBtn} onClick={() => bulkFlag({ read: true })} title="Mark read">
                      {ICONS.unread}
                      <span className={styles.bulkBtnLabel}>Read</span>
                    </button>
                    <button className={styles.bulkBtn} onClick={() => bulkFlag({ read: false })} title="Mark unread">
                      <span className={styles.bulkDot}>●</span>
                      <span className={styles.bulkBtnLabel}>Unread</span>
                    </button>
                  </>
                )}
                {folder === 'starred' ? (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ starred: false })} title="Unstar">
                    {ICONS.star}
                    <span className={styles.bulkBtnLabel}>Unstar</span>
                  </button>
                ) : folder !== 'trash' && folder !== 'archived' ? (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ starred: true })} title="Star">
                    {ICONS.star}
                    <span className={styles.bulkBtnLabel}>Star</span>
                  </button>
                ) : null}
                {folder === 'archived' ? (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ archived: false })} title="Move to inbox">
                    {ICONS.restore}
                    <span className={styles.bulkBtnLabel}>Unarchive</span>
                  </button>
                ) : folder !== 'trash' ? (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ archived: true })} title="Archive">
                    {ICONS.archive}
                    <span className={styles.bulkBtnLabel}>Archive</span>
                  </button>
                ) : null}
                {folder === 'trash' ? (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ trashed: false })} title="Restore">
                    {ICONS.restore}
                    <span className={styles.bulkBtnLabel}>Restore</span>
                  </button>
                ) : (
                  <button className={styles.bulkBtn} onClick={() => bulkFlag({ trashed: true })} title="Delete">
                    {ICONS.trash}
                    <span className={styles.bulkBtnLabel}>Delete</span>
                  </button>
                )}
                {isAdmin && assignOptions.length > 1 && (
                  <label className={styles.bulkAssign}>
                    <span className={styles.bulkBtnLabel}>Assign to</span>
                    <MailSelect
                      value=""
                      options={assignOptions}
                      ariaLabel="Assign selected messages to a mailbox"
                      buttonClassName={styles.bulkAssignBtn}
                      onChange={value => bulkAssign(value)}
                    />
                  </label>
                )}
              </>
            )}
            <span className={styles.actionSpacer} />
            <button
              className={styles.bulkBtn}
              onClick={() => setSelectedBulk(new Set(listItems.map(item => item.id)))}
              title="Select all"
            >
              <span className={styles.bulkDot}>✓</span>
              <span className={styles.bulkBtnLabel}>All</span>
            </button>
            <button className={styles.bulkBtn} onClick={() => setSelectedBulk(new Set())} title="Clear selection">
              {ICONS.close}
              <span className={styles.bulkBtnLabel}>Clear</span>
            </button>
          </div>
        )}
        {listRefreshing && (
          <div className={styles.listRefreshing} role="status">
            <span className={styles.listRefreshingBar} aria-hidden />
            <span className={styles.srOnly}>Checking for new mail</span>
          </div>
        )}
        <div
          className={styles.pullHint}
          style={{ height: pullDistance, opacity: pullDistance > 6 ? 1 : 0 }}
          aria-hidden
        >
          <span className={`${styles.pullSpinner} ${pullDistance >= PULL_TRIGGER * 0.75 ? styles.pullSpinnerReady : ''}`}>
            {ICONS.refresh}
          </span>
        </div>
        <button
          type="button"
          className={`${styles.toTop} ${listScrolled ? styles.toTopOn : ''}`}
          onClick={scrollListToTop}
          aria-label="Back to the top of the list"
          title="Back to top"
          tabIndex={listScrolled ? 0 : -1}
          aria-hidden={!listScrolled}
        >
          {ICONS.chevron}
        </button>
        <div className={styles.list} ref={listRef}>
          {listSettling ? (
            Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className={styles.skelItem} aria-hidden>
                <span className={styles.skelAvatar} />
                <div className={styles.skelItemLines}>
                  <span className={styles.skelBar} />
                  <span className={styles.skelBar} />
                </div>
              </div>
            ))
          ) : loadError && listItems.length === 0 ? (
            <div className={styles.listError} role="alert">
              <span className={styles.listErrorMark} aria-hidden />
              <p className={styles.listErrorTitle}>Could not load your mail</p>
              <p className={styles.listErrorSub}>{loadError}</p>
              <button
                type="button"
                className={styles.listErrorRetry}
                onClick={() => {
                  setLoadError(null)
                  setMailboxLoading(true)
                  void refreshAll()
                }}
              >
                Try again
              </button>
            </div>
          ) : listItems.length === 0 ? (
            <div className={styles.emptyList}>
              <span className={styles.emptyHex} />
              <p className={styles.emptyTitle}>
                {folder === 'inbox' && 'Inbox zero'}
                {folder === 'starred' && 'No starred mail'}
                {folder === 'snoozed' && 'Nothing snoozed'}
                {folder === 'sent' && 'Nothing sent yet'}
                {folder === 'scheduled' && 'Nothing scheduled'}
                {folder === 'drafts' && 'No drafts'}
                {folder === 'archived' && 'Archive is empty'}
                {folder === 'trash' && 'Trash is empty'}
              </p>
              <p className={styles.emptySub}>
                {folder === 'inbox' &&
                  'Nothing new right now. Messages sent to your address will appear here.'}
                {folder === 'starred' && 'Star a message and it will be kept here so you can find it again.'}
                {folder === 'snoozed' &&
                  'Put a conversation aside and it waits here, then returns to the inbox by itself at the time you chose.'}
                {folder === 'sent' && 'Everything you send is kept here, newest first.'}
                {folder === 'scheduled' && 'Messages waiting to go out. You can still edit or cancel them.'}
                {folder === 'drafts' && 'Unfinished messages are saved here automatically, so nothing is lost.'}
                {folder === 'archived' && 'Messages you have filed away. They are out of the inbox but never deleted.'}
                {folder === 'trash' && 'Deleted messages stay here so you can put them back if you change your mind.'}
              </p>
            </div>
          ) : (
            <>
            {swipe && (() => {
              const action = swipe.dx > 0 ? swipeActions.right : swipeActions.left
              if (!action || swipe.dx === 0) return null
              return (
                <div
                  className={`${styles.swipeBand} ${swipe.dx > 0 ? styles.swipeBandRight : styles.swipeBandLeft} ${Math.abs(swipe.dx) >= SWIPE_COMMIT ? styles.swipeBandArmed : ''}`}
                  style={{ top: swipe.top, height: swipe.height }}
                  aria-hidden
                >
                  <span>{action.label}</span>
                </div>
              )
            })()}
            {listItems.map(item => (
              <button
                key={item.id}
                className={`${styles.item} ${selectedId === item.id ? styles.itemActive : ''} ${item.unread ? styles.itemUnread : ''} ${selectedBulk.has(item.id) ? styles.itemChecked : ''} ${'threadId' in item && item.threadId && threadOpening === item.threadId ? styles.itemOpening : ''}`}
                aria-busy={'threadId' in item && item.threadId ? threadOpening === item.threadId : undefined}
                style={
                  swipe?.id === item.id
                    // Two things get in the way of a row following a finger: the staggered
                    // entry animation, which outranks an inline transform, and a 160ms
                    // transform transition, which makes the row chase the finger instead of
                    // tracking it. Both stand down for the duration of the drag.
                    ? { transform: `translateX(${swipe.dx}px)`, animation: 'none', transition: 'none' }
                    : undefined
                }
                onTouchStart={item.kind === 'inbound' ? event => onRowTouchStart(item.id, 'threadId' in item ? item.threadId ?? null : null, event) : undefined}
                onTouchMove={item.kind === 'inbound' ? onRowTouchMove : undefined}
                onTouchEnd={item.kind === 'inbound' ? onRowTouchEnd : undefined}
                onTouchCancel={item.kind === 'inbound' ? onRowTouchEnd : undefined}
                onClick={() => {
                  // A swipe ends on the row it started on, so without this the release
                  // opens the message the reader just archived.
                  if (swipeRef.current?.moved) return
                  if (item.kind === 'draft') {
                    openDraft(item.id)
                  } else if (item.kind === 'inbound') {
                    if ('threadId' in item && item.threadId) void openThread(item.threadId, item.id)
                    else openInbound(item.id)
                  } else {
                    cancelThreadOpen()
                    setSelectedId(item.id)
                    setReaderOpenMobile(true)
                  }
                }}
              >
                <span
                  role="checkbox"
                  aria-checked={selectedBulk.has(item.id)}
                  tabIndex={0}
                  className={`${styles.checkbox} ${selectedBulk.has(item.id) ? styles.checkboxOn : ''}`}
                  onClick={event => {
                    event.stopPropagation()
                    toggleBulk(item.id)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation()
                      event.preventDefault()
                      toggleBulk(item.id)
                    }
                  }}
                >
                  {selectedBulk.has(item.id) ? '✓' : ''}
                </span>
                <span className={styles.itemBody}>
                  <span className={styles.itemTop}>
                    <span className={styles.itemFrom}>{item.primary}</span>
                    {item.threadCount > 1 && <span className={styles.threadBadge}>{item.threadCount}</span>}
                    <span className={styles.itemTime}>{item.time}</span>
                  </span>
                  <p className={styles.itemSubject}>
                    {item.hasAttachment && <span className={styles.itemClip}>{ICONS.attach}</span>}
                    {item.subject}
                  </p>
                  {item.snippet && <p className={styles.itemSnippet}>{item.snippet}</p>}
                  {item.labels.length > 0 && (
                    <span className={styles.itemLabels}>
                      {item.labels.map(labelId => {
                        const label = LABEL_BY_ID.get(labelId)
                        if (!label) return null
                        return (
                          <span
                            key={labelId}
                            role="button"
                            tabIndex={0}
                            className={styles.labelPill}
                            style={{ color: label.color, borderColor: label.color, cursor: 'pointer' } as React.CSSProperties}
                            title={`Filter by ${label.name}`}
                            onClick={event => {
                              event.stopPropagation()
                              setSearch(`label:${labelId}`)
                            }}
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.stopPropagation()
                                setSearch(`label:${labelId}`)
                              }
                            }}
                          >
                            {label.name}
                          </span>
                        )
                      })}
                    </span>
                  )}
                  {item.chip && (
                    <span
                      className={`${styles.chip} ${
                        item.chip === 'scheduled'
                          ? styles.chipScheduled
                          : item.chip === 'delivered' || item.chip.startsWith('opened') || item.chip.startsWith('clicked')
                            ? styles.chipDelivered
                            : item.chip === 'bounced' || item.chip === 'failed' || item.chip === 'complained'
                              ? styles.chipBounced
                              : item.chip === 'draft'
                                ? styles.chipDraft
                                : ''
                      }`}
                    >
                      {item.chip}
                    </span>
                  )}
                </span>
                {item.unread && <span className={styles.unreadDot} />}
                {inboxFolder && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={item.starred ? 'Unstar' : 'Star'}
                    className={`${styles.itemStar} ${item.starred ? styles.itemStarOn : ''}`}
                    onClick={event => {
                      event.stopPropagation()
                      setInboundFlag([item.id], { starred: !item.starred })
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.stopPropagation()
                        setInboundFlag([item.id], { starred: !item.starred })
                      }
                    }}
                  >
                    {ICONS.star}
                  </span>
                )}
                {folder === 'drafts' && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Delete draft"
                    className={styles.itemTime}
                    onClick={event => {
                      event.stopPropagation()
                      deleteDraft(item.id)
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.stopPropagation()
                        deleteDraft(item.id)
                      }
                    }}
                  >
                    ✕
                  </span>
                )}
              </button>
            ))}
            </>
          )}
          {/* Nothing to load more of when nothing is listed: the skeleton under an empty
              folder read as a mailbox that never finished loading. */}
          {moreCursor && listItems.length > 0 && (
            <div className={styles.listSentinel} aria-busy={loadingMore}>
              {[0, 1, 2].map(row => (
                <div key={row} className={styles.rowSkeleton} aria-hidden>
                  <span className={styles.rowSkeletonAvatar} />
                  <span className={styles.rowSkeletonLines}>
                    <span />
                    <span />
                  </span>
                </div>
              ))}
              <span className={styles.srOnly} role="status">Loading more messages</span>
            </div>
          )}
            {/* Only the inbound folders are paged and carry a server-side total. Sent,
                scheduled and drafts arrive whole, so their count is the list itself —
                reporting the inbox's total under them said "All 6 messages" over a list
                of four. */}
            {!moreCursor && listItems.length > 0 && (
              <div className={styles.listEnd}>
                {!isInboundFolder
                  ? `${listItems.length.toLocaleString()} ${listItems.length === 1 ? 'message' : 'messages'}`
                  : search.trim() && inboxTotal
                    // A search knows how many messages it matched but not how many
                    // conversations they fall into, so say both rather than neither.
                    ? `${listItems.length.toLocaleString()} ${listItems.length === 1 ? 'conversation' : 'conversations'} from ${inboxTotal.toLocaleString()} matching ${inboxTotal === 1 ? 'message' : 'messages'}`
                    : `All ${listItems.length.toLocaleString()} ${listItems.length === 1 ? 'conversation' : 'conversations'} loaded`}
              </div>
            )}
        </div>
      </section>

      <section className={`${styles.reader} ${readerOpenMobile ? styles.readerMobileOpen : ''} ${selectedIsThread ? styles.readerScroll : ''}`}>
        {(readerOpenMobile || selectedId) && (
          <div className={styles.readerBackBar}>
            {/* The list is behind this panel on a narrow window, so there is somewhere to go
                back to. On a wide one it is beside us, and the only thing to do is close. */}
            <button
              className={styles.actionBtn}
              onClick={() => { cancelThreadOpen(); if (listHidden) setReaderOpenMobile(false); else setSelectedId(null) }}
            >
              {listHidden ? <>{ICONS.back} Back</> : <>{ICONS.close} Close</>}
            </button>
          </div>
        )}
        {/* Keyed so React rebuilds it when the selection changes, which is what lets the
            animation replay: switching threads swapped the panel with no sign that
            anything had happened. */}
        <div className={styles.readerSwap} key={threadOpening ? `opening:${threadOpening}` : (selectedId ?? 'empty')}>
          {reader}
        </div>
      </section>

      {preview && (
        <AttachmentLightbox
          items={preview.items}
          index={preview.index}
          onIndex={next => setPreview(current => (current ? { ...current, index: next } : current))}
          onClose={() => setPreview(null)}
        />
      )}

      {!composeOpen && !readerOpenMobile && (
        <button className={styles.fab} onClick={() => openCompose()} aria-label="Compose">
          {ICONS.pencil}
        </button>
      )}

      {composeOpen && (
        <>
          {/* Expanded, this is a pane of the app, not a dialog over it: no backdrop, no
              click-outside-to-close, and not announced as modal — a screen reader should be
              able to move out to the rest of the page. Shrunk, it floats and behaves as one. */}
          {!composeExpanded && <div className={styles.composeScrim} onClick={closeCompose} />}
          <div
            className={`${styles.compose} ${composeExpanded ? styles.composeExpanded : ''}`}
            role={composeExpanded ? 'region' : 'dialog'}
            aria-modal={composeExpanded ? undefined : true}
            aria-label="Compose email"
          >
            <div className={styles.composeHead}>
              <h2 className={styles.composeTitle}>New message</h2>
              <span className={styles.composeHint}>
                drafts autosave<span className={styles.composeHintKeys}> · Esc to close</span>
              </span>
              <div className={styles.composeHeadActions}>
                <button
                  className={styles.composeExpandBtn}
                  onClick={() => setComposeExpanded(open => !open)}
                  type="button"
                  aria-pressed={composeExpanded}
                  aria-label={composeExpanded ? 'Shrink back to a panel' : 'Open full width'}
                  title={composeExpanded ? 'Shrink back to a panel' : 'Open full width'}
                >
                  <span className={styles.composeExpandGlyph} aria-hidden>{composeExpanded ? '\u21f2' : '\u21f1'}</span>
                  {composeExpanded ? 'Shrink' : 'Full width'}
                </button>
                <button className={styles.composeDiscard} onClick={discardCompose}>
                  Discard
                </button>
                <button className={styles.composeClose} onClick={closeCompose}>
                  Close
                </button>
              </div>
            </div>
            <div
              className={`${styles.composeBody} ${dragState !== 'idle' ? styles.composeBodyArmed : ''} ${dragState === 'over' ? styles.composeBodyOver : ''}`}
              onDragEnter={event => {
                if (Array.from(event.dataTransfer.types).includes('Files')) setDragState('over')
              }}
              onDragOver={event => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
                setDragState('over')
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragState(dragDepth.current > 0 ? 'armed' : 'idle')
                }
              }}
              onDrop={event => {
                if (!Array.from(event.dataTransfer.types).includes('Files')) return
                event.preventDefault()
                event.stopPropagation()
                dragDepth.current = 0
                setDragState('idle')
                onPickFiles(event.dataTransfer.files)
              }}
            >
              {dragState !== 'idle' && (
                <div className={`${styles.dropVeil} ${dragState === 'over' ? styles.dropVeilOver : ''}`}>
                  <div className={styles.dropVeilInner}>
                    {ICONS.attach}
                    <strong>{dragState === 'over' ? 'Release to attach' : 'Drop files to attach'}</strong>
                    <span>Up to 100MB each</span>
                  </div>
                </div>
              )}
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>From</span>
                <input
                  value={compose.fromName}
                  onChange={event => setCompose(data => ({ ...data, fromName: event.target.value }))}
                  placeholder="Sender name"
                />
                <span className={styles.composeHint}>via {sendingAddress}</span>
              </div>
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>To</span>
                <ChipField chips={compose.to} onChange={next => setCompose(data => ({ ...data, to: next }))} placeholder="someone@example.com" suggest={suggestContacts} />
                <button
                  className={`${styles.ccToggle} ${showCcBcc ? styles.ccToggleOn : ''}`}
                  onClick={() => setShowCcBcc(open => !open)}
                  type="button"
                >
                  Cc/Bcc
                </button>
              </div>
              {showCcBcc && (
                <>
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Cc</span>
                    <ChipField chips={compose.cc} onChange={next => setCompose(data => ({ ...data, cc: next }))} placeholder="cc@example.com" suggest={suggestContacts} />
                  </div>
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Bcc</span>
                    <ChipField chips={compose.bcc} onChange={next => setCompose(data => ({ ...data, bcc: next }))} placeholder="bcc@example.com" suggest={suggestContacts} />
                  </div>
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>Reply</span>
                    <input
                      value={compose.replyTo}
                      onChange={event => setCompose(data => ({ ...data, replyTo: event.target.value }))}
                      placeholder="reply-to@example.com (optional)"
                    />
                  </div>
                </>
              )}
              <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>Subj</span>
                <input
                  value={compose.subject}
                  onChange={event => setCompose(data => ({ ...data, subject: event.target.value }))}
                  placeholder="Subject"
                />
              </div>


              {compose.campaign.kind && (
                <div className={styles.campaign}>
                  <div className={styles.campaignHead}>
                    <span className={styles.campaignTag}>
                      {compose.campaign.kind === 'academy' ? 'Academy follow-up' : 'Contact follow-up'}
                    </span>
                    <button
                      type="button"
                      className={styles.campaignClear}
                      onClick={() => setCompose(data => ({ ...data, campaign: EMPTY_CAMPAIGN, htmlDirty: false, htmlSource: '' }))}
                    >
                      Clear template
                    </button>
                  </div>
                  <div className={styles.campaignGrid}>
                    <label className={styles.campaignField}>
                      <span>First name</span>
                      <input
                        value={compose.campaign.firstName}
                        placeholder="Recipient's first name"
                        onChange={event =>
                          setCompose(data => ({ ...data, campaign: { ...data.campaign, firstName: event.target.value } }))
                        }
                      />
                    </label>
                    {compose.campaign.kind === 'academy' ? (
                      <>
                        <label className={styles.campaignField}>
                          <span>Cohort date</span>
                          <input
                            value={compose.campaign.cohortDate}
                            placeholder="e.g. 1 June"
                            onChange={event =>
                              setCompose(data => ({ ...data, campaign: { ...data.campaign, cohortDate: event.target.value } }))
                            }
                          />
                        </label>
                        <div className={styles.campaignFieldWide}>
                          <span className={styles.campaignLabel}>Courses (up to {MAX_COURSES})</span>
                          <div className={styles.campaignChips}>
                            {ACADEMY_COURSES.map(course => {
                              const active = compose.campaign.courses.includes(course)
                              return (
                                <button
                                  key={course}
                                  type="button"
                                  className={`${styles.campaignChip} ${active ? styles.campaignChipOn : ''}`}
                                  onClick={() =>
                                    setCompose(data => {
                                      const has = data.campaign.courses.includes(course)
                                      let next = data.campaign.courses
                                      if (has) next = next.filter(entry => entry !== course)
                                      else if (next.length < MAX_COURSES) next = [...next, course]
                                      else return data
                                      return { ...data, campaign: { ...data.campaign, courses: next } }
                                    })
                                  }
                                >
                                  {course}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className={styles.campaignField}>
                          <span className={styles.campaignLabel}>Project type</span>
                          <MailSelect
                            value={compose.campaign.projectType}
                            options={PROJECT_TYPES.map(type => ({ value: type, label: type }))}
                            onChange={type =>
                              setCompose(data => ({ ...data, campaign: { ...data.campaign, projectType: type } }))
                            }
                            ariaLabel="Project type"
                            buttonClassName={styles.campaignSelectBtn}
                          />
                        </div>
                        <label className={styles.campaignToggle}>
                          <input
                            type="checkbox"
                            checked={compose.campaign.includeAcademy}
                            onChange={event =>
                              setCompose(data => ({ ...data, campaign: { ...data.campaign, includeAcademy: event.target.checked } }))
                            }
                          />
                          <span>Include the Academy section</span>
                        </label>
                      </>
                    )}
                  </div>
                  <button type="button" className={styles.campaignBuild} onClick={buildCampaign}>
                    Build email →
                  </button>
                </div>
              )}

              {!compose.campaign.kind && (
                <RichEditor
                  html={compose.bodyHtml}
                  onChange={html => setCompose(data => ({ ...data, bodyHtml: html, htmlDirty: false }))}
                  placeholder="Write your message"
                  uploadImage={uploadInlineImage}
                  fonts={(settings.fonts ?? []).map(font => font.name)}
                  fontFaceCss={fontCss}
                  baseFont={defaultFont}
                />
              )}
              {compose.quoteHtml && !compose.campaign.kind && (
                <details className={styles.composeQuote} open>
                  <summary className={styles.composeQuoteLabel}>Quoted message</summary>
                  <iframe className={styles.composeQuoteFrame} sandbox="allow-same-origin" srcDoc={frameHtml(compose.quoteHtml, true)} title="Quoted message" />
                </details>
              )}
              {/* The signature is appended on send, so show it here rather than leaving the
                  composer looking as though the message will go out without one. It reads
                  from the same value the send path uses, so a mailbox that has written
                  nothing still sees the house signature it will actually send. */}
              {compose.useSignature && !compose.campaign.kind && signatureBody.trim() && (
                <div className={`${styles.composeSignature} ${sigExpanded ? styles.composeSignatureOpen : ''}`}>
                  <div className={styles.composeSignatureBar}>
                    <button
                      type="button"
                      className={styles.composeSignatureLabel}
                      onClick={toggleSignature}
                      aria-expanded={sigExpanded}
                    >
                      {ownSignature ? 'Signature' : 'Signature · default'}
                      <span className={styles.composeSignatureChevron} aria-hidden>{sigExpanded ? '▾' : '▸'}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.composeSignatureEdit}
                      onClick={() => { setSettingsTab('profile'); setSettingsOpen(true) }}
                    >
                      Edit
                    </button>
                  </div>
                  {signatureMarkSrc && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.composeSignatureLogo} src={signatureMarkSrc} alt="" />
                  )}
                  <div
                    className={styles.composeSignatureBody}
                    onClick={expandSignatureFromBody}
                    dangerouslySetInnerHTML={{ __html: asRichHtml(signatureBody) }}
                  />
                  <button
                    type="button"
                    className={styles.composeSignatureMore}
                    onClick={toggleSignature}
                    aria-expanded={sigExpanded}
                  >
                    {sigExpanded ? 'Show less' : 'Show full signature'}
                  </button>
                </div>
              )}
              {compose.campaign.kind && !compose.htmlDirty && (
                <div className={styles.campaignHint}>Fill the fields above, then Build email to preview and send.</div>
              )}

              {compose.htmlDirty && (
                <div className={styles.attachRow}>
                  <button
                    type="button"
                    className={styles.toolBtn}
                    onClick={() => setCompose(data => ({ ...data, htmlDirty: false, htmlSource: '' }))}
                  >
                    ← back to editor content
                  </button>
                </div>
              )}

              {(attachments.length > 0 || attachmentsLoading) && (
                <div className={styles.attachTray}>
                  <div className={styles.attachTrayHead}>
                    {ICONS.attach}
                    <span className={styles.attachTrayCount}>
                      {attachmentsLoading && attachments.length === 0
                        ? 'Fetching attachments…'
                        : `${attachments.length} file${attachments.length > 1 ? 's' : ''} · ${formatBytes(attachments.reduce((sum, entry) => sum + entry.size, 0))}`}
                    </span>
                    <button
                      type="button"
                      className={styles.attachTrayClear}
                      onClick={() => setAttachments([])}
                    >
                      Remove all
                    </button>
                  </div>
                  <div className={styles.attachTrayList}>
                    {attachments.map((attachment, index) => renderAttachChip(attachment, index, true))}
                    {attachmentsLoading &&
                      attachments.length === 0 &&
                      Array.from({ length: 2 }).map((_, index) => (
                        <div key={`skeleton-${index}`} className={`${styles.attachChip} ${styles.attachChipSkeleton}`} aria-hidden>
                          <span className={styles.skelBar} />
                        </div>
                      ))}
                  </div>
                  {attachments.some(entry => entry.size > ATTACH_LIMIT_BYTES) && (
                    <span className={styles.attachNote}>large files (&gt;20MB) are sent as download links</span>
                  )}
                  {attachments.every(entry => entry.size <= ATTACH_LIMIT_BYTES) && (
                    <span className={styles.attachNoteMuted}>attachments send immediately (no delay)</span>
                  )}
                </div>
              )}
            </div>

            <div className={styles.composeFoot}>
              <button className={styles.sendBtn} onClick={sendEmail} disabled={sending} type="button">
                {sending ? 'Sending…' : compose.delayKey === '0' ? 'Send' : 'Send'}
              </button>
              {attachments.some(entry => entry.size <= ATTACH_LIMIT_BYTES) ? (
                <span className={styles.sendNowNote} title="Resend can't schedule a send that carries attachments, so it goes out right away.">
                  Sends now · attachments can’t be scheduled
                </span>
              ) : (
                <>
                  <MailSelect
                    value={compose.delayKey}
                    options={DELAY_OPTIONS.map(option => ({ value: option.key, label: option.label }))}
                    onChange={key => setCompose(data => ({ ...data, delayKey: key }))}
                    ariaLabel="Send delay"
                    buttonClassName={styles.delaySelectBtn}
                  />
                  {compose.delayKey === 'custom' && (
                    <input
                      type="datetime-local"
                      className={styles.datetime}
                      value={compose.customDate}
                      onChange={event => setCompose(data => ({ ...data, customDate: event.target.value }))}
                    />
                  )}
                </>
              )}
              {composeError && <span className={styles.composeError}>{composeError}</span>}
              <span className={styles.footSpacer} />
              <button
                className={`${styles.attachBtn} ${attachments.length ? styles.attachBtnActive : ''}`}
                onClick={() => fileRef.current?.click()}
                aria-label={attachments.length ? `${attachments.length} files attached — add more` : 'Attach files'}
                title="Attach files"
                type="button"
              >
                {ICONS.attach}
                <span>Attach</span>
                {attachments.length > 0 && <span className={styles.attachBadge}>{attachments.length}</span>}
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={event => {
                  onPickFiles(event.target.files)
                  event.target.value = ''
                }}
              />
            </div>
          </div>
        </>
      )}

      {settingsOpen && (
        <div className={styles.settingsScrim} onClick={closeSettings}>
          <div className={styles.settingsCard} onClick={event => event.stopPropagation()}>
            <div className={styles.settingsHead}>
              <h2>Settings</h2>
              <button className={styles.iconBtn} onClick={closeSettings} aria-label="Close">
                {ICONS.close}
              </button>
            </div>

            <div className={styles.settingsLayout}>
              <nav className={styles.settingsNav} aria-label="Settings sections">
                {SETTINGS_TABS.filter(tab => !tab.adminOnly || isAdmin).map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`${styles.settingsNavItem} ${settingsTab === tab.key ? styles.settingsNavItemOn : ''}`}
                    onClick={() => setSettingsTab(tab.key)}
                    aria-current={settingsTab === tab.key}
                  >
                    <span className={styles.settingsNavIcon}>{SETTINGS_TAB_ICONS[tab.key]}</span>
                    <span className={styles.settingsNavText}>
                      <span className={styles.settingsNavLabel}>{tab.label}</span>
                      <span className={styles.settingsNavHint}>{tab.hint}</span>
                    </span>
                  </button>
                ))}
              </nav>

              <div className={styles.settingsBody}>
            <p className={styles.settingsCrumb}>
              Settings <span aria-hidden>›</span>{' '}
              {SETTINGS_TABS.find(tab => tab.key === settingsTab)?.label}
              {settingsTab === 'signature' && isAdmin && (
                <>
                  {' '}<span aria-hidden>›</span> {signatureTab === 'company' ? 'Company' : 'Personal'}
                </>
              )}
            </p>
            {settingsTab === 'appearance' && (<>
            <div className={styles.settingsField}>
              <span>Theme</span>
              <div className={styles.themeRow}>
                {([
                  ['system', 'Auto'],
                  ['light', 'Light'],
                  ['dim', 'Dim'],
                  ['dark', 'Dark'],
                ] as [ThemePref, string][]).map(([pref, label]) => (
                  <button
                    key={pref}
                    type="button"
                    className={`${styles.themeChip} ${themePref === pref ? styles.themeChipOn : ''}`}
                    onClick={() => chooseTheme(pref)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.settingsField}>
              <span>Presets</span>
              <div className={styles.presetGrid}>
                {THEME_PRESETS.map(preset => {
                  const swatch = BASE_PREVIEW[preset.base]
                  const surface = preset.vars.surface ?? swatch.surface
                  const sidebar = preset.vars.sidebar ?? swatch.sidebar
                  const panel = preset.vars.panel ?? swatch.panel
                  return (
                    <button
                      key={preset.key}
                      type="button"
                      className={styles.presetCard}
                      onClick={() => applyPreset(preset.key)}
                      onMouseEnter={() => setThemePreview({ base: preset.base, accent: preset.accent, vars: preset.vars })}
                      onMouseLeave={() => setThemePreview(null)}
                      title={`Apply ${preset.label}`}
                    >
                      <span className={styles.presetSwatch} style={{ background: surface } as React.CSSProperties}>
                        <span style={{ background: sidebar } as React.CSSProperties} />
                        <span style={{ background: panel } as React.CSSProperties} />
                        <span style={{ background: preset.accent } as React.CSSProperties} />
                      </span>
                      <span className={styles.presetLabel}>{preset.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className={styles.settingsField}>
              <span>Customise surfaces</span>
              <div className={styles.tokenGrid}>
                {THEME_FIELDS.map(field => {
                  const active = themeCustom[field.key]
                  // Show the colour actually in effect — the override if set, otherwise the
                  // current base's own value — so the swatches reflect the applied preset.
                  const effective = active ?? BASE_TOKENS[resolvedTheme][field.key] ?? '#000000'
                  return (
                    <label key={field.key} className={styles.tokenRow}>
                      <input
                        type="color"
                        value={effective}
                        onChange={event => setThemeField(field.key, event.target.value)}
                        aria-label={field.label}
                      />
                      <span className={styles.tokenLabel}>{field.label}</span>
                      {active && (
                        <button
                          type="button"
                          className={styles.tokenClear}
                          onClick={event => { event.preventDefault(); setThemeField(field.key, null) }}
                          title="Use the theme default"
                        >
                          ×
                        </button>
                      )}
                    </label>
                  )
                })}
              </div>
              {Object.keys(themeCustom).length > 0 && (
                <button type="button" className={styles.themeReset} onClick={resetTheme}>
                  Reset customised surfaces
                </button>
              )}
            </div>
            <div className={styles.settingsField}>
              <span>Accent colour</span>
              <div className={styles.accentRow}>
                {ACCENT_PRESETS.map(preset => (
                  <button
                    key={preset.key}
                    type="button"
                    title={preset.label}
                    aria-label={preset.label}
                    aria-pressed={accent.toLowerCase() === preset.hex.toLowerCase()}
                    className={`${styles.accentDot} ${accent.toLowerCase() === preset.hex.toLowerCase() ? styles.accentDotOn : ''}`}
                    style={{ background: preset.hex } as React.CSSProperties}
                    onClick={() => chooseAccent(preset.hex)}
                  />
                ))}
                <label className={styles.accentCustom} title="Pick any colour">
                  <input type="color" value={accent} onChange={event => chooseAccent(event.target.value)} />
                  <span>Custom</span>
                </label>
              </div>
            </div>
            <div className={styles.settingsField}>
              <span>Interface size</span>
              <div className={styles.themeRow}>
                {([
                  ['Small', 90],
                  ['Default', 100],
                  ['Large', 110],
                  ['Largest', 125],
                ] as Array<[string, number]>).map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    className={`${styles.themeChip} ${settings.uiScale === value ? styles.themeChipOn : ''}`}
                    onClick={() => setMailSettings(current => ({ ...current, uiScale: value }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className={styles.scaleRow}>
                <input
                  type="range"
                  className={styles.scaleSlider}
                  min={SCALE_MIN}
                  max={SCALE_MAX}
                  step={5}
                  value={settings.uiScale}
                  aria-label="Interface size, as a percentage"
                  onChange={event => setMailSettings(current => ({ ...current, uiScale: Number(event.target.value) }))}
                />
                <span className={styles.scaleValue}>{settings.uiScale}%</span>
              </div>
            </div>
            <div className={styles.settingsField}>
              <span>Density</span>
              <div className={styles.themeRow}>
                {([
                  ['compact', 'Compact'],
                  ['relaxed', 'Airy'],
                ] as Array<[MailSettings['density'], string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`${styles.themeChip} ${settings.density === value ? styles.themeChipOn : ''}`}
                    onClick={() => setMailSettings(current => ({ ...current, density: value }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            </>)}

            {settingsTab === 'profile' && (<>
            <label className={styles.settingsField}>
              <span>Default sender name</span>
              <input
                value={settings.senderName}
                onChange={event => setMailSettings(current => ({ ...current, senderName: event.target.value }))}
                placeholder={account?.name || CLIENT_BRAND.name}
              />
            </label>
            <label className={styles.settingsField}>
              <span>Mobile number</span>
              <input
                value={settings.mobile}
                onChange={event => setMailSettings(current => ({ ...current, mobile: event.target.value }))}
                placeholder="Shown in your signature, when it asks for one"
                inputMode="tel"
              />
            </label>
            <div className={styles.settingsField}>
              <span>Your address</span>
              <p className={styles.settingsNote}>{account?.address || email || 'Not signed in'}</p>
            </div>

            <div
              ref={pwSectionRef}
              className={`${styles.pwSection} ${pwHighlight ? styles.pwSectionFocus : ''}`}
            >
              <p className={styles.pwHeading}>Password</p>
              <p className={styles.settingsProse}>
                {account?.defaultPassword
                  ? 'You are still using the password this mailbox was created with. Anyone who knows your address can guess it.'
                  : 'Changing this signs out every other device.'}
              </p>
              <label className={styles.settingsField}>
                <span>Current password</span>
                <input type="password" autoComplete="current-password" value={pwCurrent}
                  onChange={event => setPwCurrent(event.target.value)} />
              </label>
              <label className={styles.settingsField}>
                <span>New password</span>
                <input type="password" autoComplete="new-password" value={pwNext}
                  onChange={event => setPwNext(event.target.value)} />
              </label>
              <label className={styles.settingsField}>
                <span>Repeat new password</span>
                <input type="password" autoComplete="new-password" value={pwRepeat}
                  onChange={event => setPwRepeat(event.target.value)} />
              </label>
              {pwMsg && (
                <p className={pwMsg.tone === 'ok' ? styles.pwOk : styles.pwBad} role="status">{pwMsg.text}</p>
              )}
              <button
                type="button"
                className={styles.pwSubmit}
                disabled={pwBusy || !pwCurrent || !pwNext || !pwRepeat}
                onClick={changePassword}
              >
                {pwBusy ? 'Changing…' : 'Change password'}
              </button>
            </div>
            </>)}

            {settingsTab === 'signature' && (<>
            {isAdmin && (
              <div className={styles.sigTabRow} role="tablist" aria-label="Whose signature">
                {([['personal', 'Personal'], ['company', 'Company']] as Array<['personal' | 'company', string]>).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={signatureTab === key}
                    className={`${styles.themeChip} ${signatureTab === key ? styles.themeChipOn : ''}`}
                    onClick={() => setSignatureTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {signatureTab === 'personal' && (<>
            <div className={styles.settingsField}>
              <span>Signature</span>
              <div className={styles.sigState}>
                <span className={styles.sigStateText}>
                  {ownSignature ? 'Your own signature' : 'The company signature, until you change it'}
                </span>
                {ownSignature && (
                  <button type="button" className={styles.sigReset} onClick={resetSignature}>
                    Use the company signature
                  </button>
                )}
              </div>
              <div className={styles.sigStack}>
                <div className={styles.sigLogoRow}>
                  <span className={styles.sigLogoLabel}>Logo above the signature</span>
                  {settings.signatureLogo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.sigLogoThumb} src={settings.signatureLogo} alt="Signature logo" />
                  )}
                  <label className={styles.sigLogoPick}>
                    {logoBusy ? 'Uploading…' : settings.signatureLogo ? 'Replace' : 'Upload image'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                      disabled={logoBusy}
                      onChange={event => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (file) void uploadSignatureLogo(file)
                      }}
                    />
                  </label>
                  {settings.signatureLogo && (
                    <button
                      type="button"
                      className={styles.sigLogoClear}
                      onClick={() => setMailSettings(current => ({ ...current, signatureLogo: '' }))}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <RichEditor
                  html={asRichHtml(signatureBody)}
                  onChange={next =>
                    setMailSettings(current => ({ ...current, signature: next === '<p></p>' ? '' : dropUnreachableImages(next) }))
                  }
                  placeholder="Signature"
                  uploadImage={uploadInlineImage}
                  fonts={(settings.fonts ?? []).map(font => font.name)}
                  fontFaceCss={fontCss}
                  baseFont={defaultFont}
                />
              </div>
              {logoMsg && <p className={styles.pwBad} role="status">{logoMsg}</p>}
              {signatureBody.trim() && (
                <div className={`${styles.sigPreview} ${sigPreviewOpen ? styles.sigPreviewOpen : ''}`}>
                  <button
                    type="button"
                    className={styles.sigPreviewLabel}
                    onClick={() => setSigPreviewOpen(open => !open)}
                    aria-expanded={sigPreviewOpen}
                  >
                    {ownSignature ? 'Preview' : 'Preview · the default, until you write your own'}
                    <span className={styles.composeSignatureChevron} aria-hidden>{sigPreviewOpen ? '▾' : '▸'}</span>
                  </button>
                  <div className={styles.sigPreviewFold}>
                    {settings.signatureLogo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className={styles.sigPreviewLogo} src={settings.signatureLogo} alt="" />
                    )}
                    <div
                      className={styles.sigPreviewBody}
                      dangerouslySetInnerHTML={{ __html: asRichHtml(signatureBody) }}
                    />
                  </div>
                  <button
                    type="button"
                    className={styles.composeSignatureMore}
                    onClick={() => setSigPreviewOpen(open => !open)}
                    aria-expanded={sigPreviewOpen}
                  >
                    {sigPreviewOpen ? 'Show less' : 'View full signature'}
                  </button>
                </div>
              )}
            </div>
            </>)}
            {isAdmin && signatureTab === 'company' && (
              <div className={styles.settingsField}>
                <span>The signature everyone sends under</span>
                <div className={styles.sigState}>
                  <span className={styles.sigStateText}>
                    Used by anyone who has not written their own. Write
                    {' '}<code className={styles.sigToken}>{'{{name}}'}</code>,{' '}
                    <code className={styles.sigToken}>{'{{email}}'}</code> or{' '}
                    <code className={styles.sigToken}>{'{{mobile}}'}</code> where the person goes.
                  </span>
                  {companySignature.trim() && (
                    <button
                      type="button"
                      className={styles.sigReset}
                      onClick={() => {
                        setCompanySignature('')
                        setCompanySignatureEdited(true)
                      }}
                    >
                      Back to the built-in one
                    </button>
                  )}
                </div>
                <div className={styles.sigStack}>
                  <div className={styles.sigLogoRow}>
                    <span className={styles.sigLogoLabel}>Logo above the signature</span>
                    {companyLogo && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className={styles.sigLogoThumb} src={companyLogo} alt="Company signature logo" />
                    )}
                    <label className={styles.sigLogoPick}>
                      {logoBusy ? 'Uploading…' : companyLogo ? 'Replace' : 'Upload image'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                        disabled={logoBusy}
                        onChange={event => {
                          const file = event.target.files?.[0]
                          event.target.value = ''
                          if (file) void uploadCompanyLogo(file)
                        }}
                      />
                    </label>
                    {companyLogo && (
                      <button
                        type="button"
                        className={styles.sigLogoClear}
                        onClick={() => {
                          setCompanyLogo('')
                          setCompanySignatureEdited(true)
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <RichEditor
                    html={asRichHtml(companySignature || houseSignature)}
                    onChange={next => {
                      setCompanySignature(next === '<p></p>' ? '' : dropUnreachableImages(next))
                      setCompanySignatureEdited(true)
                    }}
                    placeholder="The signature everyone sends under"
                    uploadImage={uploadInlineImage}
                    fonts={(settings.fonts ?? []).map(font => font.name)}
                    fontFaceCss={fontCss}
                    baseFont={defaultFont}
                  />
                </div>
                {logoMsg && <p className={styles.pwBad} role="status">{logoMsg}</p>}
                {(companySignature || houseSignature).trim() && (
                  <div className={`${styles.sigPreview} ${sigPreviewOpen ? styles.sigPreviewOpen : ''}`}>
                    <button
                      type="button"
                      className={styles.sigPreviewLabel}
                      onClick={() => setSigPreviewOpen(open => !open)}
                      aria-expanded={sigPreviewOpen}
                    >
                      Preview · as a colleague receives it
                      <span className={styles.composeSignatureChevron} aria-hidden>{sigPreviewOpen ? '▾' : '▸'}</span>
                    </button>
                    <div className={styles.sigPreviewFold}>
                      {companyLogo && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className={styles.sigPreviewLogo} src={companyLogo} alt="" />
                      )}
                      <div
                        className={styles.sigPreviewBody}
                        dangerouslySetInnerHTML={{ __html: asRichHtml(companySignature || houseSignature) }}
                      />
                    </div>
                    <button
                      type="button"
                      className={styles.composeSignatureMore}
                      onClick={() => setSigPreviewOpen(open => !open)}
                      aria-expanded={sigPreviewOpen}
                    >
                      {sigPreviewOpen ? 'Show less' : 'View full signature'}
                    </button>
                  </div>
                )}
              </div>
            )}
            </>)}

            {settingsTab === 'mail' && (<>
            <div className={styles.settingsField}>
              <span>Default font for new mail</span>
              <div className={styles.fontAdd}>
                <MailSelect
                  ariaLabel="Default font"
                  value={settings.defaultFont?.family ?? ''}
                  options={[{ value: '', label: 'Arial (standard)' }, ...[...BUILTIN_FONTS, ...(settings.fonts ?? []).map(font => font.name)].filter((font, index, all) => all.indexOf(font) === index).map(font => ({ value: font, label: font }))]}
                  optionStyle={font => (font ? { fontFamily: `'${font}', Arial, sans-serif` } : {})}
                  onChange={family => setMailSettings(current => ({ ...current, defaultFont: { ...(current.defaultFont ?? EMPTY_FONT), family } }))}
                />
                <MailSelect
                  ariaLabel="Default size"
                  editable
                  placeholder="15"
                  value={settings.defaultFont?.size ?? ''}
                  options={[{ value: '', label: '15 (standard)' }, ...FONT_SIZES.map(size => ({ value: size, label: size.replace('px', '') }))]}
                  onChange={raw => {
                    const size = /^\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw
                    if (size && !/^\d+(\.\d+)?(px|pt|em|rem|%)$/.test(size)) return
                    setMailSettings(current => ({ ...current, defaultFont: { ...(current.defaultFont ?? EMPTY_FONT), size } }))
                  }}
                />
              </div>
              <p className={styles.settingsNote}>Applied to everything you write; a font or size picked in the editor still wins for that text.</p>
            </div>
            <div className={styles.settingsField}>
              <span>Fonts</span>
              <p className={styles.settingsNote}>
                Fonts added here appear in the composer’s font menu. Recipients see them where their mail app loads web fonts; elsewhere the nearest standard font is used.
              </p>
              {(settings.fonts ?? []).map(font => (
                <div key={font.name} className={styles.fontRow}>
                  <span style={{ fontFamily: `'${font.name}', Arial, sans-serif` }}>{font.name}</span>
                  <span className={styles.fontRowHint}>{font.url ? 'uploaded file' : 'by name'}</span>
                  <button
                    type="button"
                    className={styles.attachTrayClear}
                    onClick={() => setMailSettings(current => ({ ...current, fonts: (current.fonts ?? []).filter(entry => entry.name !== font.name) }))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className={styles.fontAdd}>
                <input
                  className={styles.fontInput}
                  value={fontName}
                  onChange={event => setFontName(event.target.value)}
                  placeholder="Font name, e.g. Poppins"
                  aria-label="Font name"
                />
                <button type="button" className={styles.sendBtn} disabled={!fontName.trim()} onClick={() => { addFont({ name: fontName.trim(), url: '' }); setFontName('') }}>
                  Add by name
                </button>
                <label className={styles.fontUpload}>
                  {fontBusy ? 'Uploading…' : 'Upload font file'}
                  <input
                    type="file"
                    accept=".woff2,.woff,.ttf,.otf"
                    hidden
                    disabled={fontBusy}
                    onChange={event => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) void uploadFont(file)
                    }}
                  />
                </label>
              </div>
              {fontMsg && <p className={styles.pwBad} role="status">{fontMsg}</p>}
            </div>
            <label className={styles.settingsToggle}>
              <input
                type="checkbox"
                checked={settings.replyAllDefault}
                onChange={event => setMailSettings(current => ({ ...current, replyAllDefault: event.target.checked }))}
              />
              <span>Reply to everyone in the conversation by default. With this off, a reply goes to the sender and a separate Reply all sits beside it.</span>
            </label>
            <label className={styles.settingsToggle}>
              <input
                type="checkbox"
                checked={settings.confirmSend}
                onChange={event => setMailSettings(current => ({ ...current, confirmSend: event.target.checked }))}
              />
              <span>Ask me to confirm before a message goes out</span>
            </label>
            <label className={styles.settingsToggle}>
              <input
                type="checkbox"
                checked={settings.showRemoteImages}
                onChange={event => setMailSettings(current => ({ ...current, showRemoteImages: event.target.checked }))}
              />
              <span>Load images in messages automatically</span>
            </label>
            <p className={styles.settingsProse}>
              Images are held back by default, because loading one tells the sender you opened the message.
            </p>
            </>)}

            {settingsTab === 'notifications' && (<>
              <label className={styles.settingsToggle}>
                <input
                  type="checkbox"
                  checked={settings.notifications}
                  onChange={event =>
                    setMailSettings(current => ({
                      ...current,
                      notifications: event.target.checked,
                      // Turning it off clears the address rather than leaving a forwarding
                      // target sitting in the settings unused.
                      notifyEmail: event.target.checked ? current.notifyEmail : '',
                    }))
                  }
                />
                <span>Email me when new mail arrives</span>
              </label>
              {settings.notifications && (
                <label className={styles.settingsField}>
                  <span>Send those alerts to</span>
                  <input
                    type="email"
                    value={settings.notifyEmail}
                    placeholder="you@somewhere-else.com"
                    onChange={event => setMailSettings(current => ({ ...current, notifyEmail: event.target.value }))}
                  />
                  <p className={styles.settingsProse}>
                    Use an address you read somewhere else. An alert sent to this mailbox would
                    only arrive once you had already looked.
                  </p>
                  {settings.notifyEmail && !EMAIL_SHAPE.test(settings.notifyEmail) && (
                    <p className={styles.pwBad}>That does not look like an email address.</p>
                  )}
                </label>
              )}
            <label className={styles.settingsToggle}>
              <input
                type="checkbox"
                checked={settings.desktopNotifications}
                disabled={notifyPermission === 'unsupported'}
                onChange={async event => {
                  const wanted = event.target.checked
                  if (wanted && notifyPermission !== 'granted') {
                    const result = await requestNotifyPermission()
                    if (result !== 'granted') return
                  }
                  if (wanted) void subscribePush(apiHeaders())
                  else void unsubscribePush(apiHeaders())
                  setMailSettings(current => ({ ...current, desktopNotifications: wanted }))
                }}
              />
              <span>Show a desktop notification for new mail</span>
            </label>
            <p className={styles.settingsNote}>
              {notifyPermission === 'unsupported'
                ? 'This browser does not support notifications.'
                : notifyPermission === 'denied'
                  ? 'Notifications are blocked for this site — allow them in your browser settings first.'
                  : notifyPermission === 'granted'
                    ? 'Allowed. Notifications appear only while the tab is in the background.'
                    : 'Your browser will ask permission the first time you switch this on.'}
            </p>
            </>)}

            {settingsTab === 'people' && (
            <>
            <p className={styles.settingsNote}>
              Invite colleagues, give them a mailbox on the domain, and choose what they can see.
            </p>

          <div className={styles.accessorInvite}>
            <div className={styles.accessorInviteRow}>
              <input
                className={styles.accessorInput}
                type="email"
                placeholder="name@email.com"
                value={inviteEmail}
                onChange={event => setInviteEmail(event.target.value)}
              />
              <input
                className={styles.accessorInput}
                placeholder="Name (optional)"
                value={inviteName}
                onChange={event => setInviteName(event.target.value)}
              />
              <MailSelect
                value={inviteRole}
                options={ROLE_OPTIONS}
                ariaLabel="Invite role"
                buttonClassName={styles.accessorRoleBtn}
                onChange={value => setInviteRole(value as 'admin' | 'member')}
              />
            </div>
            <div className={styles.accessorInviteFooter}>
              <div className={styles.mailboxInputWrap}>
                <input
                  type="text"
                  placeholder="Choose a mailbox"
                  aria-label="Mailbox name"
                  value={inviteHandle}
                  onChange={event => setInviteHandle(event.target.value)}
                />
                {addressDomains.length > 1 ? (
                  <MailSelect
                    buttonClassName={styles.mailboxDomainSelect}
                    ariaLabel="Mail domain"
                    value={inviteDomain}
                    onChange={setInviteDomain}
                    options={addressDomains.map(domain => ({ value: domain, label: `@${domain}` }))}
                  />
                ) : (
                  <span className={styles.mailboxDomain}>@{addressDomain}</span>
                )}
              </div>
              <button className={styles.sendBtn} disabled={inviteBusy} onClick={inviteAccessor} type="button">
                {inviteBusy ? 'Sending…' : 'Send invite'}
              </button>
            </div>
            <p className={styles.accessorHint}>
              They&apos;ll get an email to set their password. Members see only their own mail; admins see every mailbox.
              Leave the mailbox blank to derive one from their name.
            </p>
            {accessorsMsg && <p className={styles.accessorMsg}>{accessorsMsg}</p>}
          </div>

          <ul className={styles.accessorList}>
            {accessors.map(entry => (
              <li key={entry.email} className={styles.accessorItem}>
                <div className={styles.accessorMeta}>
                  <strong>{entry.name || entry.email}</strong>
                  <span className={styles.accessorSub}>{entry.email}</span>
                  {renameTarget === entry.email ? (
                    <span className={styles.mailboxField}>
                      <span className={styles.mailboxInputWrap}>
                        <input
                          type="text"
                          autoFocus
                          aria-label={`Mailbox for ${entry.email}`}
                          value={renameHandle}
                          onChange={event => setRenameHandle(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') saveMailboxName(entry.email)
                            if (event.key === 'Escape') setRenameTarget(null)
                          }}
                        />
                        {addressDomains.length > 1 ? (
                          <MailSelect
                            buttonClassName={styles.mailboxDomainSelect}
                            ariaLabel={`Mail domain for ${entry.email}`}
                            value={renameDomain}
                            onChange={setRenameDomain}
                            options={addressDomains.map(domain => ({ value: domain, label: `@${domain}` }))}
                          />
                        ) : (
                          <span className={styles.mailboxDomain}>@{addressDomain}</span>
                        )}
                      </span>
                      <button className={styles.mailboxSave} onClick={() => saveMailboxName(entry.email)} type="button">
                        Save
                      </button>
                    </span>
                  ) : (
                    <button
                      className={styles.mailboxTag}
                      onClick={() => {
                        setRenameTarget(entry.email)
                        setRenameHandle((entry.address ?? '').split('@')[0])
                        setRenameDomain((entry.address ?? '').split('@')[1] || addressDomain)
                      }}
                      title="Change this mailbox address"
                      type="button"
                    >
                      {entry.address ?? 'no mailbox'}
                    </button>
                  )}
                </div>
                <div className={styles.accessorControls}>
                  <span className={`${styles.accessorBadge} ${entry.status !== 'active' ? styles.accessorPending : ''}`}>
                    {entry.status === 'active' ? 'Active' : 'Invited'}
                  </span>
                  <MailSelect
                    value={entry.role}
                    options={ROLE_OPTIONS}
                    ariaLabel={`Role for ${entry.name || entry.email}`}
                    buttonClassName={styles.accessorRoleBtn}
                    onChange={value => changeAccessorRole(entry.email, value as 'admin' | 'member')}
                  />
                  <button
                    className={styles.accessorRemove}
                    onClick={() => removeAccessor(entry.email)}
                    aria-label={`Remove ${entry.email}`}
                    type="button"
                  >
                    {ICONS.close}
                  </button>
                </div>
              </li>
            ))}
          </ul>
            </>
            )}

            {settingsTab === 'app' && (<>
            <div className={styles.settingsField}>
              <span>Install {CLIENT_BRAND.name} Mail</span>
              <p className={styles.settingsNote}>
                {installed
                  ? 'Installed. Launch it from your dock, home screen or app list.'
                  : canInstall
                    ? 'Install it as an app so it opens in its own window and can show notifications.'
                    : 'Your browser handles this from its own menu — look for Install or Add to Home Screen.'}
              </p>
              {!installed && canInstall && (
                <button type="button" className={styles.sendBtn} onClick={install}>
                  {ICONS.install} Install app
                </button>
              )}
            </div>
            <div className={styles.settingsField}>
              <span>Signed in as</span>
              <p className={styles.settingsNote}>{account?.address || email || 'Not signed in'}</p>
              <button type="button" className={styles.themeReset} onClick={signOut}>
                Sign out
              </button>
            </div>
            <div className={styles.settingsField}>
              <span>Build</span>
              <p className={styles.settingsNote}>{process.env.NEXT_PUBLIC_BUILD_TIME ?? 'unknown'}</p>
            </div>
            </>)}
              </div>
            </div>

            <div className={styles.settingsFoot}>
              <span className={styles.settingsHint}>Saved per account</span>
              <button
                className={styles.sendBtn}
                onClick={closeSettings}
                type="button"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {filesOpen && (
        <div className={styles.settingsScrim} onClick={() => setFilesOpen(false)}>
          <div className={`${styles.settingsCard} ${styles.filesCard}`} onClick={event => event.stopPropagation()}>
            <div className={styles.settingsHead}>
              <h2>Files</h2>
              <button className={styles.iconBtn} onClick={() => setFilesOpen(false)} aria-label="Close">
                {ICONS.close}
              </button>
            </div>

            {shareDraft ? (
              <div className={styles.shareForm}>
                <div className={styles.settingsField}>
                  <span>Share outside the company</span>
                  <p className={styles.settingsNote}>{shareDraft.filename} · {formatSize(shareDraft.size)}</p>
                </div>
                {shareResult ? (
                  <>
                    <div className={styles.settingsField}>
                      <span>Link</span>
                      <div className={styles.shareLinkRow}>
                        <input readOnly value={shareResult} onFocus={event => event.currentTarget.select()} />
                        <button type="button" className={styles.sendBtn} onClick={() => copyText(shareResult)}>Copy</button>
                      </div>
                    </div>
                    <div className={styles.settingsFoot}>
                      <span className={styles.settingsHint}>{filesMsg || 'Anyone with the link can download until it expires.'}</span>
                      <button type="button" className={styles.themeReset} onClick={() => setShareDraft(null)}>Done</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles.settingsField}>
                      <span>Expires</span>
                      <div className={styles.themeRow}>
                        {([[1, '1 day'], [7, '7 days'], [30, '30 days'], [0, 'Never']] as Array<[number, string]>).map(([days, label]) => (
                          <button
                            key={days}
                            type="button"
                            className={`${styles.themeChip} ${shareExpiry === days ? styles.themeChipOn : ''}`}
                            onClick={() => setShareExpiry(days)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className={styles.settingsField}>
                      <span>Password (optional)</span>
                      <input type="text" value={sharePassword} onChange={event => setSharePassword(event.target.value)} placeholder="Leave blank for none" autoComplete="off" />
                    </label>
                    <label className={styles.settingsField}>
                      <span>Download limit (optional)</span>
                      <input type="number" min={1} value={shareMax} onChange={event => setShareMax(event.target.value)} placeholder="Unlimited" />
                    </label>
                    {filesMsg && <p className={styles.accessorMsg}>{filesMsg}</p>}
                    <div className={styles.settingsFoot}>
                      <button type="button" className={styles.themeReset} onClick={() => setShareDraft(null)}>Cancel</button>
                      <button type="button" className={styles.sendBtn} disabled={shareBusy} onClick={createShareLink}>
                        {shareBusy ? 'Creating…' : 'Create link'}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className={styles.settingsField}>
                  <span>Shared links</span>
                  {sharesLoading && shares.length === 0 ? (
                    <ul className={styles.filesList} aria-busy="true">
                      {[0, 1, 2, 3].map(row => (
                        <li key={row} className={`${styles.filesRow} ${styles.filesRowSkeleton}`}>
                          <span className={styles.filesSkeletonIcon} />
                          <span className={styles.filesSkeletonLines}><span /><span /></span>
                        </li>
                      ))}
                    </ul>
                  ) : shares.length === 0 ? (
                    <p className={styles.settingsNote}>Nothing shared yet. Pick an attachment below and choose Share.</p>
                  ) : (
                    <ul className={styles.filesList}>
                      {shares.map(share => {
                        const expired = Boolean(share.expiresAt && new Date(share.expiresAt) < new Date())
                        const exhausted = share.maxDownloads != null && share.downloads >= share.maxDownloads
                        const dead = share.revoked || expired || exhausted
                        const status = share.revoked
                          ? 'revoked'
                          : expired
                            ? 'expired'
                            : exhausted
                              ? 'limit reached'
                              : share.expiresAt
                                ? `expires ${new Date(share.expiresAt).toLocaleDateString()}`
                                : 'never expires'
                        return (
                          <li key={share.id} className={`${styles.filesRow} ${dead ? styles.filesRowDead : ''}`}>
                            <span className={styles.filesIcon}>{ICONS.file}</span>
                            <span className={styles.filesMeta}>
                              <span className={styles.filesName}>{share.filename}</span>
                              <span className={styles.filesSub}>
                                {formatSize(share.size)} · {share.downloads}{share.maxDownloads != null ? ` / ${share.maxDownloads}` : ''} downloads
                                {share.hasPassword ? ' · password' : ''} · {status}
                              </span>
                            </span>
                            {!dead && (
                              <span className={styles.filesActions}>
                                <button type="button" className={styles.attachAction} onClick={() => copyText(`${window.location.origin}/share/${share.id}`)}>Copy link</button>
                                <button type="button" className={styles.attachAction} onClick={() => changeSharePassword(share.id)}>
                                  {share.hasPassword ? 'Change password' : 'Add password'}
                                </button>
                                <button type="button" className={styles.attachAction} onClick={() => revokeShareLink(share.id)}>Revoke</button>
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                <div className={styles.settingsField}>
                  <span>Attachments</span>
                  {libraryLoading && libraryFiles.length === 0 ? (
                    <ul className={styles.filesList} aria-busy="true">
                      {[0, 1, 2, 3].map(row => (
                        <li key={row} className={`${styles.filesRow} ${styles.filesRowSkeleton}`}>
                          <span className={styles.filesSkeletonIcon} />
                          <span className={styles.filesSkeletonLines}><span /><span /></span>
                        </li>
                      ))}
                    </ul>
                  ) : libraryFiles.length === 0 ? (
                    <p className={styles.settingsNote}>No stored attachments yet. Files arriving on mail, or imported from an archive, appear here.</p>
                  ) : (
                    <ul className={styles.filesList}>
                      {libraryFiles.map(file => (
                        <li key={`${file.messageId}:${file.filename}`} className={styles.filesRow}>
                          <span className={styles.filesIcon}>{ICONS.file}</span>
                          <span className={styles.filesMeta}>
                            <span className={styles.filesName}>{file.filename}</span>
                            <span className={styles.filesSub}>
                              {formatSize(file.size)} · {file.sent ? 'sent' : `from ${file.from}`} · {file.subject || '(no subject)'}
                            </span>
                          </span>
                          <span className={styles.filesActions}>
                            <a className={styles.attachAction} href={file.url} target="_blank" rel="noopener noreferrer">Download</a>
                            {!file.sent && (
                              <button type="button" className={styles.attachAction} onClick={() => openShareDialog(file)}>Share</button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {filesMsg && <p className={styles.settingsNote}>{filesMsg}</p>}
              </>
            )}
          </div>
        </div>
      )}


      {undo && (
        <div className={styles.toast}>
          Sending <span className={styles.toastCount}>{formatCountdown(undo.sendAt - now)}</span>
          <button className={styles.toastUndo} onClick={undoSend} type="button">
            Undo
          </button>
        </div>
      )}
      {openError && !undo && (
        <div className={`${styles.toast} ${styles.toastError}`} role="alert">
          {openError}
        </div>
      )}
      {sentFlash && !undo && (
        <div className={styles.toast}>
          <span className={sentFlash === 'Sent' ? styles.toastOk : ''}>{sentFlash}</span>
        </div>
      )}
    </div>
  )
}
