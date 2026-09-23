import { Extension } from '@tiptap/react'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { WritingSettings } from './settings'
import { live } from './live'
import { checkableWord, wordsOf } from './text'

let worker: Worker | null = null
let nextId = 1
const waiting = new Map<number, (reply: { wrong?: string[]; suggestions?: string[] }) => void>()

function ask<T>(message: Record<string, unknown>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./spell.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      const resolve = waiting.get(event.data.id)
      waiting.delete(event.data.id)
      resolve?.(event.data)
    }
  }
  const id = nextId++
  return new Promise(resolve => {
    waiting.set(id, resolve as (reply: { wrong?: string[]; suggestions?: string[] }) => void)
    worker!.postMessage({ id, ...message })
  })
}

export const suggestSpelling = (word: string, language: string) =>
  ask<{ suggestions?: string[] }>({ type: 'suggest', language, word }).then(reply => reply.suggestions ?? [])

type SpellState = { set: DecorationSet; version: number }

export const spellingKey = new PluginKey<SpellState>('spelling')

type Found = { from: number; to: number; word: string; kind: 'spelling' | 'repeat' }

function collect(doc: ProseMirrorNode, settings: WritingSettings): Found[] {
  const found: Found[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false
    if (!node.isText || !node.text) return true
    if (node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return false
    const words = wordsOf(node.text)
    words.forEach((entry, index) => {
      const previous = words[index - 1]
      if (
        settings.repeatedWords &&
        previous &&
        previous.word.toLowerCase() === entry.word.toLowerCase() &&
        /^\s+$/.test(node.text!.slice(previous.end, entry.start)) &&
        !/^\d+$/.test(entry.word)
      ) {
        found.push({ from: pos + entry.start, to: pos + entry.end, word: entry.word, kind: 'repeat' })
      }
      found.push({ from: pos + entry.start, to: pos + entry.end, word: entry.word, kind: 'spelling' })
    })
    return false
  })
  return found
}

/**
 * Red underlines under words the dictionary does not know, and a softer one under a word
 * repeated by accident. Drawn as decorations, so nothing is added to the message itself.
 */
export const Spelling = Extension.create<Record<string, never>, { verdicts: Map<string, boolean>; ignored: Set<string> }>({
  name: 'spelling',
  addStorage() {
    return { verdicts: new Map(), ignored: new Set() }
  },
  addProseMirrorPlugins() {
    const storage = this.storage
    const editor = this.editor
    let timer: ReturnType<typeof setTimeout> | null = null
    let language = ''

    const build = (state: EditorState): DecorationSet => {
      const current = live(editor)
      if (!current.tools || !current.spellOn) return DecorationSet.empty
      const settings = current.settings
      const known = new Set(current.words.map(word => word.toLowerCase()))
      const head = state.selection.empty ? state.selection.head : -1
      const decorations: Decoration[] = []
      for (const entry of collect(state.doc, settings)) {
        if (entry.kind === 'repeat') {
          decorations.push(Decoration.inline(entry.from, entry.to, { class: 'rteRepeat', 'data-word': entry.word, 'data-kind': 'repeat' }))
          continue
        }
        if (entry.to === head) continue
        if (!checkableWord(entry.word, settings)) continue
        const key = entry.word.toLowerCase()
        if (known.has(key) || storage.ignored.has(key)) continue
        if (storage.verdicts.get(entry.word) === false) {
          decorations.push(Decoration.inline(entry.from, entry.to, { class: 'rteMisspelt', 'data-word': entry.word, 'data-kind': 'spelling' }))
        }
      }
      return DecorationSet.create(state.doc, decorations)
    }

    const refresh = (view: EditorView) => {
      const { settings, tools, spellOn } = live(editor)
      if (!tools || !spellOn) {
        view.dispatch(view.state.tr.setMeta(spellingKey, DecorationSet.empty))
        return
      }
      if (language !== settings.spellLanguage) {
        storage.verdicts.clear()
        language = settings.spellLanguage
      }
      const unknown = [
        ...new Set(
          collect(view.state.doc, settings)
            .filter(entry => entry.kind === 'spelling' && checkableWord(entry.word, settings) && !storage.verdicts.has(entry.word))
            .map(entry => entry.word),
        ),
      ]
      const draw = () => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(spellingKey, build(view.state)))
      }
      if (!unknown.length) return draw()
      void ask<{ wrong?: string[] }>({ type: 'check', language, words: unknown }).then(reply => {
        const wrong = new Set(reply.wrong ?? [])
        for (const word of unknown) storage.verdicts.set(word, !wrong.has(word))
        draw()
      })
    }

    const schedule = (view: EditorView, delay: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => refresh(view), delay)
    }

    return [
      new Plugin<SpellState>({
        key: spellingKey,
        state: {
          init: () => ({ set: DecorationSet.empty, version: 0 }),
          apply(tr, value) {
            const meta = tr.getMeta(spellingKey) as DecorationSet | 'refresh' | undefined
            if (meta instanceof DecorationSet) return { set: meta, version: value.version }
            if (meta === 'refresh') return { set: value.set, version: value.version + 1 }
            return { set: value.set.map(tr.mapping, tr.doc), version: value.version }
          },
        },
        props: {
          decorations: state => spellingKey.getState(state)?.set,
        },
        view: view => {
          schedule(view, 50)
          return {
            update: (next, previous) => {
              const refreshed = spellingKey.getState(next.state)?.version !== spellingKey.getState(previous)?.version
              if (refreshed || !next.state.doc.eq(previous.doc)) schedule(next, refreshed ? 0 : 450)
            },
            destroy: () => {
              if (timer) clearTimeout(timer)
            },
          }
        },
      }),
    ]
  },
})
