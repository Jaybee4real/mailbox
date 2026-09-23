import { Extension, type Editor } from '@tiptap/react'
import { WRITING_DEFAULTS, type WritingSettings } from './settings'
import type { MailTemplate, TemplateContext } from './templates'

/** What the writing tools need from the page, written after each render and read on keypress. */
export type Live = {
  tools: boolean
  settings: WritingSettings
  templates: MailTemplate[]
  context: TemplateContext
  words: string[]
  spellOn: boolean
  grammarOn: boolean
  headers: () => HeadersInit
  submit?: () => void
  openLink?: () => void
  openFind?: () => void
}

export const LiveStore = Extension.create<Record<string, never>, Live>({
  name: 'writingLive',
  addStorage: () => ({
    tools: false,
    settings: WRITING_DEFAULTS,
    templates: [],
    context: {},
    words: [],
    spellOn: false,
    grammarOn: false,
    headers: () => ({}),
  }),
})

export const live = (editor: Editor): Live => (editor.storage as unknown as { writingLive: Live }).writingLive
