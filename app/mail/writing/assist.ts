import { Extension } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { correctWord, formatAmount, startsSentence } from './text'
import { TEMPLATE_FIELD, fillTemplate, normaliseShortcut } from './templates'
import { live } from './live'

type Revert = { doc: ProseMirrorNode; from: number; to: number; original: string }

/** What a word after a full stop turns out to be when the stop belonged to an address or a file name. */
const ADDRESS_ENDINGS = new Set([
  'com', 'ng', 'org', 'net', 'io', 'co', 'uk', 'africa', 'info', 'gov', 'edu', 'biz', 'me', 'app', 'dev', 'us', 'za', 'gh', 'ke',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'zip', 'txt', 'html', 'eml', 'msg',
])

const BOUNDARY = /^[\s.,!?;:)\]"'”’]$/

function inCode(view: EditorView, pos: number): boolean {
  const $pos = view.state.doc.resolve(pos)
  if ($pos.parent.type.name === 'codeBlock') return true
  return $pos.marks().some(mark => mark.type.name === 'code')
}

/** The next {field} after the caret, or the first one in the message. */
export function nextField(doc: ProseMirrorNode, after: number): { from: number; to: number } | null {
  let first: { from: number; to: number } | null = null
  let next: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (next || !node.isText || !node.text) return !next
    for (const match of node.text.matchAll(TEMPLATE_FIELD)) {
      const range = { from: pos + (match.index ?? 0), to: pos + (match.index ?? 0) + match[0].length }
      if (!first) first = range
      if (range.from >= after && !next) next = range
    }
    return !next
  })
  return next ?? first
}

/**
 * The small corrections made while typing: a capital to start a sentence, "I" on its own,
 * common typos, naira amounts, and template shortcuts. Each is one Backspace from undone.
 */
export const WritingAssist = Extension.create<Record<string, never>, { revert: Revert | null; spaced: number | null }>({
  name: 'writingAssist',
  addStorage() {
    return { revert: null, spaced: null }
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const revert = this.storage.revert
        this.storage.revert = null
        if (!revert || revert.doc !== this.editor.state.doc) return false
        this.editor.view.dispatch(this.editor.state.tr.insertText(revert.original, revert.from, revert.to))
        return true
      },
    }
  },
  addProseMirrorPlugins() {
    const storage = this.storage
    const editor = this.editor
    const remember = (view: EditorView, from: number, to: number, original: string) => {
      storage.revert = { doc: view.state.doc, from, to, original }
    }
    return [
      new Plugin({
        key: new PluginKey('writingAssist'),
        props: {
          handleTextInput: (view, from, to, text) => {
            storage.revert = null
            if (from !== to || text.length !== 1 || inCode(view, from)) return false
            const state = live(editor)
            if (!state.tools) return false
            const settings = state.settings
            const $from = view.state.doc.resolve(from)
            const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')

            // A letter straight after the stop: the space was missed, so it goes in with the capital.
            if (settings.autoCapitalize && settings.spaceAfterStop && /[A-Za-z]/.test(text) && /[A-Za-z]{2}[.!?]$/.test(before) && startsSentence(`${before} `)) {
              view.dispatch(view.state.tr.insertText(` ${text.toUpperCase()}`, from, to))
              remember(view, from, from + 2, text)
              storage.spaced = before.endsWith('.') ? from : null
              return true
            }

            if (settings.autoCapitalize && /[a-z]/.test(text) && startsSentence(before)) {
              view.dispatch(view.state.tr.insertText(text.toUpperCase(), from, to))
              remember(view, from, from + 1, text)
              return true
            }

            if (!BOUNDARY.test(text)) return false
            const word = before.match(/([^\s￼]+)$/)?.[1]
            const spaced = storage.spaced
            storage.spaced = null
            if (!word) return false
            const start = from - word.length

            // "metroperil. Com" was an address after all: take the space and the capital back out.
            if (spaced !== null && start === spaced + 1 && ADDRESS_ENDINGS.has(word.toLowerCase())) {
              view.dispatch(view.state.tr.insertText(word.toLowerCase() + text, spaced, to))
              return true
            }

            if (settings.templateShortcuts && word.startsWith(';') && text === ' ') {
              const shortcut = normaliseShortcut(word)
              const template = state.templates.find(entry => normaliseShortcut(entry.shortcut) === shortcut)
              if (template) {
                editor.chain().focus().deleteRange({ from: start, to }).insertContent(fillTemplate(template.html, state.context)).run()
                const field = nextField(editor.state.doc, start)
                if (field) editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, field.from, field.to)))
                return true
              }
            }

            const bare = word.replace(/^["'“‘(\[]+/, '')
            const offset = word.length - bare.length
            let replacement: string | null = null
            if (settings.capitalizeI && bare === 'i') replacement = 'I'
            else if (settings.autocorrect) replacement = correctWord(bare)
            if (!replacement && settings.amountFormat) {
              const previous = before.slice(0, start).match(/(\S+)\s+$/)?.[1] ?? ''
              replacement = formatAmount(bare, { nairaLetter: settings.nairaLetter, plainNumbers: settings.numberFormat }, previous)
            }
            if (!replacement) return false

            const wordFrom = start + offset
            const tr = view.state.tr.insertText(replacement + text, wordFrom, to)
            view.dispatch(tr)
            remember(view, wordFrom, wordFrom + replacement.length, bare)
            return true
          },
        },
      }),
    ]
  },
})
