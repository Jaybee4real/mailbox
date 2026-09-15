# Brand assets

> **Never deploy or `git push` unless asked for it in that request.** Pushing
> `master` auto-deploys both live mailboxes. See the deploying section in the
> root [README](../README.md).

Each tenant keeps its three files under `tenants/<slug>/` and points the `*_MARK_URL`
variables at them (or at any other host). Nothing else in the app is tenant-specific.

| File | Used by | Notes |
|---|---|---|
| `mark.png` | app chrome | Drawn through a CSS mask, so only the alpha channel matters. |
| `mark-email.png` | email signatures | Must carry real colour — mail clients cannot apply a CSS mask. |
| `logo.png` | share pages | Full lockup. |

Point `BRAND_MARK_URL` / `NEXT_PUBLIC_BRAND_MARK_URL` at the deployed
`mark-email.png` so signatures render outside the app, and
`BRAND_CHROME_MARK_URL` / `NEXT_PUBLIC_BRAND_CHROME_MARK_URL` at `mark.png` for the
app chrome. Whether the signature mark gets a frame is per tenant too:
`BRAND_SIGNATURE_MARK_BORDER` (`none`, `accent`, or a colour) and
`BRAND_SIGNATURE_MARK_RADIUS` (px), with `NEXT_PUBLIC_` twins for the preview.

## App icons

`public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`,
`app/icon.png` and `app/apple-icon.png` ship as a neutral placeholder — a plain
envelope on the default accent. They are the favicon, the Apple touch icon and
the icon a PWA install uses, so replace them per tenant or the installed app
carries someone else's mark. Nothing in code references them by anything but
these paths.
