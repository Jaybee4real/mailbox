import { BRAND } from '@/lib/brand'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ConfirmProvider } from './ConfirmDialog'

export const metadata: Metadata = {
  title: `${BRAND.name} Mail`,
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
}

export default function MailLayout({ children }: { children: ReactNode }) {
  return <ConfirmProvider>{children}</ConfirmProvider>
}
