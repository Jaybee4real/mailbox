'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorContent, Extension, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type Editor, type NodeViewProps } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { CLIENT_BRAND } from '@/lib/brand.client'
import TextAlign from '@tiptap/extension-text-align'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { LINE_SPACINGS, BUILTIN_FONTS, FONT_SIZES, fontStack, lineSpacingOf, paragraphGap, type BaseFont } from '@/lib/fonts'
import MailSelect, { GLYPH } from './MailSelect'
import { Color } from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { safeHref } from '@/lib/email-html'
import styles from './page.module.css'
import { TAB_TEXT, tabPress } from './tabKey'
import { WRITING_DEFAULTS, type WritingSettings } from './writing/settings'
import { WritingAssist, nextField } from './writing/assist'
import { fillTemplate, type MailTemplate, type TemplateContext } from './writing/templates'
import { Spelling, spellingKey, suggestSpelling } from './writing/spelling'
import { Grammar, grammarIgnoreKey, grammarKey } from './writing/grammar'
import { FindReplace, findKey, findMatches, findState } from './writing/find'
import { cleanPastedHtml } from './writing/paste'
import WritingPanel from './writing/WritingPanel'
import { LiveStore, live } from './writing/live'

const TEXT_COLOURS = ['#030712', '#b91c1c', '#1d4ed8', '#047857', '#b45309', '#6d28d9', '#6b7280']
const HIGHLIGHTS = ['#FEF08A', '#BBF7D0', '#BFDBFE', '#FBCFE8', '#FED7AA']
const PHONE = '(max-width: 720px)'
function usePhone(): boolean {
  return useSyncExternalStore(
    onChange => {
      const media = window.matchMedia(PHONE)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  )
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className={styles.rteGroup}>{children}</div>
}

function Btn({
  onClick,
  active,
  title,
  children,
  wide,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={event => event.preventDefault()} // keep the selection while clicking
      onClick={onClick}
      className={`${styles.rteBtn} ${wide ? styles.rteBtnWide : ''} ${active ? styles.rteBtnOn : ''}`}
    >
      {children}
    </button>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  autoFocus,
  onEnter,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  autoFocus?: boolean
  onEnter?: () => void
}) {
  return (
    <label className={styles.rtePopField}>
      <span>{label}</span>
      <input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && onEnter) {
            event.preventDefault()
            onEnter()
          }
        }}
      />
    </label>
  )
}

function LinkPopover({ editor, close }: { editor: Editor; close: () => void }) {
  const active = editor.isActive('link')
  const [href, setHref] = useState(() => (editor.getAttributes('link').href as string) ?? '')
  const [text, setText] = useState(() => {
    const { from, to } = editor.state.selection
    return from === to ? '' : editor.state.doc.textBetween(from, to, ' ')
  })

  const apply = () => {
    const url = safeHref(href)
    if (!url) return
    const label = text.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    // With no selection there is nothing to mark, so the label (or the address) becomes the text.
    if (label || editor.state.selection.empty) {
      chain.insertContent({ type: 'text', text: label || url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
    } else {
      chain.setLink({ href: url }).run()
    }
    close()
  }

  return (
    <div className={styles.rtePop} role="dialog" aria-label="Insert link">
      <Field label="Text to display" value={text} onChange={setText} placeholder="Our policy page" autoFocus onEnter={apply} />
      <Field label="Address" value={href} onChange={setHref} placeholder="example.com" onEnter={apply} />
      <div className={styles.rtePopActions}>
        {active && (
          <button
            type="button"
            className={styles.rtePopBtn}
            onClick={() => {
              editor.chain().focus().extendMarkRange('link').unsetLink().run()
              close()
            }}
          >
            Remove link
          </button>
        )}
        <span className={styles.rtePopSpacer} />
        <button type="button" className={styles.rtePopBtn} onClick={close}>
          Cancel
        </button>
        <button type="button" className={styles.rtePopBtnPrimary} disabled={!safeHref(href)} onClick={apply}>
          {active ? 'Update' : 'Insert'}
        </button>
      </div>
    </div>
  )
}

function ImagePopover({
  editor,
  close,
  upload,
}: {
  editor: Editor
  close: () => void
  upload?: (file: File) => Promise<string>
}) {
  const [src, setSrc] = useState('')
  const [alt, setAlt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const apply = (address = src) => {
    const url = safeHref(address)
    if (!url) return
    editor.chain().focus().setImage({ src: url, alt: alt.trim() || undefined }).run()
    close()
  }

  const pick = async (file: File) => {
    if (!upload) return
    setBusy(true)
    setError('')
    try {
      const url = await upload(file)
      setSrc(url)
      editor.chain().focus().setImage({ src: url, alt: alt.trim() || undefined }).run()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That image could not be uploaded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.rtePop} role="dialog" aria-label="Insert image">
      {upload && (
        <>
          <label className={`${styles.rtePopUpload} ${busy ? styles.rtePopUploadBusy : ''}`}>
            {busy ? 'Uploading…' : 'Choose a file…'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              disabled={busy}
              onChange={event => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void pick(file)
              }}
            />
          </label>
          <div className={styles.rtePopOr}>or paste an address</div>
        </>
      )}
      <Field label="Address" value={src} onChange={setSrc} placeholder="https://…/photo.png" autoFocus={!upload} onEnter={() => apply()} />
      <Field label="Description" value={alt} onChange={setAlt} placeholder="Shown if the image cannot load" onEnter={() => apply()} />
      {error && <p className={styles.rtePopError}>{error}</p>}
      <div className={styles.rtePopActions}>
        <span className={styles.rtePopSpacer} />
        <button type="button" className={styles.rtePopBtn} onClick={close}>
          Cancel
        </button>
        <button type="button" className={styles.rtePopBtnPrimary} disabled={!safeHref(src) || busy} onClick={() => apply()}>
          Insert
        </button>
      </div>
    </div>
  )
}

const GRID = 6

function TablePopover({ editor, close }: { editor: Editor; close: () => void }) {
  const [hover, setHover] = useState({ rows: 0, cols: 0 })
  const [header, setHeader] = useState(true)

  const insert = (rows: number, cols: number) => {
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: header }).run()
    close()
  }

  return (
    <div className={styles.rtePop} role="dialog" aria-label="Insert table">
      <div className={styles.rteGrid} onMouseLeave={() => setHover({ rows: 0, cols: 0 })}>
        {Array.from({ length: GRID }, (_, row) =>
          Array.from({ length: GRID }, (_, col) => (
            <button
              key={`${row}-${col}`}
              type="button"
              aria-label={`${row + 1} by ${col + 1} table`}
              className={`${styles.rteGridCell} ${row < hover.rows && col < hover.cols ? styles.rteGridCellOn : ''}`}
              onMouseEnter={() => setHover({ rows: row + 1, cols: col + 1 })}
              onFocus={() => setHover({ rows: row + 1, cols: col + 1 })}
              onClick={() => insert(row + 1, col + 1)}
            />
          )),
        )}
      </div>
      <div className={styles.rteGridLabel}>{hover.rows ? `${hover.rows} × ${hover.cols}` : 'Pick a size'}</div>
      <label className={styles.rtePopCheck}>
        <input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} />
        <span>Header row</span>
      </label>
    </div>
  )
}

