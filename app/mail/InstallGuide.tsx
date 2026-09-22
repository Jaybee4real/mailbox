'use client'

import styles from './page.module.css'
import type { IosBrowser } from './pwa'

const ShareArt = () => (
  <svg className={styles.installArt} viewBox="0 0 160 104" aria-hidden="true">
    <rect x="38" y="4" width="84" height="96" rx="13" fill="var(--nc-ink-2)" stroke="var(--nc-line-2)" />
    <rect x="48" y="16" width="46" height="5" rx="2.5" fill="var(--nc-line-2)" />
    <rect x="48" y="28" width="64" height="4" rx="2" fill="var(--nc-line-1)" />
    <rect x="48" y="37" width="54" height="4" rx="2" fill="var(--nc-line-1)" />
    <rect x="48" y="46" width="60" height="4" rx="2" fill="var(--nc-line-1)" />
    <rect x="39" y="73" width="82" height="26" rx="11" fill="var(--nc-ink-3)" />
    <g stroke="var(--nc-fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".55">
      <path d="M55 82l-4 4 4 4" />
      <path d="M65 82l4 4-4 4" />
      <path d="M99 80h8v12h-8z" />
      <path d="M111 81h6v10h-6z" />
    </g>
    <g stroke="var(--nc-violet-400)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M74 85v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" />
      <path d="M80 79v10" />
      <path d="M77 82l3-3 3 3" />
    </g>
    <circle cx="80" cy="86" r="12" fill="none" stroke="var(--nc-violet-400)" strokeWidth="1.4" opacity=".55" />
  </svg>
)

const SheetArt = () => (
  <svg className={styles.installArt} viewBox="0 0 160 104" aria-hidden="true">
    <rect x="10" y="10" width="140" height="84" rx="13" fill="var(--nc-ink-2)" stroke="var(--nc-line-2)" />
    <rect x="68" y="17" width="24" height="4" rx="2" fill="var(--nc-line-2)" />
    <g>
      <rect x="18" y="28" width="124" height="18" rx="8" fill="var(--nc-ink-3)" />
      <rect x="26" y="33" width="9" height="9" rx="2.5" fill="var(--nc-line-2)" />
      <rect x="42" y="35" width="44" height="4" rx="2" fill="var(--nc-line-2)" />
    </g>
    <g>
      <rect x="18" y="50" width="124" height="22" rx="8" fill="none" stroke="var(--nc-violet-400)" strokeWidth="1.6" />
      <g stroke="var(--nc-violet-400)" strokeWidth="1.7" strokeLinecap="round" fill="none">
        <rect x="26" y="56" width="10" height="10" rx="2.5" />
        <path d="M31 58.5v5" />
        <path d="M28.5 61h5" />
      </g>
      <rect x="44" y="59" width="66" height="4" rx="2" fill="var(--nc-violet-400)" />
    </g>
    <g opacity=".5">
      <rect x="26" y="79" width="9" height="9" rx="2.5" fill="var(--nc-line-2)" />
      <rect x="42" y="81" width="38" height="4" rx="2" fill="var(--nc-line-2)" />
    </g>
  </svg>
)

const HomeArt = () => (
  <svg className={styles.installArt} viewBox="0 0 160 104" aria-hidden="true">
    <rect x="38" y="4" width="84" height="96" rx="13" fill="var(--nc-ink-2)" stroke="var(--nc-line-2)" />
    <g fill="var(--nc-line-1)">
      <rect x="50" y="20" width="18" height="18" rx="5" />
      <rect x="72" y="20" width="18" height="18" rx="5" />
      <rect x="94" y="20" width="18" height="18" rx="5" />
      <rect x="72" y="50" width="18" height="18" rx="5" />
      <rect x="94" y="50" width="18" height="18" rx="5" />
    </g>
    <rect x="50" y="50" width="18" height="18" rx="5" fill="var(--nc-violet-400)" />
    <g stroke="var(--nc-ink-1)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <rect x="54" y="56" width="10" height="7" rx="1.5" />
      <path d="M54 57.5l5 3.5 5-3.5" />
    </g>
    <rect x="52" y="71" width="14" height="3" rx="1.5" fill="var(--nc-violet-400)" opacity=".6" />
    <g fill="var(--nc-line-1)" opacity=".7">
      <rect x="74" y="71" width="14" height="3" rx="1.5" />
      <rect x="96" y="71" width="14" height="3" rx="1.5" />
      <rect x="52" y="41" width="14" height="3" rx="1.5" />
      <rect x="74" y="41" width="14" height="3" rx="1.5" />
      <rect x="96" y="41" width="14" height="3" rx="1.5" />
    </g>
  </svg>
)

export function InstallGuide({ browser, appName }: { browser: IosBrowser; appName: string }) {
  return (
    <div className={styles.installGuide}>
      {browser === 'other' && (
        <p className={styles.installWarn}>
          You are not in Safari. On iPhone and iPad only Safari can add a real app to the Home Screen — Chrome,
          Firefox and Edge save a bookmark that reopens inside the browser and cannot receive notifications. Open
          this page in Safari, then follow the steps below.
        </p>
      )}

      <ol className={styles.installSteps}>
        <li className={styles.installStep}>
          <ShareArt />
          <div>
            <strong>Tap Share.</strong>
            <p className={styles.settingsNote}>
              It is the square with an arrow coming out of the top, in the bar at the bottom of Safari. On an iPad
              it sits in the top bar instead.
            </p>
          </div>
        </li>
        <li className={styles.installStep}>
          <SheetArt />
          <div>
            <strong>Choose Add to Home Screen.</strong>
            <p className={styles.settingsNote}>
              Scroll the share sheet down past the row of apps. The entry has a plus inside a square next to it.
            </p>
          </div>
        </li>
        <li className={styles.installStep}>
          <HomeArt />
          <div>
            <strong>Tap Add.</strong>
            <p className={styles.settingsNote}>
              {appName} Mail lands on your Home Screen and opens in its own window, with no address bar. You can
              rename it on this screen before you confirm.
            </p>
          </div>
        </li>
      </ol>

      <p className={styles.settingsNote}>
        Notifications only reach the Home Screen copy. iOS will not deliver them to a page open in a browser tab,
        so add it here first and then turn notifications on inside the app.
      </p>
      <p className={styles.settingsNote}>
        There is no one-tap install button on iPhone because Apple gives websites no way to ask — the share sheet
        is the only route, on every browser.
      </p>
    </div>
  )
}
