import type { KeyboardEvent } from 'react'

/** Two presses closer together than this leave the field instead of indenting twice. */
export const DOUBLE_TAB_MS = 400

/** Four no-break spaces: a tab character collapses to a single space in most mail clients. */
export const TAB_TEXT = '    '

/**
 * Whether this Tab is the second of a quick pair. The first press is remembered with a way
 * to take its indent back, which the second press uses before letting focus move on.
 */
export function tabPress<Mark>(
  memory: { at: number; mark: Mark | null },
  mark: () => Mark,
  windowMs: number = DOUBLE_TAB_MS,
): { leaving: boolean; previous: Mark | null } {
  const now = Date.now()
  if (now - memory.at < windowMs) {
    const previous = memory.mark
    memory.at = 0
    memory.mark = null
    return { leaving: true, previous }
  }
  memory.at = now
  memory.mark = mark()
  return { leaving: false, previous: null }
}

const textareaMemory = new WeakMap<HTMLTextAreaElement, { at: number; mark: { value: string; caret: number } | null }>()

/** Tab indents inside a composing textarea; a quick second Tab removes that indent and moves on. */
export function handleComposeTab(event: KeyboardEvent<HTMLTextAreaElement>, indent: string = TAB_TEXT) {
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  const field = event.currentTarget
  let memory = textareaMemory.get(field)
  if (!memory) {
    memory = { at: 0, mark: null }
    textareaMemory.set(field, memory)
  }
  const { leaving, previous } = tabPress(memory, () => ({ value: '', caret: -1 }))
  if (leaving) {
    if (previous && previous.value === field.value && field.selectionStart === previous.caret) {
      field.setSelectionRange(previous.caret - indent.length, previous.caret)
      document.execCommand('delete')
    }
    return
  }
  event.preventDefault()
  document.execCommand('insertText', false, indent)
  memory.mark = { value: field.value, caret: field.selectionStart }
}
