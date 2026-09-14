# Mailbox

A shared webmail app: one codebase, one deployment per mailbox. Inbox and
threads, a rich composer with signatures and templates, attachments on
S3-compatible storage, sharing links, full-text search, web push, PWA install,
multi-accessor accounts with roles, and password reset.

Extracted verbatim from the Metroperil mailbox, with every tenant-specific
value moved behind configuration.

## Standing up a new mailbox

1. Copy `.env.example` and fill it in. Nothing is hardcoded to a tenant.
2. Drop three images into `public/brand/` — see the README there.
3. Point `TURSO_DATABASE_URL` at a SQLite file on a mounted volume.
4. Deploy. The schema is created on first boot and migrates itself forward.

## Configuration

`lib/brand.ts` is the single server-side source of tenant identity — name,
domain, signature copy, colours, seats, aliases. `lib/brand.client.ts` is the
browser half, read from `NEXT_PUBLIC_*` and inlined at build time, so a rebuild
is required to change client-visible branding.

Seats are JSON in `MAIL_SEATS` and seed on first boot only; afterwards accounts
are managed in the app. `MAIL_ADDRESS_ALIASES` redirects delivery for a seat
whose mail someone else now reads.

## Storage

`TURSO_DATABASE_URL` takes precedence; without it the app falls back to
Cloudflare D1, so moving between the two needs no coordinated redeploy. A
`file:` URL uses local SQLite, which is what a single box wants.

Attachments go to any S3-compatible bucket via the `R2_*` variables.

## Sending

`MAIL_PROVIDER` selects `ses`, `resend` or `brevo` behind one seam. SES is
signed in-process; no SDK.

## Tests

```
npx tsx --test lib/*.test.ts
```
