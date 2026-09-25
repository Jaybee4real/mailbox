import { BRAND } from '@/lib/brand'
import { BRAND_ENV_KEYS } from '@/lib/brand.client'
import type { Metadata, Viewport } from 'next'
import type { CSSProperties, ReactNode } from 'react'
import './globals.css'

// One image serves every deployment, so nothing that names the brand may be settled at
// build time: every page is rendered per request, from the environment it runs in.
export const dynamic = 'force-dynamic'

export const generateMetadata = (): Metadata => ({
  title: `${BRAND.name} Mail`,
  description: `${BRAND.name} team mailbox`,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  manifest: '/manifest.webmanifest',
  ...(BRAND.iconUrl
    ? { icons: { icon: BRAND.iconUrl, shortcut: BRAND.iconUrl, apple: BRAND.appleIconUrl || BRAND.iconUrl } }
    : {}),
  applicationName: `${BRAND.name} Mail`,
  appleWebApp: { capable: true, title: `${BRAND.name} Mail`, statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
})

export const generateViewport = (): Viewport => ({
  themeColor: BRAND.colors.accent,
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
})

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          // Only the public brand settings, and escaped so a value can never close the tag.
          dangerouslySetInnerHTML={{
            __html: `window.__MAILBOX_BRAND_ENV__=${JSON.stringify(
              Object.fromEntries(BRAND_ENV_KEYS.flatMap(key => (process.env[key] ? [[key, process.env[key]]] : []))),
            ).replace(/</g, '\\u003c')}`,
          }}
        />
      </head>
      <body
        style={{ ['--brand-mark' as string]: `url('${BRAND.chromeMarkUrl}')` } as CSSProperties}
      >
        {children}
      </body>
    </html>
  )
}
