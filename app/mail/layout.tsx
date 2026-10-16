import { BRAND } from '@/lib/brand'
import { accentRampCss } from '@/lib/accent-ramp'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ConfirmProvider } from './ConfirmDialog'
import StatusBar from './StatusBar'

export const metadata: Metadata = {
  title: `${BRAND.name} Mail`,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
}

export default function MailLayout({ children }: { children: ReactNode }) {
  const ramp = accentRampCss(BRAND.accentHex)
  return (
    <>
      {ramp ? <style>{`:root{${ramp}}`}</style> : null}
      <ConfirmProvider>
        <StatusBar />
        {children}
      </ConfirmProvider>
    </>
  )
}