/**
 * Tiptap's image keeps only src and alt, so any width or border a signature carries was
 * dropped the moment it passed through the editor. Preserving the attributes is what makes
 * the image editable at all.
 */
const StyledImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
  renderHTML({ HTMLAttributes }) {
    const { href, ...rest } = HTMLAttributes as Record<string, unknown> & { href?: string | null }
    const image: [string, Record<string, unknown>] = ['img', rest]
    if (!href) return image
    const anchor: [string, Record<string, unknown>, typeof image] = [
      'a',
      { href, target: '_blank', rel: 'noopener noreferrer' },
      image,
    ]
    return anchor
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        // Read off the anchor the image was saved inside, since the node itself is the image.
        parseHTML: element => element.closest('a')?.getAttribute('href') ?? null,
        renderHTML: attributes => (attributes.href ? { href: attributes.href } : {}),
      },
      align: {
        default: null,
        parseHTML: element => element.getAttribute('data-align'),
        renderHTML: attributes => (attributes.align ? { 'data-align': attributes.align } : {}),
      },
      width: {
        default: null,
        parseHTML: element => element.getAttribute('width'),
        renderHTML: attributes => (attributes.width ? { width: attributes.width } : {}),
      },
      height: {
        default: null,
        parseHTML: element => element.getAttribute('height'),
        renderHTML: attributes => (attributes.height ? { height: attributes.height } : {}),
      },
      style: {
        default: null,
        parseHTML: element => element.getAttribute('style'),
        renderHTML: attributes => (attributes.style ? { style: attributes.style } : {}),
      },
    }
  },
})

function stylePairs(value: string | null | undefined): Record<string, string> {
  return Object.fromEntries(
    (value ?? '')
      .split(';')
      .map(part => part.split(':'))
      .filter(pair => pair.length === 2)
      .map(([name, entry]) => [name.trim(), entry.trim()]),
  )
}

function styleText(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .filter(([, entry]) => entry)
    .map(([name, entry]) => `${name}:${entry}`)
    .join(';')
}

const GRIPS = [
  { corner: 'nw', direction: -1, className: 'rteImageGripNW' },
  { corner: 'ne', direction: 1, className: 'rteImageGripNE' },
  { corner: 'sw', direction: -1, className: 'rteImageGripSW' },
  { corner: 'se', direction: 1, className: 'rteImageGripSE' },
] as const

const ALIGNMENTS = [
  { key: 'left', label: 'Align left', glyph: '\u21e4' },
  { key: 'center', label: 'Centre', glyph: '\u2194' },
  { key: 'right', label: 'Align right', glyph: '\u21e5' },
] as const

function reactStyle(pairs: Record<string, string>): React.CSSProperties {
  return Object.fromEntries(
    Object.entries(pairs).map(([name, value]) => [name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]),
  ) as React.CSSProperties
}

/**
 * The image is edited where it sits: selected with an outline, resized by its corners, and
 * given a border, an alignment or a link from a bar anchored to it. A row of number boxes at
 * the top of the toolbar was correct and undiscoverable.
 */
