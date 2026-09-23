import assert from 'node:assert/strict'
import test from 'node:test'

test('aggregate reports are recognised by their subject, and nothing else is', async () => {
  const { isDmarcAggregateReport } = await import('./mailbox.ts')

  assert.equal(isDmarcAggregateReport('Report domain: contact.novacraft.africa Submitter: google.com Report-ID: 2705410220068441608'), true)
  assert.equal(isDmarcAggregateReport('Report domain: contact.novacraft.africa Submitter: google.com\n Report-ID: 12382647491638298144'), true, 'Google folds the header')
  assert.equal(isDmarcAggregateReport('Report Domain: metroperilinsbrokers.com Submitter: yahoo.com Report-ID: <1790142578.13334>'), true)
  assert.equal(isDmarcAggregateReport('Report Domain: contact.novacraft.africa Submitter: protection.outlook.com Report-ID: 9115e5ed'), true)
  assert.equal(isDmarcAggregateReport('Dmarc Aggregate Report Domain: {metroperilinsbrokers.com} Submitter: {Amazon SES} Date: {2026-09-22}'), true)

  assert.equal(isDmarcAggregateReport('Re: Report domain: contact.novacraft.africa Submitter: google.com'), false, 'a reply is a person talking')
  assert.equal(isDmarcAggregateReport('Report domain migration plan'), false, 'no Submitter, no report')
  assert.equal(isDmarcAggregateReport('Quarterly report: domain renewals and the submitter list'), false)
  assert.equal(isDmarcAggregateReport(''), false)
  assert.equal(isDmarcAggregateReport(null), false)
})
