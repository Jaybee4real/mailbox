# Mailbox

A shared webmail app: one codebase, one deployment per mailbox. Inbox and
threads, a rich composer with signatures and templates, attachments on
S3-compatible storage, sharing links, full-text search, web push, PWA install,
multi-accessor accounts with roles, and password reset.

Every tenant-specific value — name, domain, colours, signature copy, artwork —
lives in configuration. Nothing in this repository names or pictures any one
business, and nothing added to it should.

## Deploying — read this first

**Never deploy, and never `git push`, unless the person you are working with asks
for it in that same request.** This is a standing rule for every agent and every
session. A granted deploy covers that one deploy only; it is not permission for
the next one.

Here, pushing *is* deploying. Coolify auto-deploys `master` on push, and a single
push updates **every** live mailbox at once, not just the one you are working on.
Finish the work, commit locally, leave it unpushed, and say plainly that it is
waiting.

## Standing up a new mailbox

1. Copy `.env.example` and fill it in. Nothing is hardcoded to a tenant.
2. Put three images on the volume at `BRAND_ASSET_DIR` — see `public/brand/README.md`.
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
