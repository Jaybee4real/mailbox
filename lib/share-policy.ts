export type ShareAccess = 'download' | 'both' | 'view'

export type ShareSettings = {
  expiresAt: string | null
  availableAt: string | null
  maxDownloads: number | null
  maxViews: number | null
  access: ShareAccess
}

export type ShareCounters = ShareSettings & {
  filename: string
  revoked: boolean
  downloads: number
  views: number
}

export type ShareGate = {
  state: 'open' | 'pending' | 'gone'
  canView: boolean
  canDownload: boolean
}

const MAX_LIMIT = 10_000

const VIEWABLE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  txt: 'text/plain; charset=utf-8',
}

/**
 * The type a file is served inline as, decided by its extension and never by what the uploader
 * claimed, so nothing that can run script (HTML, SVG) is ever rendered on this origin.
 */
export function viewableType(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return VIEWABLE[extension] ?? null
}

export function viewKind(filename: string): 'image' | 'pdf' | 'video' | 'audio' | 'text' | null {
  const type = viewableType(filename)
  if (!type) return null
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/')) return 'text'
  return type.split('/')[0] as 'image' | 'video' | 'audio'
}

function limit(value: unknown): number | null | undefined {
  if (value == null || value === '' || value === 0) return null
  const count = Number(value)
  if (!Number.isInteger(count) || count < 1 || count > MAX_LIMIT) return undefined
  return count
}

function instant(value: unknown): string | null | undefined {
  if (value == null || value === '') return null
  const time = new Date(String(value)).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/** Reads settings from a request body; `expiresInDays` is still accepted from older clients. */
export function parseShareSettings(
  input: Record<string, unknown>,
  filename: string,
  now = Date.now(),
): { settings: ShareSettings; error?: undefined } | { settings?: undefined; error: string } {
  let expiresAt = instant(input.expiresAt)
  if (expiresAt === null && input.expiresInDays != null) {
    const days = Number(input.expiresInDays)
    if (!Number.isFinite(days) || days < 0) return { error: 'Pick a valid expiry.' }
    expiresAt = days > 0 ? new Date(now + days * 86_400_000).toISOString() : null
  }
  const availableAt = instant(input.availableAt)
  const maxDownloads = limit(input.maxDownloads)
  const maxViews = limit(input.maxViews)
  if (expiresAt === undefined) return { error: 'Pick a valid expiry date.' }
  if (availableAt === undefined) return { error: 'Pick a valid opening date.' }
  if (maxDownloads === undefined) return { error: `The download limit must be a whole number from 1 to ${MAX_LIMIT}.` }
  if (maxViews === undefined) return { error: `The view limit must be a whole number from 1 to ${MAX_LIMIT}.` }
  if (expiresAt && new Date(expiresAt).getTime() <= now) return { error: 'The expiry has to be in the future.' }
  const opensLater = availableAt && new Date(availableAt).getTime() > now ? availableAt : null
  if (opensLater && expiresAt && opensLater >= expiresAt) return { error: 'The link has to open before it expires.' }

  const requested = String(input.access ?? 'download')
  if (requested !== 'download' && requested !== 'both' && requested !== 'view') return { error: 'Pick how the file can be opened.' }
  let access = requested as ShareAccess
  if (access !== 'download' && !viewableType(filename)) {
    if (access === 'view') return { error: 'This kind of file cannot be opened in a browser, so it can only be downloaded.' }
    access = 'download'
  }
  return { settings: { expiresAt, availableAt: opensLater, maxDownloads, maxViews, access } }
}

export function shareGate(share: ShareCounters, now = Date.now()): ShareGate {
  const closed = { state: 'gone' as const, canView: false, canDownload: false }
  if (share.revoked) return closed
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now) return closed
  const canDownload = share.access !== 'view' && (share.maxDownloads == null || share.downloads < share.maxDownloads)
  const canView =
    share.access !== 'download' &&
    viewableType(share.filename) != null &&
    (share.maxViews == null || share.views < share.maxViews)
  if (!canView && !canDownload) return closed
  const pending = Boolean(share.availableAt && new Date(share.availableAt).getTime() > now)
  return { state: pending ? 'pending' : 'open', canView, canDownload }
}
