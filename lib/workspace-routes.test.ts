import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const directory = mkdtempSync(join(tmpdir(), 'workspace-routes-test-'))
process.env.DATABASE_URL = `file:${directory}/test.sqlite`
process.env.MAIL_ADDRESS_DOMAIN = 'example.com'
process.env.MAIL_SEATS = '[]'
after(() => rmSync(directory, { recursive: true, force: true }))

test('workspace routes answer with the same handlers as the company routes they mirror', async () => {
  const pairs = [
    ['../app/api/mail/company-dictionary/route.ts', '../app/api/mail/workspace-dictionary/route.ts'],
    ['../app/api/mail/company-signature/route.ts', '../app/api/mail/workspace-signature/route.ts'],
  ] as const
  for (const [companyPath, workspacePath] of pairs) {
    const company = await import(companyPath)
    const workspace = await import(workspacePath)
    assert.equal(workspace.GET, company.GET)
    assert.equal(workspace.PUT, company.PUT)
    assert.equal(workspace.runtime, company.runtime)
  }
})
