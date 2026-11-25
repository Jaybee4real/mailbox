import assert from 'node:assert/strict'
import test from 'node:test'
import type { ErrorEvent } from '@sentry/nextjs'
import { scrubBreadcrumb, scrubEvent } from './monitoring.ts'

test('error reports carry no cookies, bodies, reset tokens or auth headers', () => {
  const event = scrubEvent({
    type: undefined,
    user: { email: 'ada@example.com' },
    request: {
      url: 'https://mail.example.com/mail/reset?token=secret-reset',
      query_string: 'token=secret-reset',
      cookies: { mp_mail_session: 'abc' },
      data: { password: 'hunter2' },
      headers: { authorization: 'Bearer vm_x', cookie: 'mp_mail_session=abc', 'user-agent': 'probe' },
    },
    extra: { otpCode: '123456', folder: 'inbox' },
    breadcrumbs: [
      { category: 'console', message: 'Subject: payroll' },
      { category: 'fetch', data: { url: '/api/mail/reset?token=secret-reset', method: 'POST' } },
    ],
  } as ErrorEvent)

  const sent = JSON.stringify(event)
  for (const secret of ['secret-reset', 'hunter2', 'abc', 'vm_x', '123456', 'ada@example.com', 'payroll']) {
    assert.ok(!sent.includes(secret), `${secret} is scrubbed`)
  }
  assert.equal(event.request?.url, 'https://mail.example.com/mail/reset')
  assert.equal(event.request?.headers?.['user-agent'], 'probe')
  assert.equal(event.extra?.folder, 'inbox')
  assert.equal(event.breadcrumbs?.length, 1)
})

test('navigation breadcrumbs keep the page but drop its query', () => {
  const crumb = scrubBreadcrumb({ category: 'navigation', data: { from: '/mail?x=1', to: '/mail/reset?token=t' } })
  assert.deepEqual(crumb?.data, { from: '/mail', to: '/mail/reset' })
})
