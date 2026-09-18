# Tools

| File | What it does |
|---|---|
| `import-mbox.py` | Import an mbox into a mailbox. Bodies and metadata first, attachments second. |
| `import-takeout.sh` | Wrapper: import one Google Takeout zip for one seat, streaming the mbox out of the zip. Set `IMPORT_LOG_DIR`. |
| `db-backup.py` | Consistent snapshot of the mailbox database. |
| `doh.py` | DNS-over-HTTPS lookups, for checking mail records without a local resolver. |

Three scripts that used to live here — `night-plan.sh`, `uplink-lane.sh` and
`takeout-queue.sh` — were a run-book for one tenant's migration: named seats,
specific archive filenames, and an external drive. They also depended on a
`mbox-scan.py` that was never in this repo. They stay in the mailbox they were
written for rather than shipping here as something to copy.
