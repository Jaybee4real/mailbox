import { Extension } from '@tiptap/react'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type FindState = { query: string; index: number }
export const findKey = new PluginKey<FindState>('find')

export function findMatches(doc: ProseMirrorNode, query: string): Array<{ from: number; to: number }> {
  const needle = query.toLowerCase()
  if (!needle) return []
  const out: Array<{ from: number; to: number }> = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true
    const haystack = node.text.toLowerCase()
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      out.push({ from: pos + at, to: pos + at + needle.length })
    }
    return false
  })
  return out
}

export const findState = (state: EditorState): FindState => findKey.getState(state) ?? { query: '', index: 0 }

/** Highlights every match of the find bar's query, the current one more strongly. */
export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', index: 0 }),
          apply: (tr, value) => (tr.getMeta(findKey) as FindState | undefined) ?? value,
        },
        props: {
          decorations: state => {
            const { query, index } = findState(state)
            const matches = findMatches(state.doc, query)
            if (!matches.length) return DecorationSet.empty
            const current = ((index % matches.length) + matches.length) % matches.length
            return DecorationSet.create(
              state.doc,
              matches.map((match, position) => Decoration.inline(match.from, match.to, { class: position === current ? 'rteFindCurrent' : 'rteFind' })),
            )
          },
        },
      }),
    ]
  },
})
