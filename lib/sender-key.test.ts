import assert from 'node:assert/strict'
import { senderDomainOf } from './risk.ts'

assert.equal(senderDomainOf('Claims <claims@insurer.example>'), 'insurer.example', 'a business is judged as one sender')
assert.equal(senderDomainOf('ops@mail.linkageassurance.com'), 'linkageassurance.com', 'its subdomains with it')
assert.equal(senderDomainOf('E. Okpata <Eokpata.Metroperil@gmail.com>'), 'eokpata.metroperil@gmail.com', 'a Gmail sender is judged alone')
assert.notEqual(senderDomainOf('a@yahoo.com'), senderDomainOf('b@yahoo.com'), 'two people at a free provider never share a standing')
console.log('sender-key: ok')
