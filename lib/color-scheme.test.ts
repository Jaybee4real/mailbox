import assert from 'node:assert/strict'
import { adaptiveEmail, designsForDark, pinColorScheme } from './color-scheme.ts'

const ruleFor = (html: string, element: RegExp) => {
  const name = html.match(element)?.[1]
  assert.ok(name, `no class on ${element}`)
  return html.match(new RegExp(`\\.${name}\\{([^}]*)\\}`))?.[1] ?? ''
}

const composed = adaptiveEmail('<div style="color:#030712;"><p style="color:#030712">Hi</p><a href="https://example.com" style="color:rgb(109, 40, 217)">link</a></div>')
assert.match(composed, /<meta name="color-scheme" content="light dark">/)
assert.match(composed, /@media \(prefers-color-scheme: dark\)/)
assert.ok(composed.includes('style="color:#030712;"'), 'the light rendering keeps its inline colours')
const bodyRule = ruleFor(composed, /<div class="(nc-d\d+)"/)
assert.match(bodyRule, /color:#[ef][0-9a-f]{5}!important/, 'near-black text turns near-white')
assert.equal(composed.match(/<p class="(nc-d\d+)"/)?.[1], composed.match(/<div class="(nc-d\d+)"/)?.[1], 'identical overrides share one class')
assert.ok(!/<a[^>]*><\/a>|<span class=/.test(adaptiveEmail('<div style="color:#030712"><span>plain</span></div>')), 'an uncoloured child inherits and needs no class')
assert.match(ruleFor(composed, /<a class="(nc-d\d+)"/), /color:#[89ab][0-9a-f]{5}!important/, 'the violet link lightens')

const button = adaptiveEmail('<td style="background:#6d28d9"><a style="color:#FFFFFF">Go</a></td>')
assert.ok(!/<a class=/.test(button), 'white on a mid-tone button already reads and is left alone')
assert.ok(!/background-color/.test(button), 'mid-tone fills keep their colour')

const highlight = adaptiveEmail('<p style="color:#030712"><span style="background-color:#fde68a">marked</span></p>')
const highlightRule = ruleFor(highlight, /<span class="(nc-d\d+)"/)
assert.match(highlightRule, /background-color:#[0-5][0-9a-f]{5}!important/, 'a pale highlight darkens')

const merged = adaptiveEmail('<p class="lead" style="color:#000">x</p>')
assert.match(merged, /<p class="lead nc-d\d+"/, 'an existing class is kept alongside ours')

const untouched = '<style>p{color:#000}</style><script>var a = "<p style=\\"color:#000\\">"</script>'
assert.ok(adaptiveEmail(untouched).includes(untouched), 'stylesheet and script text are never rewritten')

const ownDesign = '<style>@media (prefers-color-scheme: dark){.a{color:#fff}}</style><p style="color:#000">x</p>'
assert.equal(adaptiveEmail(ownDesign), ownDesign, 'mail with its own dark design is left as written')
assert.ok(designsForDark(ownDesign))
assert.ok(!designsForDark('<p>x</p>'))

const template = adaptiveEmail('<!doctype html><html><body style="margin:0;background:#050309"><div style="color:#F5F2FA">Title</div></body></html>', 'dark')
assert.match(template, /<html><head><meta name="color-scheme"/, 'a document without a head gains one')
assert.match(template, /@media \(prefers-color-scheme: light\)/)
assert.match(ruleFor(template, /<body class="(nc-l\d+)"/), /background-color:#f[0-9a-f]{5}!important/, 'the dark page turns light')
assert.match(ruleFor(template, /<div class="(nc-l\d+)"/), /color:#[0-2][0-9a-f]{5}!important/, 'pale text turns dark')

assert.equal(adaptiveEmail('<img src="x.png" />'), '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme: dark){}</style></head><body><img src="x.png" /></body></html>')

const queries = '<style>@media (prefers-color-scheme: dark){a{}} @media screen and (prefers-color-scheme:light){b{}}</style><source media="(prefers-color-scheme: dark)">'
assert.equal(pinColorScheme(queries, true), '<style>@media (min-width:0px){a{}} @media screen and (max-width:0px){b{}}</style><source media="(min-width:0px)">')
assert.equal(pinColorScheme(queries, false), '<style>@media (max-width:0px){a{}} @media screen and (min-width:0px){b{}}</style><source media="(max-width:0px)">')

console.log('color-scheme: ok')
