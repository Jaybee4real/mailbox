import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Metro Peril Mail',
  description: 'Metro Peril team mailbox',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  manifest: '/manifest.webmanifest',
  applicationName: 'Metro Peril Mail',
  appleWebApp: { capable: true, title: 'MP Mail', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
}

export const viewport: Viewport = {
  themeColor: '#a90317',
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
