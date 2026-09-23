import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanPastedHtml } from './paste.ts'

test('Word styling is stripped and meaning is kept', () => {
  const word = '<!--[if gte mso 9]><xml><o:x/></xml><![endif]--><p class="MsoNormal" style="margin:0;font-family:Calibri;mso-bidi-font-weight:bold"><b>Premium</b> due<o:p></o:p></p>'
  assert.equal(cleanPastedHtml(word), '<p><b>Premium</b> due</p>')
})

test('Excel tables survive with their structure', () => {
  const excel = '<style>td{mso-number-format:General}</style><table class="x"><tr><td class="xl65" style="font-family:Calibri">Vehicle</td><td style="text-align:right;font-size:11pt">N150,000</td></tr></table>'
  assert.equal(cleanPastedHtml(excel), '<table><tr><td>Vehicle</td><td style="text-align:right">N150,000</td></tr></table>')
})

test('meaningful inline colour survives, bare font wrappers do not', () => {
  assert.equal(cleanPastedHtml('<font face="Arial">plain</font> <span style="color:red;font-family:Arial">red</span>'), 'plain <span style="color:red">red</span>')
})
