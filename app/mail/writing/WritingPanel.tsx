'use client'

import { useState } from 'react'
import styles from '../page.module.css'
import MailSelect from '../MailSelect'
import type { WritingSettings } from './settings'
import { normaliseShortcut, type MailTemplate } from './templates'

type Tab = 'writing' | 'checks' | 'templates' | 'dictionary' | 'shortcuts'

const SHORTCUTS: Array<[string, string]> = [
  ['Tab', 'Indent, or nest a list item; jumps to the next {field} in a template'],
  ['Tab Tab (quickly)', 'Leave the message for the next control'],
  ['Shift Tab', 'Move a list item back out'],
  ['⌘/Ctrl B · I · U', 'Bold · italic · underline'],
  ['⌘/Ctrl K', 'Add or edit a link'],
  ['⌘/Ctrl Shift 7 · 8', 'Numbered list · bullet list'],
  ['⌘/Ctrl Shift V', 'Paste without formatting'],
  ['⌘/Ctrl F', 'Find and replace in this message'],
  ['⌘/Ctrl Z · Shift Z', 'Undo · redo'],
  ['⌘/Ctrl Enter', 'Send'],
  ['Backspace', 'Straight after an automatic change, puts back what you typed'],
  [';shortcut then Space', 'Insert a saved template'],
  ['- · 1. · > then Space', 'Start a bullet list · numbered list · quote'],
]

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <label className={styles.wpRow}>
      <span className={styles.wpText}>
        <span className={styles.wpLabel}>{label}</span>
        {hint && <span className={styles.wpHint}>{hint}</span>}
      </span>
      <input type="checkbox" className={styles.wpSwitch} checked={checked} onChange={event => onChange(event.target.checked)} />
    </label>
  )
}

