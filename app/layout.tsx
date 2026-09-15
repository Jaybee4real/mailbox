import { BRAND } from '@/lib/brand'
import type { Metadata, Viewport } from 'next'
import type { CSSProperties, ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
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
}

export const viewport: Viewport = {
  themeColor: BRAND.colors.accent,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{ ['--brand-mark' as string]: `url('${BRAND.chromeMarkUrl}')` } as CSSProperties}
      >
        {children}
      </body>
    </html>
  )
}