function ImageView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const attributes = node.attrs as {
    src: string
    alt: string | null
    width: string | null
    style: string | null
    href: string | null
    align: string | null
  }
  const declared = stylePairs(attributes.style)
  const framed = Boolean(declared.border) && !['none', '0', '0px'].includes(declared.border)
  const radius = parseInt(declared['border-radius'] ?? '', 10)
  const align = attributes.align ?? 'left'
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [href, setHref] = useState(attributes.href ?? '')
  const width = dragWidth ?? parseInt(String(declared.width ?? attributes.width ?? ''), 10)
  const live = Boolean(selected && editor.isEditable)

  // A mail client reads the width attribute; a browser reads the style. Write both.
  const write = (patch: Record<string, string>) => {
    const next = { ...declared, ...patch }
    const pixels = parseInt(next.width ?? '', 10)
    updateAttributes({ style: styleText(next) || null, width: Number.isFinite(pixels) ? String(pixels) : null })
  }

  // One history entry per drag rather than one per pixel: the width is held here while the
  // pointer is down and committed once it is released.
  const startResize = (event: React.PointerEvent<HTMLSpanElement>, direction: 1 | -1) => {
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = imageRef.current?.getBoundingClientRect().width ?? 200
    let latest = Math.round(startWidth)
    const move = (moveEvent: PointerEvent) => {
      latest = Math.round(Math.min(800, Math.max(24, startWidth + direction * (moveEvent.clientX - startX))))
      setDragWidth(latest)
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
      setDragWidth(null)
      write({ width: `${latest}px`, height: 'auto' })
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }

  const applyLink = () => {
    const target = href.trim() ? safeHref(href) : null
    if (href.trim() && !target) return
    updateAttributes({ href: target })
    setLinkOpen(false)
  }

  return (
    <NodeViewWrapper className={styles.rteImageWrap} data-align={align}>
      <span className={`${styles.rteImageBox} ${live ? styles.rteImageBoxOn : ''}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imageRef}
          src={attributes.src}
          alt={attributes.alt ?? ''}
          draggable={false}
          style={{ ...reactStyle(declared), ...(dragWidth ? { width: `${dragWidth}px`, height: 'auto' } : {}) }}
        />
        {live &&
          GRIPS.map(grip => (
            <span
              key={grip.corner}
              className={`${styles.rteImageGrip} ${styles[grip.className]}`}
              role="presentation"
              onPointerDown={event => startResize(event, grip.direction)}
            />
          ))}
      </span>
      {live && (
        <div className={styles.rteImageBar} contentEditable={false}>
          <span className={styles.rteGridLabel}>W</span>
          <input
            className={styles.rteSizeSelect}
            type="number"
            min={24}
            max={800}
            step={10}
            title="Width in pixels"
            aria-label="Image width in pixels"
            value={Number.isFinite(width) ? width : ''}
            onChange={event => write({ width: event.target.value ? `${event.target.value}px` : '', height: 'auto' })}
          />
          {ALIGNMENTS.map(option => (
            <Btn
              key={option.key}
              title={option.label}
              active={align === option.key}
              onClick={() =>
                updateAttributes({
                  align: option.key,
                  style: styleText({
                    ...declared,
                    'margin-left': option.key === 'left' ? '' : 'auto',
                    'margin-right': option.key === 'right' ? '' : 'auto',
                  }),
                })
              }
            >
              {option.glyph}
            </Btn>
          ))}
          <Btn
            title={framed ? 'Remove the border' : 'Add a border'}
            active={framed}
            onClick={() =>
              write(
                framed
                  ? { border: '', padding: '', 'border-radius': '' }
                  : { border: `1px solid ${CLIENT_BRAND.accent}`, padding: '8px', 'border-radius': '8px' },
              )
            }
            wide
          >
            Border
          </Btn>
          {framed && (
            <>
              <span className={styles.rteGridLabel}>R</span>
              <input
                className={styles.rteSizeSelect}
                type="number"
                min={0}
                max={200}
                title="Corner radius in pixels"
                aria-label="Corner radius in pixels"
                value={Number.isFinite(radius) ? radius : 0}
                onChange={event => write({ 'border-radius': `${event.target.value || 0}px` })}
              />
              {[...new Set([CLIENT_BRAND.accent, ...TEXT_COLOURS])].map(colour => (
                <button
                  key={colour}
                  type="button"
                  className={styles.rteSwatch}
                  style={{ background: colour }}
                  title={`Border colour ${colour}`}
                  aria-label={`Border colour ${colour}`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => write({ border: `1px solid ${colour}` })}
                />
              ))}
              <label className={styles.rteSwatchCustom} title="Any other border colour">
                <input
                  type="color"
                  aria-label="Choose any border colour"
                  onChange={event => write({ border: `1px solid ${event.target.value}` })}
                />
              </label>
            </>
          )}
          <Btn title="Link this image" active={Boolean(attributes.href) || linkOpen} onClick={() => setLinkOpen(open => !open)} wide>
            Link
          </Btn>
          {linkOpen && (
            <>
              <input
                className={styles.rteImageLink}
                value={href}
                placeholder={CLIENT_BRAND.websiteUrl}
                aria-label="Address this image opens"
                onChange={event => setHref(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') applyLink()
                }}
              />
              <Btn
                title="Use the company website"
                onClick={() => {
                  setHref(CLIENT_BRAND.websiteUrl)
                  updateAttributes({ href: CLIENT_BRAND.websiteUrl })
                  setLinkOpen(false)
                }}
                wide
              >
                Website
              </Btn>
              <Btn title="Apply the address" onClick={applyLink} wide>
                Apply
              </Btn>
              {attributes.href && (
                <Btn
                  title="Remove the link"
                  onClick={() => {
                    setHref('')
                    updateAttributes({ href: null })
                    setLinkOpen(false)
                  }}
                  wide
                >
                  Unlink
                </Btn>
              )}
            </>
          )}
        </div>
      )}
    </NodeViewWrapper>
  )
}

function TableTools({ editor }: { editor: Editor }) {
  return (
    <Group>
      <Btn title="Add row" onClick={() => editor.chain().focus().addRowAfter().run()} wide>
        +Row
      </Btn>
      <Btn title="Add column" onClick={() => editor.chain().focus().addColumnAfter().run()} wide>
        +Col
      </Btn>
      <Btn title="Delete row" onClick={() => editor.chain().focus().deleteRow().run()} wide>
        −Row
      </Btn>
      <Btn title="Delete column" onClick={() => editor.chain().focus().deleteColumn().run()} wide>
        −Col
      </Btn>
      <Btn title="Delete table" onClick={() => editor.chain().focus().deleteTable().run()}>
        🗑
      </Btn>
    </Group>
  )
}

type Pop = 'link' | 'image' | 'table' | null

function Toolbar({
  editor,
  uploadImage,
  fonts = [],
  baseFont,
}: {
  editor: Editor
  uploadImage?: (file: File) => Promise<string>
  fonts?: string[]
  baseFont?: BaseFont
}) {
  const [pop, setPop] = useState<Pop>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const phone = usePhone()
  const [palette, setPalette] = useState(false)
  const currentFamily = (editor.getAttributes('textStyle').fontFamily as string | undefined)?.replace(/^['"]|['"]$/g, '') ?? ''
  const defaultFamily = baseFont?.family || 'Arial'
  const defaultSize = (baseFont?.size || '15px').replace('px', '')
  const defaultSpacing = String(lineSpacingOf(baseFont))

  useEffect(() => {
    if (!pop) return
    const onDown = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) setPop(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPop(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pop])

  const openLink = useCallback(() => {
    // Collapsed caret inside an existing link: widen to the whole link so its text and
    // address can be read out and edited as a unit.
    if (editor.isActive('link') && editor.state.selection.empty) {
      editor.chain().extendMarkRange('link').run()
    }
    setPop(current => (current === 'link' ? null : 'link'))
  }, [editor])

  useEffect(() => {
    live(editor).openLink = openLink
  }, [editor, openLink])

  return (
    <>
    <div className={styles.rteToolbar} role="toolbar" aria-label="Formatting">
      <Group>
        <MailSelect
          buttonClassName={styles.rteSelect}
          ariaLabel="Font"
          label="Font"
          prefix={GLYPH.font}
          value={currentFamily}
          options={[{ value: '', label: `${defaultFamily} (default)`, closed: defaultFamily }, ...[...BUILTIN_FONTS, ...fonts.filter(font => !BUILTIN_FONTS.includes(font))].map(font => ({ value: font, label: font }))]}
          optionStyle={font => (font ? { fontFamily: `'${font}', Arial, sans-serif` } : {})}
          onChange={family => {
            if (family) editor.chain().focus().setFontFamily(family).run()
            else editor.chain().focus().unsetFontFamily().run()
          }}
        />
        <MailSelect
          buttonClassName={`${styles.rteSelect} ${styles.rteSizeSelect}`}
          ariaLabel="Font size"
          label="Size"
          placeholder={defaultSize}
          prefix={GLYPH.size}
          editable
          value={(editor.getAttributes('textStyle').fontSize as string | undefined) ?? ''}
          options={[{ value: '', label: `${defaultSize} (default)`, closed: defaultSize }, ...FONT_SIZES.map(size => ({ value: size, label: size.replace('px', '') }))]}
          onChange={raw => {
            const size = /^\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw
            if (!size || /default/i.test(size)) editor.chain().focus().unsetFontSize().run()
            else if (/^\d+(\.\d+)?(px|pt|em|rem|%)$/.test(size)) editor.chain().focus().setFontSize(size).run()
          }}
        />
        <MailSelect
          buttonClassName={`${styles.rteSelect} ${styles.rteSizeSelect}`}
          ariaLabel="Line height"
          label="Line height"
          placeholder={defaultSpacing}
          prefix={GLYPH.spacing}
          editable
          value={editor.getAttributes('paragraph').lineSpacing ? String(editor.getAttributes('paragraph').lineSpacing) : ''}
          options={[{ value: '', label: `${defaultSpacing} (default)`, closed: defaultSpacing }, ...LINE_SPACINGS.map(spacing => ({ value: String(spacing), label: String(spacing) }))]}
          onChange={raw => {
            const spacing = parseFloat(raw)
            if (!raw.trim() || /default/i.test(raw)) editor.chain().focus().updateAttributes('paragraph', { lineSpacing: null }).run()
            else if (isSpacing(spacing)) editor.chain().focus().updateAttributes('paragraph', { lineSpacing: spacing }).run()
          }}
        />
      </Group>

      <Group>
        <Btn title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <strong>B</strong>
        </Btn>
        <Btn title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <em>I</em>
        </Btn>
        <Btn title="Underline" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <u>U</u>
        </Btn>
        <Btn title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <s>S</s>
        </Btn>
      </Group>

      {phone ? (
        <Group>
          <Btn title="Colours" active={palette} onClick={() => setPalette(open => !open)}>
            <span className={styles.rteColourDot} aria-hidden />
          </Btn>
          <Btn title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
            ✕
          </Btn>
        </Group>
      ) : (
        <Group>
          <span className={styles.rteSwatches} role="group" aria-label="Text colour">
            {TEXT_COLOURS.map(colour => (
              <button
                key={colour}
                type="button"
                title={`Text ${colour}`}
                aria-label={`Text colour ${colour}`}
                className={styles.rteSwatch}
                style={{ background: colour }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().setColor(colour).run()}
              />
            ))}
            <label className={styles.rteSwatchCustom} title="Any other colour">
              <input
                type="color"
                aria-label="Choose any text colour"
                onChange={event => editor.chain().focus().setColor(event.target.value).run()}
              />
            </label>
          </span>
          <span className={styles.rteSwatches} role="group" aria-label="Highlight">
            {HIGHLIGHTS.map(colour => (
              <button
                key={colour}
                type="button"
                title={`Highlight ${colour}`}
                aria-label={`Highlight ${colour}`}
                className={`${styles.rteSwatch} ${styles.rteSwatchHi}`}
                style={{ background: colour }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().toggleHighlight({ color: colour }).run()}
              />
            ))}
          </span>
          <Btn title="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
            ✕
          </Btn>
        </Group>
      )}

      <Group>
        <Btn title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          ••
        </Btn>
        <Btn title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          1.
        </Btn>
        <Btn title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          ❝
        </Btn>
        <Btn title="Code" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          {'</>'}
        </Btn>
      </Group>

      <Group>
        {(['left', 'center', 'right', 'justify'] as const).map(align => (
          <Btn
            key={align}
            title={`Align ${align}`}
            active={editor.isActive({ textAlign: align })}
            onClick={() => editor.chain().focus().setTextAlign(align).run()}
          >
            {align === 'left' ? '⇤' : align === 'center' ? '↔' : align === 'right' ? '⇥' : '≡'}
          </Btn>
        ))}
      </Group>

      <div className={styles.rtePopWrap} ref={popRef}>
        <Group>
          <Btn title="Insert link" active={editor.isActive('link') || pop === 'link'} onClick={openLink} wide>
            Link
          </Btn>
          <Btn title="Insert image" active={pop === 'image'} onClick={() => setPop(current => (current === 'image' ? null : 'image'))} wide>
            Image
          </Btn>
          <Btn title="Insert table" active={pop === 'table'} onClick={() => setPop(current => (current === 'table' ? null : 'table'))} wide>
            Table
          </Btn>
          <Btn title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
            —
          </Btn>
        </Group>
        {pop === 'link' && <LinkPopover editor={editor} close={() => setPop(null)} />}
        {pop === 'image' && <ImagePopover editor={editor} close={() => setPop(null)} upload={uploadImage} />}
        {pop === 'table' && <TablePopover editor={editor} close={() => setPop(null)} />}
      </div>

      {editor.isActive('table') && <TableTools editor={editor} />}

      <Group>
        <Btn title="Undo" onClick={() => editor.chain().focus().undo().run()}>
          ↺
        </Btn>
        <Btn title="Redo" onClick={() => editor.chain().focus().redo().run()}>
          ↻
        </Btn>
      </Group>
    </div>
    {phone && (
      <div className={`${styles.rtePalette} ${palette ? styles.rtePaletteOpen : ''}`} aria-hidden={!palette}>
        <span className={styles.rtePaletteGroup} role="group" aria-label="Text colour">
          {TEXT_COLOURS.slice(0, 6).map(colour => (
            <button
              key={colour}
              type="button"
              title={`Text ${colour}`}
              aria-label={`Text colour ${colour}`}
              className={styles.rteSwatch}
              style={{ background: colour }}
              tabIndex={palette ? 0 : -1}
              onMouseDown={event => event.preventDefault()}
              onClick={() => editor.chain().focus().setColor(colour).run()}
            />
          ))}
          <label className={styles.rteSwatchCustom} title="Any other colour">
            <input type="color" aria-label="Choose any text colour" tabIndex={palette ? 0 : -1} onChange={event => editor.chain().focus().setColor(event.target.value).run()} />
          </label>
        </span>
        <span className={styles.rtePaletteGroup} role="group" aria-label="Highlight">
          {HIGHLIGHTS.slice(0, 4).map(colour => (
            <button
              key={colour}
              type="button"
              title={`Highlight ${colour}`}
              aria-label={`Highlight ${colour}`}
              className={`${styles.rteSwatch} ${styles.rteSwatchHi}`}
              style={{ background: colour }}
              tabIndex={palette ? 0 : -1}
              onMouseDown={event => event.preventDefault()}
              onClick={() => editor.chain().focus().toggleHighlight({ color: colour }).run()}
            />
          ))}
        </span>
      </div>
    )}
    </>
  )
}

type TabMark = { doc: ProseMirrorNode; undo: () => void } | null

/**
 * Tab indents the body rather than leaving it; a list item is nested a level instead. A
 * quick second Tab takes that indent back and lets focus move to the next control. Inside a
 * table, Tab keeps moving between cells.
 */
const TabKey = Extension.create<Record<string, never>, { memory: { at: number; mark: TabMark } }>({
  name: 'tabKey',
  addStorage() {
    return { memory: { at: 0, mark: null } }
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const editor = this.editor
        if (editor.isActive('table')) return false
        const field = nextField(editor.state.doc, editor.state.selection.to)
        if (field) {
          editor.commands.setTextSelection(field)
          return true
        }
        const settings = live(editor).settings
        if (!settings.tabIndent) return false
        const { leaving, previous } = tabPress(this.storage.memory, () => null, settings.doubleTabMs)
        if (leaving) {
          if (previous && previous.doc === editor.state.doc) previous.undo()
          return false
        }
        let undo: () => void
        if (editor.can().sinkListItem('listItem')) {
          editor.commands.sinkListItem('listItem')
          undo = () => editor.commands.liftListItem('listItem')
        } else {
          editor.commands.insertContent(TAB_TEXT)
          const end = editor.state.selection.from
          undo = () => editor.commands.deleteRange({ from: end - TAB_TEXT.length, to: end })
        }
        this.storage.memory.mark = { doc: editor.state.doc, undo }
        return true
      },
      'Shift-Tab': () => {
        const editor = this.editor
        if (editor.isActive('table')) return false
        return editor.can().liftListItem('listItem') ? editor.commands.liftListItem('listItem') : false
      },
    }
  },
})

const ComposerShortcuts = Extension.create({
  name: 'composerShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => {
        const submit = live(this.editor).submit
        if (!submit) return false
        submit()
        return true
      },
      'Mod-k': () => {
        const openLink = live(this.editor).openLink
        if (!openLink) return false
        openLink()
        return true
      },
      'Mod-f': () => {
        const openFind = live(this.editor).openFind
        if (!openFind) return false
        openFind()
        return true
      },
    }
  },
})

const isSpacing = (value: number) => Number.isFinite(value) && value >= 0.8 && value <= 3

const LineSpacing = Extension.create({
  name: 'lineSpacing',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          lineSpacing: {
            default: null,
            parseHTML: (element: HTMLElement) => {
              const value = parseFloat(element.style.lineHeight)
              return isSpacing(value) ? value : null
            },
            renderHTML: (attributes: Record<string, unknown>) => {
              const value = attributes.lineSpacing as number | null
              return value ? { style: `line-height:${value};margin:0 0 ${paragraphGap(value)};` } : {}
            },
          },
        },
      },
    ]
  },
})

type Suggestion = {
  kind: 'spelling' | 'repeat' | 'grammar'
  word: string
  from: number
  to: number
  x: number
  y: number
  options: string[]
  message?: string
}

let grammarProbe: Promise<boolean> | null = null
const grammarReady = (headers: () => HeadersInit) =>
  (grammarProbe ??= fetch('/api/mail/grammar', { headers: headers() })
    .then(response => response.json())
    .then(data => Boolean(data?.available))
    .catch(() => false))

const countWords = (text: string) => (text.match(/[A-Za-z\u00C0-\u024F0-9]+(?:['\u2019-][A-Za-z\u00C0-\u024F0-9]+)*/g) ?? []).length

export default function RichEditor({
  html,
  onChange,
  placeholder,
  uploadImage,
  fonts,
  fontFaceCss,
  baseFont,
  writing,
  onWritingChange,
  templates = [],
  onSaveTemplate,
  onDeleteTemplate,
  templateContext,
  companyWords = [],
  onCompanyWords,
  isAdmin = false,
  onSubmit,
  requestHeaders,
}: {
  html: string
  onChange: (html: string) => void
  placeholder?: string
  uploadImage?: (file: File) => Promise<string>
  fonts?: string[]
  fontFaceCss?: string
  baseFont?: BaseFont
  /** Writing tools are on only where this is given: the composer, not the signature editors. */
  writing?: WritingSettings
  onWritingChange?: (next: WritingSettings) => void
  templates?: MailTemplate[]
  onSaveTemplate?: (template: MailTemplate) => void
  onDeleteTemplate?: (id: string) => void
  templateContext?: TemplateContext
  companyWords?: string[]
  onCompanyWords?: (words: string[]) => void
  isAdmin?: boolean
  onSubmit?: () => void
  requestHeaders?: () => HeadersInit
}) {
  const tools = Boolean(writing)
  const settings = writing ?? WRITING_DEFAULTS
  const uploadRef = useRef(uploadImage)
  const editorRef = useRef<Editor | null>(null)
  const settingsRef = useRef(settings)
  const [spellOn, setSpellOn] = useState(settings.spellcheck)
  const [grammarAvailable, setGrammarAvailable] = useState(false)
  const [panel, setPanel] = useState(false)
  const [finding, setFinding] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [replaceWith, setReplaceWith] = useState('')
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [wordCount, setWordCount] = useState(0)
  const [, setTick] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    uploadRef.current = uploadImage
    settingsRef.current = settings
  })

  useEffect(() => {
    if (!tools) return
    let current = true
    void grammarReady(requestHeaders ?? (() => ({}))).then(available => {
      if (current) setGrammarAvailable(available)
    })
    return () => {
      current = false
    }
  }, [tools, requestHeaders])

  // A dropped or pasted image file is uploaded and inserted by URL. Left to the browser,
  // Chrome on Windows inserts it as file:///C:/… — which renders for nobody.
  const placeImages = (files: File[], pos?: number): boolean => {
    const images = files.filter(file => file.type.startsWith('image/'))
    if (!images.length) return false
    const upload = uploadRef.current
    if (!upload) return true
    void (async () => {
      for (const file of images) {
        try {
          const src = await upload(file)
          const chain = editorRef.current?.chain().focus()
          if (!chain) return
          if (pos !== undefined) chain.setTextSelection(pos)
          chain.setImage({ src }).run()
        } catch (err) {
          console.warn('[editor] image upload failed', err)
        }
      }
    })()
    return true
  }

  const openSuggestion = (target: HTMLElement, pos: number) => {
    const editor = editorRef.current
    const wrap = wrapRef.current
    if (!editor || !wrap) return false
    const kind = target.dataset.kind as Suggestion['kind'] | undefined
    if (!kind) return false
    const key = kind === 'grammar' ? grammarKey : spellingKey
    const set = key.getState(editor.state)?.set
    const near = set?.find(pos - 1, pos + 1) ?? []
    const range = near.find(decoration => decoration.from <= pos && decoration.to >= pos) ?? near[0]
    if (!range) return false
    const box = target.getBoundingClientRect()
    const frame = wrap.getBoundingClientRect()
    const base: Suggestion = {
      kind,
      word: editor.state.doc.textBetween(range.from, range.to),
      from: range.from,
      to: range.to,
      x: box.left - frame.left,
      y: box.bottom - frame.top + 4,
      options: [],
      message: target.dataset.message,
    }
    if (kind === 'grammar') {
      try {
        base.options = JSON.parse(target.dataset.replacements ?? '[]')
      } catch {
        base.options = []
      }
      setSuggestion(base)
    } else if (kind === 'repeat') {
      setSuggestion(base)
    } else {
      setSuggestion(base)
      void suggestSpelling(base.word, settingsRef.current.spellLanguage).then(options =>
        setSuggestion(current => (current && current.from === base.from && current.word === base.word ? { ...current, options } : current)),
      )
    }
    return true
  }

  const editor = useEditor({
    // Rendered on the client only: the editor touches the DOM on creation and would
    // otherwise mismatch the server-rendered markup.
    immediatelyRender: false,
    extensions: [
      // StarterKit ships its own link and underline; ours replace them so
      // openOnClick stays off and a link in the composer is editable, not followed.
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, underline: false }),
      Underline,
      TextStyle,
      FontFamily,
      FontSize,
      LineSpacing,
      LiveStore,
      TabKey,
      WritingAssist,
      Spelling,
      Grammar,
      FindReplace,
      ComposerShortcuts,
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      StyledImage.configure({ inline: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: html || '',
    editorProps: {
      attributes: {
        class: styles.rteSurface,
        'aria-label': placeholder ?? 'Message body',
        spellcheck: 'false',
        autocapitalize: tools ? 'sentences' : 'off',
        autocorrect: tools ? 'on' : 'off',
      },
      handleDrop: (view, event) =>
        placeImages(Array.from(event.dataTransfer?.files ?? []), view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos),
      handleKeyDown: (_view, event) => {
        if (event.key === 'Escape') setSuggestion(null)
        return false
      },
      handlePaste: (_view, event) => placeImages(Array.from(event.clipboardData?.files ?? [])),
      transformPastedHTML: pasted => (settingsRef.current.cleanPaste ? cleanPastedHtml(pasted) : pasted),
      handleClick: (_view, pos, event) => {
        const target = (event.target as HTMLElement | null)?.closest('[data-kind]') as HTMLElement | null
        if (!target) {
          setSuggestion(null)
          return false
        }
        return openSuggestion(target, pos)
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getHTML())
      setWordCount(countWords(instance.state.doc.textContent))
    },
    onCreate: ({ editor: instance }) => setWordCount(countWords(instance.state.doc.textContent)),
    onTransaction: () => setTick(tick => tick + 1),
  })

  // Only push content in when it changed elsewhere — writing on every keystroke would
  // reset the cursor to the start of the document.
  useEffect(() => {
    if (!editor) return
    // An empty document reads back as <p></p>, so compare against that rather than the
    // empty string — otherwise every render while empty resets the caret.
    if ((html || '<p></p>') !== editor.getHTML()) editor.commands.setContent(html || '', { emitUpdate: false })
  }, [html, editor])

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    Object.assign(live(editor), {
      tools,
      settings,
      templates,
      context: templateContext ?? {},
      words: [...settings.personalWords, ...companyWords],
      spellOn: tools && spellOn,
      grammarOn: tools && settings.grammar && grammarAvailable,
      headers: requestHeaders ?? (() => ({})),
      submit: onSubmit,
      openFind: tools
        ? () => {
            setFinding(true)
            window.setTimeout(() => findInputRef.current?.select(), 0)
          }
        : undefined,
    })
  })

  const personalKey = settings.personalWords.join('|')
  const companyKey = companyWords.join('|')
  useEffect(() => {
    if (!editor || !tools || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(spellingKey, 'refresh').setMeta('addToHistory', false))
  }, [editor, tools, spellOn, settings.spellLanguage, settings.ignoreCapitals, settings.ignoreWithNumbers, settings.repeatedWords, personalKey, companyKey])

  useEffect(() => {
    if (!editor || !tools || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(grammarKey, 'refresh').setMeta('addToHistory', false))
  }, [editor, tools, settings.grammar, grammarAvailable, settings.spellLanguage])

  useEffect(() => {
    if (!editor || !tools || editor.isDestroyed) return
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: finding ? findQuery : '', index: 0 }).setMeta('addToHistory', false))
  }, [editor, tools, finding, findQuery])

  if (!editor) return <div className={styles.rteLoading} />

  const matches = tools && finding ? findMatches(editor.state.doc, findQuery) : []
  const findIndex = matches.length ? ((findState(editor.state).index % matches.length) + matches.length) % matches.length : 0
  const moveFind = (step: number) => {
    if (!matches.length) return
    const next = (findIndex + step + matches.length) % matches.length
    editor.view.dispatch(editor.state.tr.setMeta(findKey, { query: findQuery, index: next }))
    editor.commands.setTextSelection(matches[next])
    editor.commands.scrollIntoView()
  }
  const replaceCurrent = () => {
    const match = matches[findIndex]
    if (!match) return
    editor.chain().insertContentAt(match, replaceWith).run()
  }
  const replaceAll = () => {
    if (!matches.length) return
    const tr = editor.state.tr
    for (const match of [...matches].reverse()) tr.insertText(replaceWith, match.from, match.to)
    editor.view.dispatch(tr)
  }

  const applySuggestion = (text: string) => {
    if (!suggestion) return
    editor.chain().focus().insertContentAt({ from: suggestion.from, to: suggestion.to }, text).run()
    setSuggestion(null)
  }
  const ignoreSuggestion = () => {
    if (!suggestion) return
    if (suggestion.kind === 'grammar') {
      const grammar = (editor.storage as unknown as Record<string, { ignored?: Set<string> }>).grammar
      grammar?.ignored?.add(grammarIgnoreKey(suggestion.word, suggestion.message ?? ''))
      const current = grammarKey.getState(editor.state)?.set
      if (current) editor.view.dispatch(editor.state.tr.setMeta(grammarKey, current.remove(current.find(suggestion.from, suggestion.to))).setMeta('addToHistory', false))
      setSuggestion(null)
      return
    }
    const spelling = (editor.storage as unknown as Record<string, { ignored?: Set<string> }>).spelling
    spelling?.ignored?.add(suggestion.word.toLowerCase())
    editor.view.dispatch(editor.state.tr.setMeta(spellingKey, 'refresh').setMeta('addToHistory', false))
    setSuggestion(null)
  }
  const removeRepeat = () => {
    if (!suggestion) return
    const before = editor.state.doc.textBetween(Math.max(0, suggestion.from - 1), suggestion.from)
    editor.chain().focus().deleteRange({ from: /\s/.test(before) ? suggestion.from - 1 : suggestion.from, to: suggestion.to }).run()
    setSuggestion(null)
  }
  const insertTemplate = (template: MailTemplate) => {
    const at = editor.state.selection.from
    editor.chain().focus().insertContent(fillTemplate(template.html, templateContext ?? {})).run()
    const field = nextField(editor.state.doc, at)
    if (field) editor.commands.setTextSelection(field)
    setPanel(false)
  }

  return (
    <div
      className={styles.rte}
      style={{ '--rte-font': fontStack(baseFont?.family ?? ''), '--rte-size': baseFont?.size || '15px', '--rte-lead': String(lineSpacingOf(baseFont)), '--rte-gap': paragraphGap(lineSpacingOf(baseFont)) } as React.CSSProperties}
    >
      {fontFaceCss && <style>{fontFaceCss}</style>}
      <Toolbar editor={editor} uploadImage={uploadImage} fonts={fonts} baseFont={baseFont} />
      {tools && finding && (
        <div className={styles.rteFindBar} role="search">
          <input
            ref={findInputRef}
            className={styles.rteFindInput}
            placeholder="Find"
            value={findQuery}
            onChange={event => setFindQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                moveFind(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') setFinding(false)
            }}
          />
          <span className={styles.rteFindCount}>{findQuery ? (matches.length ? `${findIndex + 1} of ${matches.length}` : 'No matches') : ''}</span>
          <button type="button" className={styles.rteFindBtn} onClick={() => moveFind(-1)} aria-label="Previous match">↑</button>
          <button type="button" className={styles.rteFindBtn} onClick={() => moveFind(1)} aria-label="Next match">↓</button>
          <input className={styles.rteFindInput} placeholder="Replace with" value={replaceWith} onChange={event => setReplaceWith(event.target.value)} />
          <button type="button" className={styles.rteFindBtn} onClick={replaceCurrent} disabled={!matches.length}>Replace</button>
          <button type="button" className={styles.rteFindBtn} onClick={replaceAll} disabled={!matches.length}>All</button>
          <button type="button" className={styles.rteFindBtn} onClick={() => setFinding(false)} aria-label="Close find">×</button>
        </div>
      )}
      <div ref={wrapRef} className={styles.rteBody}>
        {tools && (
          <div className={styles.rteCorner}>
            <button
              type="button"
              className={`${styles.rteCornerBtn} ${spellOn ? styles.rteCornerOn : ''}`}
              aria-pressed={spellOn}
              title={spellOn ? 'Spelling check is on for this message — click to turn it off' : 'Spelling check is off for this message — click to turn it on'}
              onClick={() => setSpellOn(on => !on)}
            >
              <span aria-hidden>✓</span>Aa
            </button>
            <button
              type="button"
              className={`${styles.rteCornerBtn} ${panel ? styles.rteCornerOn : ''}`}
              aria-expanded={panel}
              title="Writing tools"
              onClick={() => setPanel(open => !open)}
            >
              <span aria-hidden className={styles.rteGear}>⚙</span>
            </button>
          </div>
        )}
        <EditorContent editor={editor} className={styles.rteContent} />
        {tools && settings.wordCount && <div className={styles.rteWordCount}>{wordCount} {wordCount === 1 ? 'word' : 'words'}</div>}
        {tools && panel && writing && onWritingChange && (
          <WritingPanel
            settings={writing}
            onChange={onWritingChange}
            templates={templates}
            onSaveTemplate={onSaveTemplate}
            onDeleteTemplate={onDeleteTemplate}
            onInsertTemplate={insertTemplate}
            currentHtml={editor.getHTML()}
            companyWords={companyWords}
            onCompanyWords={onCompanyWords}
            isAdmin={isAdmin}
            grammarAvailable={grammarAvailable}
            onClose={() => setPanel(false)}
          />
        )}
        {suggestion && (
          <div className={styles.rteSuggest} style={{ left: suggestion.x, top: suggestion.y }} role="menu">
            {suggestion.kind === 'grammar' && suggestion.message && <p className={styles.rteSuggestNote}>{suggestion.message}</p>}
            {suggestion.kind === 'repeat' ? (
              <button type="button" className={styles.rteSuggestPick} onClick={removeRepeat}>Remove the repeated “{suggestion.word}”</button>
            ) : (
              <>
                {suggestion.options.length > 0 ? (
                  suggestion.options.map(option => (
                    <button key={option} type="button" className={styles.rteSuggestPick} onClick={() => applySuggestion(option)}>{option}</button>
                  ))
                ) : (
                  <p className={styles.rteSuggestNote}>{suggestion.kind === 'spelling' ? 'Looking for suggestions…' : 'No suggestion'}</p>
                )}
                <div className={styles.rteSuggestActions}>
                  <button type="button" onClick={ignoreSuggestion}>Ignore</button>
                  {suggestion.kind === 'spelling' && onWritingChange && writing && (
                    <button
                      type="button"
                      onClick={() => {
                        onWritingChange({ ...writing, personalWords: [...new Set([...writing.personalWords, suggestion.word])] })
                        setSuggestion(null)
                      }}
                    >
                      Add to dictionary
                    </button>
                  )}
                  {suggestion.kind === 'spelling' && isAdmin && onCompanyWords && (
                    <button
                      type="button"
                      onClick={() => {
                        onCompanyWords([...new Set([...companyWords, suggestion.word])])
                        setSuggestion(null)
                      }}
                    >
                      Add for the company
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