export default function WritingPanel({
  settings,
  onChange,
  templates,
  onSaveTemplate,
  onDeleteTemplate,
  onInsertTemplate,
  currentHtml,
  companyWords,
  onCompanyWords,
  isAdmin,
  grammarAvailable,
  onClose,
}: {
  settings: WritingSettings
  onChange: (next: WritingSettings) => void
  templates: MailTemplate[]
  onSaveTemplate?: (template: MailTemplate) => void
  onDeleteTemplate?: (id: string) => void
  onInsertTemplate: (template: MailTemplate) => void
  currentHtml: string
  companyWords: string[]
  onCompanyWords?: (words: string[]) => void
  isAdmin: boolean
  grammarAvailable: boolean
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>('writing')
  const [templateName, setTemplateName] = useState('')
  const [templateShortcut, setTemplateShortcut] = useState('')
  const [companyDraft, setCompanyDraft] = useState('')
  const set = <K extends keyof WritingSettings>(key: K, value: WritingSettings[K]) => onChange({ ...settings, [key]: value })

  return (
    <div className={styles.wpPanel} role="dialog" aria-label="Writing tools">
      <div className={styles.wpHead}>
        <span className={styles.wpTitle}>Writing tools</span>
        <button type="button" className={styles.wpClose} onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className={styles.wpTabs} role="tablist">
        {(['writing', 'checks', 'templates', 'dictionary', 'shortcuts'] as Tab[]).map(name => (
          <button key={name} type="button" role="tab" aria-selected={tab === name} className={`${styles.wpTab} ${tab === name ? styles.wpTabOn : ''}`} onClick={() => setTab(name)}>
            {name === 'checks' ? 'Before sending' : name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>

      <div className={styles.wpBody}>
        {tab === 'writing' && (
          <>
            <Toggle label="Capitalise new sentences" hint="After . ? ! and at the start of a paragraph" checked={settings.autoCapitalize} onChange={value => set('autoCapitalize', value)} />
            {settings.autoCapitalize && (
              <div className={styles.wpIndent}>
                <Toggle label="Add a missed space" hint="end.Next → end. Next, as you type" checked={settings.spaceAfterStop} onChange={value => set('spaceAfterStop', value)} />
              </div>
            )}
            <Toggle label='Capital "I"' checked={settings.capitalizeI} onChange={value => set('capitalizeI', value)} />
            <Toggle label="Fix common typos" hint="teh → the, dont → don't" checked={settings.autocorrect} onChange={value => set('autocorrect', value)} />
            <Toggle label="Check spelling" hint="On for new messages; the ✓Aa button turns it off for one" checked={settings.spellcheck} onChange={value => set('spellcheck', value)} />
            {settings.spellcheck && (
              <div className={styles.wpIndent}>
                <label className={styles.wpRow}>
                  <span className={styles.wpLabel}>Dictionary</span>
                  <MailSelect
                    ariaLabel="Dictionary"
                    buttonClassName={styles.wpSelect}
                    value={settings.spellLanguage}
                    options={[
                      { value: 'en-GB', label: 'British English' },
                      { value: 'en-US', label: 'American English' },
                    ]}
                    onChange={value => set('spellLanguage', value === 'en-US' ? 'en-US' : 'en-GB')}
                  />
                </label>
                <Toggle label="Skip words in CAPITALS" hint="Acronyms and company names" checked={settings.ignoreCapitals} onChange={value => set('ignoreCapitals', value)} />
                <Toggle label="Skip words with numbers" hint="Policy and vehicle numbers" checked={settings.ignoreWithNumbers} onChange={value => set('ignoreWithNumbers', value)} />
                <Toggle label="Flag repeated words" hint='"the the"' checked={settings.repeatedWords} onChange={value => set('repeatedWords', value)} />
              </div>
            )}
            <Toggle
              label="Check grammar"
              hint={grammarAvailable ? 'Checked on this company’s own server' : 'Not set up on this mailbox yet'}
              checked={settings.grammar && grammarAvailable}
              onChange={value => set('grammar', value)}
            />
            <Toggle label="Tab indents" hint="A quick second Tab leaves the message" checked={settings.tabIndent} onChange={value => set('tabIndent', value)} />
            {settings.tabIndent && (
              <label className={`${styles.wpRow} ${styles.wpIndent}`}>
                <span className={styles.wpText}>
                  <span className={styles.wpLabel}>Double-Tab speed</span>
                  <span className={styles.wpHint}>{settings.doubleTabMs} ms between presses</span>
                </span>
                <input type="range" min={200} max={1000} step={50} value={settings.doubleTabMs} onChange={event => set('doubleTabMs', Number(event.target.value))} />
              </label>
            )}
            <Toggle label="Template shortcuts" hint="Type ;name then Space" checked={settings.templateShortcuts} onChange={value => set('templateShortcuts', value)} />
            <Toggle label="Clean pasted formatting" hint="Strips Word and Excel styling, keeps tables" checked={settings.cleanPaste} onChange={value => set('cleanPaste', value)} />
            <Toggle label="Format amounts" hint="$2500 → $2,500 · USD 1500000 → USD 1,500,000 · ₦, £, €, GHS, KES…" checked={settings.amountFormat} onChange={value => set('amountFormat', value)} />
            {settings.amountFormat && (
              <div className={styles.wpIndent}>
                <Toggle label="N means naira" hint="N1500000 → ₦1,500,000" checked={settings.nairaLetter} onChange={value => set('nairaLetter', value)} />
                <Toggle label="Plain numbers too" hint="1500000 → 1,500,000 · years, phone and account numbers are left alone" checked={settings.numberFormat} onChange={value => set('numberFormat', value)} />
              </div>
            )}
            <Toggle label="Word count" checked={settings.wordCount} onChange={value => set('wordCount', value)} />
          </>
        )}

        {tab === 'checks' && (
          <>
            <p className={styles.wpNote}>Asked when you press Send. You can always send anyway.</p>
            <Toggle label="Missing attachment" hint='"attached" or "enclosed" with nothing attached' checked={settings.checkAttachment} onChange={value => set('checkAttachment', value)} />
            <Toggle label="Nothing written" hint="Only the signature or the quoted message" checked={settings.checkEmptyBody} onChange={value => set('checkEmptyBody', value)} />
            <Toggle label="Unfilled placeholders" hint="[Name], {policy_no}, XXX" checked={settings.checkPlaceholders} onChange={value => set('checkPlaceholders', value)} />
            <Toggle label="Greeting names someone else" hint='"Dear Mr Okafor" to a different person' checked={settings.checkGreeting} onChange={value => set('checkGreeting', value)} />
            <Toggle label="Many outside recipients" checked={settings.checkExternal} onChange={value => set('checkExternal', value)} />
            {settings.checkExternal && (
              <label className={`${styles.wpRow} ${styles.wpIndent}`}>
                <span className={styles.wpLabel}>Warn from</span>
                <span>
                  <input type="number" min={1} max={100} className={styles.wpNumber} value={settings.externalThreshold} onChange={event => set('externalThreshold', Math.max(1, Math.min(100, Number(event.target.value) || 1)))} /> people
                </span>
              </label>
            )}
          </>
        )}

        {tab === 'templates' && (
          <>
            {templates.length === 0 && <p className={styles.wpNote}>No templates yet. Write one below, then save it.</p>}
            {templates.map(template => (
              <div key={template.id} className={styles.wpTemplate}>
                <button type="button" className={styles.wpTemplateName} onClick={() => onInsertTemplate(template)} title="Insert into this message">
                  {template.name}
                  {template.shortcut && <span className={styles.wpShortcut}>;{normaliseShortcut(template.shortcut)}</span>}
                </button>
                {onDeleteTemplate && (
                  <button type="button" className={styles.wpRemove} onClick={() => onDeleteTemplate(template.id)} aria-label={`Delete ${template.name}`}>×</button>
                )}
              </div>
            ))}
            {onSaveTemplate && (
              <div className={styles.wpSave}>
                <span className={styles.wpLabel}>Save this message as a template</span>
                <span className={styles.wpHint}>Write {'{first_name}'}, {'{date}'} or any {'{field}'}: known ones fill in, Tab jumps to the rest</span>
                <input className={styles.wpInput} placeholder="Name, e.g. Renewal notice" value={templateName} onChange={event => setTemplateName(event.target.value)} />
                <input className={styles.wpInput} placeholder="Shortcut, e.g. renewal" value={templateShortcut} onChange={event => setTemplateShortcut(event.target.value)} />
                <button
                  type="button"
                  className={styles.wpButton}
                  disabled={!templateName.trim() || !currentHtml.replace(/<[^>]+>/g, '').trim()}
                  onClick={() => {
                    onSaveTemplate({ id: `t${Date.now().toString(36)}`, name: templateName.trim(), shortcut: normaliseShortcut(templateShortcut), html: currentHtml })
                    setTemplateName('')
                    setTemplateShortcut('')
                  }}
                >
                  Save template
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'dictionary' && (
          <>
            <span className={styles.wpLabel}>Your words</span>
            <span className={styles.wpHint}>Added from a red underline with “Add to dictionary”</span>
            <div className={styles.wpChips}>
              {settings.personalWords.length === 0 && <span className={styles.wpHint}>None yet</span>}
              {settings.personalWords.map(word => (
                <span key={word} className={styles.wpChip}>
                  {word}
                  <button type="button" onClick={() => set('personalWords', settings.personalWords.filter(entry => entry !== word))} aria-label={`Remove ${word}`}>×</button>
                </span>
              ))}
            </div>
            <span className={styles.wpLabel}>Company words</span>
            <span className={styles.wpHint}>{isAdmin ? 'Everyone in the company gets these' : 'Kept by an administrator'}</span>
            <div className={styles.wpChips}>
              {companyWords.length === 0 && <span className={styles.wpHint}>None yet</span>}
              {companyWords.map(word => (
                <span key={word} className={styles.wpChip}>
                  {word}
                  {isAdmin && onCompanyWords && (
                    <button type="button" onClick={() => onCompanyWords(companyWords.filter(entry => entry !== word))} aria-label={`Remove ${word}`}>×</button>
                  )}
                </span>
              ))}
            </div>
            {isAdmin && onCompanyWords && (
              <form
                className={styles.wpSave}
                onSubmit={event => {
                  event.preventDefault()
                  const words = companyDraft.split(/[,\s]+/).map(word => word.trim()).filter(Boolean)
                  if (words.length) onCompanyWords([...new Set([...companyWords, ...words])])
                  setCompanyDraft('')
                }}
              >
                <input className={styles.wpInput} placeholder="Add words, separated by commas" value={companyDraft} onChange={event => setCompanyDraft(event.target.value)} />
                <button type="submit" className={styles.wpButton}>Add</button>
              </form>
            )}
          </>
        )}

        {tab === 'shortcuts' && (
          <dl className={styles.wpKeys}>
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys} className={styles.wpKeyRow}>
                <dt><kbd>{keys}</kbd></dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}
