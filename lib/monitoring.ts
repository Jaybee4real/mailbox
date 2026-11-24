import type { Breadcrumb, ErrorEvent, NodeOptions } from '@sentry/nextjs'

export const TRACES_SAMPLE_RATE = 0.05

export const DATA_COLLECTION: NodeOptions['dataCollection'] = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
}

export const MONITORING_ENV_KEYS = ['SENTRY_DSN', 'POSTHOG_KEY'] as const
export type MonitoringKey = (typeof MONITORING_ENV_KEYS)[number]

const SECRET_NAME = /authorization|cookie|token|password|passcode|secret|otp|code|pin|session|signature|key/i

export const withoutQuery = (url: string) => url.split(/[?#]/)[0]

function scrubRecord(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return record
  return Object.fromEntries(Object.entries(record).map(([name, value]) => [name, SECRET_NAME.test(name) ? '[scrubbed]' : value]))
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user
  if (event.request) {
    delete event.request.cookies
    delete event.request.data
    delete event.request.query_string
    if (event.request.url) event.request.url = withoutQuery(event.request.url)
    event.request.headers = scrubRecord(event.request.headers) as Record<string, string> | undefined
  }
  event.extra = scrubRecord(event.extra)
  event.breadcrumbs = event.breadcrumbs?.map(scrubBreadcrumb).filter((crumb): crumb is Breadcrumb => crumb !== null)
  return event
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console') return null
  if (!breadcrumb.data) return breadcrumb
  const data = scrubRecord({ ...breadcrumb.data }) ?? {}
  for (const field of ['url', 'from', 'to']) {
    if (typeof data[field] === 'string') data[field] = withoutQuery(data[field] as string)
  }
  return { ...breadcrumb, data }
}
