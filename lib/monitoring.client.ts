'use client'

import { CLIENT_BRAND } from './brand.client'
import { DATA_COLLECTION, scrubBreadcrumb, scrubEvent, TRACES_SAMPLE_RATE, withoutQuery, type MonitoringKey } from './monitoring'

const POSTHOG_HOST = 'https://us.i.posthog.com'
const URL_PROPERTIES = ['$current_url', '$referrer', '$initial_referrer', '$pathname', '$initial_current_url']

const setting = (key: MonitoringKey) =>
  typeof window === 'undefined' ? '' : (window.__MAILBOX_BRAND_ENV__?.[key]?.trim() ?? '')

const live = () => process.env.NODE_ENV === 'production'

let errorsStarted = false
let analyticsStarted = false

export async function startErrorReporting(): Promise<void> {
  const dsn = setting('SENTRY_DSN')
  if (errorsStarted || !dsn || !live()) return
  errorsStarted = true
  const Sentry = await import('@sentry/nextjs')
  Sentry.init({
    dsn,
    environment: 'production',
    release: process.env.NEXT_PUBLIC_BUILD_SHA || undefined,
    dataCollection: DATA_COLLECTION,
    tracesSampleRate: TRACES_SAMPLE_RATE,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: { tags: { tenant: CLIENT_BRAND.slug } },
  })
}

export async function startProductAnalytics(): Promise<void> {
  const key = setting('POSTHOG_KEY')
  if (analyticsStarted || !key || !live()) return
  analyticsStarted = true
  const { default: posthog } = await import('posthog-js')
  posthog.init(key, {
    api_host: POSTHOG_HOST,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    autocapture: false,
    capture_pageview: true,
    disable_surveys: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '*',
      blockSelector: 'img, iframe, video, canvas, svg image',
    },
    before_send: event => {
      if (!event) return event
      for (const property of URL_PROPERTIES) {
        const value = event.properties?.[property]
        if (typeof value === 'string') event.properties[property] = withoutQuery(value)
      }
      return event
    },
  })
  posthog.register({ product: 'vela-mail', surface: 'web', tenant: CLIENT_BRAND.slug })
}
