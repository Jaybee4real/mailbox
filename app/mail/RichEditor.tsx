'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import { FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { BUILTIN_FONTS, FONT_SIZES, fontStack, type BaseFont } from '@/lib/fonts'
import MailSelect from './MailSelect'
import { Color } from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { safeHref } from '@/lib/email-html'
import styles from './page.module.css'

const TEXT_COLOURS = ['#030712', '#b91c1c', '#1d4ed8', '#047857', '#b45309', '#6d28d9', '#6b7280']
const HIGHLIGHTS = ['#FEF08A', '#BBF7D0', '#BFDBFE', '#FBCFE8', '#FED7AA']
const SIZES: Array<{ label: string; level: 1 | 2 | 3 | null }> = [
  { label: 'Body', level: null },
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
]

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

function Toolbar({ editor, uploadImage, fonts = [] }: { editor: Editor; uploadImage?: (file: File) => Promise<string>; fonts?: string[] }) {
  const [pop, setPop] = useState<Pop>(null)
  const popRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className={styles.rteToolbar} role="toolbar" aria-label="Formatting">
      <Group>
        <MailSelect
          buttonClassName={styles.rteSelect}
          ariaLabel="Text style"
          value={SIZES.find(size => size.level && editor.isActive('heading', { level: size.level }))?.label ?? 'Body'}
          options={SIZES.map(size => ({ value: size.label, label: size.label }))}
          onChange={label => {
            const size = SIZES.find(entry => entry.label === label)
            if (!size) return
            const chain = editor.chain().focus()
            if (size.level) chain.setHeading({ level: size.level }).run()
            else chain.setParagraph().run()
          }}
        />
        <MailSelect
          buttonClassName={styles.rteSelect}
          ariaLabel="Font"
          placeholder="Font"
          value={(editor.getAttributes('textStyle').fontFamily as string | undefined)?.replace(/^['"]|['"]$/g, '') ?? ''}
          options={[{ value: '', label: 'Default font' }, ...[...BUILTIN_FONTS, ...fonts.filter(font => !BUILTIN_FONTS.includes(font))].map(font => ({ value: font, label: font }))]}
          optionStyle={font => (font ? { fontFamily: `'${font}', Arial, sans-serif` } : {})}
          onChange={family => {
            if (family) editor.chain().focus().setFontFamily(family).run()
            else editor.chain().focus().unsetFontFamily().run()
          }}
        />
        <MailSelect
          buttonClassName={`${styles.rteSelect} ${styles.rteSizeSelect}`}
          ariaLabel="Font size"
          placeholder="Size"
          editable
          value={(editor.getAttributes('textStyle').fontSize as string | undefined) ?? ''}
          options={[{ value: '', label: 'Default' }, ...FONT_SIZES.map(size => ({ value: size, label: size.replace('px', '') }))]}
          onChange={raw => {
            const size = /^\d+(\.\d+)?$/.test(raw) ? `${raw}px` : raw
            if (!size || size === 'Default') editor.chain().focus().unsetFontSize().run()
            else if (/^\d+(\.\d+)?(px|pt|em|rem|%)$/.test(size)) editor.chain().focus().setFontSize(size).run()
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
  )
}

export default function RichEditor({
  html,
  onChange,
  placeholder,
  uploadImage,
  fonts,
  fontFaceCss,
  baseFont,
}: {
  html: string
  onChange: (html: string) => void
  placeholder?: string
  uploadImage?: (file: File) => Promise<string>
  fonts?: string[]
  fontFaceCss?: string
  baseFont?: BaseFont
}) {
  const uploadRef = useRef(uploadImage)
  const editorRef = useRef<Editor | null>(null)
  useEffect(() => {
    uploadRef.current = uploadImage
  }, [uploadImage])

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
      Color,
      Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image.configure({ inline: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: html || '',
    editorProps: {
      attributes: { class: styles.rteSurface, 'aria-label': placeholder ?? 'Message body' },
      handleDrop: (view, event) =>
        placeImages(Array.from(event.dataTransfer?.files ?? []), view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos),
      handlePaste: (_view, event) => placeImages(Array.from(event.clipboardData?.files ?? [])),
    },
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
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

  if (!editor) return <div className={styles.rteLoading} />

  return (
    <div
      className={styles.rte}
      style={{ '--rte-font': fontStack(baseFont?.family ?? ''), '--rte-size': baseFont?.size || '15px' } as React.CSSProperties}
    >
      {fontFaceCss && <style>{fontFaceCss}</style>}
      <Toolbar editor={editor} uploadImage={uploadImage} fonts={fonts} />
      <EditorContent editor={editor} className={styles.rteContent} />
    </div>
  )
}
