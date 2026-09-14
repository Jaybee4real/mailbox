# Brand assets

Drop three files here per mailbox. Nothing else in the app is tenant-specific.

| File | Used by | Notes |
|---|---|---|
| `mark.png` | app chrome | Drawn through a CSS mask, so only the alpha channel matters. |
| `mark-email.png` | email signatures | Must carry real colour — mail clients cannot apply a CSS mask. |
| `logo.png` | share pages | Full lockup. |

Point `BRAND_MARK_URL` / `NEXT_PUBLIC_BRAND_MARK_URL` at the deployed
`mark-email.png` so signatures render outside the app.
