import * as Sentry from '@sentry/nextjs'
import { DATA_COLLECTION, scrubBreadcrumb, scrubEvent, TRACES_SAMPLE_RATE } from '@/lib/monitoring'

export function register() {
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn || process.env.NODE_ENV !== 'production') return
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT?.trim() || 'production',
    release: process.env.NEXT_PUBLIC_BUILD_SHA || undefined,
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  })
}

export const onRequestError = Sentry.captureRequestError
