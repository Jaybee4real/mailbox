<img src=".github/banner.png" alt="mailbox by Novacraft" width="100%">

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

Here, pushing *is* deploying — for one tenant. A GitHub webhook on this repository
points at the Coolify that serves production, so a push to `master` auto-deploys the
**Novacraft** mailbox. Metroperil is deliberately not wired: it shares this repository
and branch, but Coolify checks the webhook signature against each application's own
secret, so metroperil is skipped and still needs a manual deploy from Coolify.
Finish the work, commit locally, leave it unpushed, and say plainly that it is
waiting.

## Standing up a new mailbox

1. Copy `.env.example` and fill it in. Nothing is hardcoded to a tenant.
2. Put three images on the volume at `BRAND_ASSET_DIR` — see `public/brand/README.md`.
3. Point `TURSO_DATABASE_URL` at a SQLite file on a mounted volume.
4. Deploy. The schema is created on first boot and migrates itself forward.

## Trying it locally

Outside production the app seeds one account for you — `test@<MAIL_ADDRESS_DOMAIN>`,
an admin whose password is the address itself — so a fresh checkout can be signed
into without configuring seats. It is never seeded when `NODE_ENV=production`.

`node --experimental-strip-types scripts/seed-dev.mjs` then fills that mailbox with
enough traffic to exercise the list, search, paging and attachments. Create the schema
first by starting the app once, or by calling `ensureMailSchema()`.

The attachments are real files, not records: a PDF, a photo, a short video, a
spreadsheet and a Word document, generated on the spot and uploaded once. Pictures and
video need `ffmpeg` and the document needs `zip`; whatever is missing is skipped. With
no bucket configured the seed still runs and writes the records alone, as it always
did.

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
