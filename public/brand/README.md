# Brand assets

> **Never deploy or `git push` unless asked for it in that request.** Pushing
> `master` auto-deploys the Novacraft mailbox. See the deploying section in the
> root [README](../README.md).

**No tenant's artwork belongs in this repository.** Each mailbox keeps its own
images on its mounted volume, in the directory named by `BRAND_ASSET_DIR`
(default `/data/brand`), and the app serves them from `/brand/<file>`.

| File | Used by | Notes |
|---|---|---|
| `mark.png` | app chrome | Drawn through a CSS mask, so only the alpha channel matters. |
| `mark-email.png` | email signatures | Must carry real colour — mail clients cannot apply a CSS mask. |
| `logo.png` | share pages | Full lockup. |

Point the configuration at them:

```
BRAND_MARK_URL=https://mail.example.com/brand/mark-email.png
NEXT_PUBLIC_BRAND_MARK_URL=https://mail.example.com/brand/mark-email.png
BRAND_CHROME_MARK_URL=/brand/mark.png
NEXT_PUBLIC_BRAND_CHROME_MARK_URL=/brand/mark.png
```

Any of these may instead be a URL on a host the tenant already owns; nothing in
the app requires the files to be served from here.

Until a tenant supplies them, `/brand/mark.png`, `/brand/mark-email.png` and
`/brand/logo.png` answer with the same neutral envelope as the app icons, so a
fresh install carries no other tenant's mark.

## App icons

`public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`,
`app/icon.png` and `app/apple-icon.png` ship as a neutral placeholder — a plain
envelope on the default accent. They are the favicon, the Apple touch icon and
the icon a PWA install uses. `BRAND_ICON_URL` and `BRAND_APPLE_ICON_URL`
override them per tenant without touching the repository.
