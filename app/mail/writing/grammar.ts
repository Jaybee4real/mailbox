import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { live } from './live'

type GrammarState = { set: DecorationSet; version: number }
export const grammarKey = new PluginKey<GrammarState>('grammar')

type Match = { offset: number; length: number; message: string; replacements: string[] }

/** Blue underlines from the company's own grammar server, fetched when typing pauses. */
export const grammarIgnoreKey = (text: string, message: string) => `${text.toLowerCase()}|${message}`

export const Grammar = Extension.create<Record<string, never>, { ignored: Set<string> }>({
  name: 'grammar',
  addStorage() {
    return { ignored: new Set<string>() }
  },
  addProseMirrorPlugins() {
    const editor = this.editor
    const ignored = this.storage.ignored
    let timer: ReturnType<typeof setTimeout> | null = null
    let asked = 0

    const run = async (view: EditorView) => {
      const current = live(editor)
      if (!current.tools || !current.grammarOn) {
        view.dispatch(view.state.tr.setMeta(grammarKey, DecorationSet.empty))
        return
      }
      const blocks: Array<{ start: number; text: string; at: number }> = []
      let text = ''
      view.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true
        if (node.type.name === 'codeBlock') return false
        const content = node.textBetween(0, node.content.size, undefined, '￼')
        if (content.trim()) {
          blocks.push({ start: pos + 1, text: content, at: text.length })
          text += `${content}\n\n`
        }
        return false
      })
      if (!text.trim()) return view.dispatch(view.state.tr.setMeta(grammarKey, DecorationSet.empty))
      const ticket = ++asked
      const doc = view.state.doc
      const response = await fetch('/api/mail/grammar', {
        method: 'POST',
        headers: { ...Object.fromEntries(new Headers(current.headers()).entries()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 20000), language: current.settings.spellLanguage }),
      }).catch(() => null)
      const data = response?.ok ? ((await response.json().catch(() => null)) as { matches?: Match[] } | null) : null
      if (ticket !== asked || view.isDestroyed || !view.state.doc.eq(doc)) return
      const decorations = (data?.matches ?? []).flatMap(match => {
        const block = blocks.find(entry => match.offset >= entry.at && match.offset + match.length <= entry.at + entry.text.length)
        if (!block) return []
        const from = block.start + (match.offset - block.at)
        if (ignored.has(grammarIgnoreKey(view.state.doc.textBetween(from, from + match.length), match.message))) return []
        return [
          Decoration.inline(from, from + match.length, {
            class: 'rteGrammar',
            'data-kind': 'grammar',
            'data-message': match.message,
            'data-replacements': JSON.stringify(match.replacements.slice(0, 5)),
          }),
        ]
      })
      view.dispatch(view.state.tr.setMeta(grammarKey, DecorationSet.create(view.state.doc, decorations)))
    }

    return [
      new Plugin<GrammarState>({
        key: grammarKey,
        state: {
          init: () => ({ set: DecorationSet.empty, version: 0 }),
          apply(tr, value) {
            const meta = tr.getMeta(grammarKey) as DecorationSet | 'refresh' | undefined
            if (meta instanceof DecorationSet) return { set: meta, version: value.version }
            if (meta === 'refresh') return { set: value.set, version: value.version + 1 }
            return { set: value.set.map(tr.mapping, tr.doc), version: value.version }
          },
        },
        props: { decorations: state => grammarKey.getState(state)?.set },
        view: view => {
          timer = setTimeout(() => void run(view), 800)
          return {
            update: (next, previous) => {
              const refreshed = grammarKey.getState(next.state)?.version !== grammarKey.getState(previous)?.version
              if (!refreshed && next.state.doc.eq(previous.doc)) return
              if (timer) clearTimeout(timer)
              timer = setTimeout(() => void run(next), refreshed ? 0 : 1500)
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
