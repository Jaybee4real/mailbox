/**
 * Which files are part of the message and which are attached to it.
 *
 * A signature logo and a footer badge arrive as ordinary MIME parts, so a mailbox that
 * lists everything shows files on a message whose sender attached nothing.
 *
 * A Content-ID alone does not settle it. Forwarding through Outlook stamps one onto
 * every image part, including photographs the sender genuinely attached, so treating
 * any image that has one as decoration hides real files — accident photographs, in the
 * case that found this. The body is the authority: a part is embedded when the message
 * points at it, and that pointer is the whole reason it was given an id.
 *
 * Where the body cannot be read, everything is shown. Listing a signature logo is
 * untidy; hiding a document somebody sent looks like the mail arrived broken.
 */

export type FileMeta = {
  filename?: string
  contentType?: string
  size?: number
  key?: string
  contentId?: string
  [extra: string]: unknown
}

/** Every `cid:` the body points at, lowercased and unwrapped. */
export function referencedCids(html: string | null | undefined): Set<string> {
  const found = new Set<string>()
  if (!html) return found
  for (const match of html.matchAll(/cid:([^"'\s>)\\]+)/gi)) {
    found.add(match[1].replace(/^<|>$/g, '').trim().toLowerCase())
  }
  return found
}

/**
 * Only images are ever hidden, and only when the body draws them. A Content-ID on a PDF
 * means a sender referenced a real document, which is still something they attached.
 */
export function isEmbedded(file: FileMeta, referenced: Set<string>): boolean {
  if (referenced.size === 0) return false
  const contentId = typeof file.contentId === 'string' ? file.contentId.replace(/^<|>$/g, '').trim().toLowerCase() : ''
  if (!contentId) return false
  if (!String(file.contentType ?? '').toLowerCase().startsWith('image/')) return false
  return referenced.has(contentId)
}

/** The files a reader should be offered, in their original order. */
export function attachedFiles<T extends FileMeta>(files: T[], html?: string | null): T[] {
  const referenced = referencedCids(html)
  return files.filter(file => !isEmbedded(file, referenced))
}
