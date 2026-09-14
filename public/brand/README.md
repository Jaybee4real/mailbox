# Brand assets

Drop three files here per mailbox. Nothing else in the app is tenant-specific.

| File | Used by | Notes |
|---|---|---|
| `mark.png` | app chrome | Drawn through a CSS mask, so only the alpha channel matters. |
| `mark-email.png` | email signatures | Must carry real colour — mail clients cannot apply a CSS mask. |
| `logo.png` | share pages | Full lockup. |

Point `BRAND_MARK_URL` / `NEXT_PUBLIC_BRAND_MARK_URL` at the deployed
`mark-email.png` so signatures render outside the app.

## App icons

`public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`,
`app/icon.png` and `app/apple-icon.png` ship as a neutral placeholder — a plain
envelope on the default accent. They are the favicon, the Apple touch icon and
the icon a PWA install uses, so replace them per tenant or the installed app
carries someone else's mark. Nothing in code references them by anything but
these paths.
