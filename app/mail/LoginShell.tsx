'use client'

import type { ReactNode } from 'react'
import { CLIENT_BRAND } from '@/lib/brand.client'
import styles from './page.module.css'

type Props = {
  domains: string[]
  children: ReactNode
}

export default function LoginShell({ domains, children }: Props) {
  return (
    <div className={styles.loginShell}>
      <aside className={styles.loginPanel}>
        <div className={styles.loginPanelBrand}>
          <span className={styles.loginPanelTile}>
            <span className={styles.brandMark} role="img" aria-label={CLIENT_BRAND.name} />
          </span>
          <span className={styles.loginPanelName}>{CLIENT_BRAND.name} Mail</span>
        </div>
        <div className={styles.loginPanelBody}>
          <p className={styles.loginPanelEyebrow}>Team mailbox</p>
          <h2 className={styles.loginPanelTitle}>{CLIENT_BRAND.name} Mail</h2>
          <p className={styles.loginPanelLead}>One inbox for everyone at</p>
          <ul className={styles.loginPanelDomains}>
            {domains.map(domain => <li key={domain}>@{domain}</li>)}
          </ul>
        </div>
        <footer className={styles.loginPanelFoot}>
          <span>© {new Date().getFullYear()} {CLIENT_BRAND.legalName}</span>
          <a href={CLIENT_BRAND.websiteUrl} target="_blank" rel="noreferrer">{CLIENT_BRAND.website}</a>
        </footer>
      </aside>
      <main className={styles.loginMain}>{children}</main>
    </div>
  )
}
