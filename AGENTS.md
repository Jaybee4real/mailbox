<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Gmail and Outlook conventions

For every feature Vela shares with Gmail and Outlook (reply, reply all, forward, conversations, recipients, drafts, undo send, labels, search), Vela behaves the way Gmail and Outlook do today. Before building or changing anything that would work differently, ask the owner first in a dialog box: name the convention, say what Vela would do instead and why, and offer the conventional behaviour as one of the choices. Do not ship a difference the owner has not chosen.

Decisions the owner has made (2026-11-05):
- **Reply** goes to the sender of the message being answered (its Reply-To if set). Replying to a message we sent ourselves goes to the people it was sent to.
- **Reply all** goes to that one message's sender, To and Cc, minus only the mailbox replying and the address you send as. Colleagues on the message stay on the reply. It never adds people from other messages in the conversation, and never anyone from Bcc.
- **Forward** starts with no recipients and carries the original's attachments.
- **Conversations**: a message joins the conversation it replies to (In-Reply-To and References, including replies to our own sent mail) and only while the subject stays the same. The same subject alone never joins messages. This is stricter than Gmail, which also joins a message with no reply headers when the subject and sender or recipients match within a week; the owner chose the stricter rule. Mail received before 5 November 2026, including the imported Google Workspace history (which kept no reply headers), keeps its earlier grouping: same subject and a shared company or person.
- **Send delay** stays at 20 seconds by default (longer than Gmail's 5, within its 5 to 30 range), so Undo works.
- **No recipient warnings**: whoever is typed into To, Cc or Bcc gets the mail, as in Gmail and Outlook.

Decisions the owner has made (2026-11-09):
- **Large attachments**: a file over 20MB goes out as a download link, as before. Once the files riding along on a message come to more than 25MB together, every one of them goes out as a download link, not only the files past the limit as Gmail does. Vela refuses more than 28MB of attachments, so this keeps a send from failing after the files have uploaded.
- **Filter rules**: the filter menu has a Show choice (All, Unread, Has attachments) that narrows the Inbox on the server, as Gmail's `is:unread` and `has:attachment` do. Rules can be Advanced; the DMARC report rule is one. Mail an advanced rule holds out never counts as unread in the Inbox (neither the badge nor the Filtered chip), but stays unread inside Filtered and is never marked read.
