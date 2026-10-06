'use client'

import { useEffect, useRef } from 'react'

type TurnstileApi = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (widgetId: string) => void
}

let loader: Promise<void> | null = null

function loadTurnstile(): Promise<void> {
  loader ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loader = null
      reject(new Error('Turnstile failed to load'))
    }
    document.head.appendChild(script)
  })
  return loader
}

export default function HumanCheck({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let widgetId: string | undefined
    let cancelled = false
    loadTurnstile()
      .then(() => {
        const turnstile = (window as unknown as { turnstile?: TurnstileApi }).turnstile
        if (cancelled || !holder.current || !turnstile) return
        widgetId = turnstile.render(holder.current, {
          sitekey: siteKey,
          theme: 'dark',
          size: 'flexible',
          callback: (token: string) => onToken(token),
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        })
      })
      .catch(() => onToken(''))
    return () => {
      cancelled = true
      if (widgetId) (window as unknown as { turnstile?: TurnstileApi }).turnstile?.remove(widgetId)
    }
  }, [siteKey, onToken])

  return <div ref={holder} style={{ width: '100%' }} />
}
