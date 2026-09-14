#!/bin/bash
# Import one Google Takeout zip for one mailbox, streaming the mbox out of the zip.
# Phase 1 (bodies, metadata) runs at once; phase 2 (attachments to the bucket) waits until
# no other backfill is uploading, so archives never compete for the uplink.
# Idempotent: re-running resumes; each phase retries until its completion line appears.
set -u
ZIP=$1; OWNER=$2
S=${IMPORT_LOG_DIR:?set IMPORT_LOG_DIR to a scratch directory}
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env.local; set +a
TAG=${OWNER%%@*}
ENTRY=$(unzip -l "$ZIP" 2>/dev/null | grep -o "Takeout/Mail/.*\.mbox" | head -1)
[ -z "$ENTRY" ] && { echo "no mbox inside $ZIP"; exit 2; }
IMPORTER="tools/import-mbo""x.py"
ARCHIVE_ID=$(printf "%s" "$ZIP" | shasum | cut -c1-8)
# Logs are per archive, not per owner: two archives for one mailbox must not share state.
LOG1="$S/import-$TAG-$ARCHIVE_ID-phase1.log"; LOG2="$S/import-$TAG-$ARCHIVE_ID-attach.log"
# The first archive imported for a mailbox predates the archive id; keep its history.
[ -f "$S/import-$TAG-phase1.log" ] && [ ! -f "$LOG1" ] && [ -n "${IMPORT_LEGACY_TAG:-}" ] && [ "$TAG" = "$IMPORT_LEGACY_TAG" ] && cp "$S/import-$TAG-phase1.log" "$LOG1"

attempt=0
until grep -q "^imported for" "$LOG1" 2>/dev/null; do
  attempt=$((attempt + 1)); [ $attempt -gt 8 ] && { echo "phase 1 gave up after 8 attempts: $TAG"; exit 3; }
  echo "[$(date +%H:%M)] phase 1 attempt $attempt: $TAG"
  unzip -p "$ZIP" "$ENTRY" | python3 "$IMPORTER" - --owner "$OWNER" --skip-attachments --writers 3 > "$LOG1" 2>&1
  grep -q "^imported for" "$LOG1" || sleep 120
done
echo "[$(date +%H:%M)] PHASE 1 DONE: $TAG — $(grep -A1 '^imported for' "$LOG1" | tail -1 | sed 's/^ *//')"

# Phase 2 runs detached in its own lane: one upload at a time across all archives (lock dir),
# so the queue can move on to the next archive's phase 1 while this one waits its turn.
phase2() {
  LOCK="$S/attach.lock"
  until mkdir "$LOCK" 2>/dev/null; do sleep 120; done
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT
  while [ "$(ps -eo command | grep "[P]ython.*import-mbox" | grep -c -- "--attach-only")" -ge 1 ]; do sleep 300; done
  attempt=0
  until grep -q "^attachments backfilled" "$LOG2" 2>/dev/null; do
    attempt=$((attempt + 1)); [ $attempt -gt 20 ] && { echo "[$(date +%H:%M)] phase 2 gave up after 20 attempts: $TAG"; exit 4; }
    echo "[$(date +%H:%M)] phase 2 attempt $attempt: $TAG"
    unzip -p "$ZIP" "$ENTRY" | python3 "$IMPORTER" - --owner "$OWNER" --attach-only --store s3 --replace-blob --workers 16 --chunks 6 --max-mbps 4.5 > "$LOG2" 2>&1
    grep -q "^attachments backfilled" "$LOG2" || sleep 120
  done
  echo "[$(date +%H:%M)] PHASE 2 DONE: $TAG — $(grep -A1 '^attachments backfilled' "$LOG2" | tail -1 | sed 's/^ *//')"
}
if grep -q "^attachments backfilled" "$LOG2" 2>/dev/null; then echo "[$(date +%H:%M)] phase 2 already complete: $TAG"; exit 0; fi
if ps -eo command | grep "[P]ython.*import-mbox" | grep -- "--attach-only" | grep -q "$OWNER"; then echo "[$(date +%H:%M)] phase 2 already running: $TAG"; exit 0; fi
perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' -- bash -c "$(declare -f phase2); S='$S'; LOG2='$LOG2'; TAG='$TAG'; ZIP='$ZIP'; ENTRY='$ENTRY'; IMPORTER='$IMPORTER'; OWNER='$OWNER'; cd '$PWD'; set -a; . ./.env.local; set +a; phase2" >> "$S/takeout-queue.log" 2>&1 < /dev/null &
echo "[$(date +%H:%M)] phase 2 queued (detached, waits for the upload lane): $TAG"
