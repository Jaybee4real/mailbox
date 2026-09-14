#!/bin/bash
# Runs the jobs that need the home uplink, strictly one at a time.
#
# Attachment uploads and archive phase 1s all push through the same connection; running two
# at once produced connection resets and halved throughput, so this lane serialises them.
# Every job is idempotent, so a job that dies is simply retried from the top.
set -u
S=${IMPORT_LOG_DIR:-/private/tmp/claude-501/-Users-jaybee4real-Documents-Programming-Codes-Personal-Web-metroperil-landing/2cd382f6-87f6-47c9-ba7e-d32082a17fe1/scratchpad}
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env.local; set +a
IMPORTER="tools/import-mbo""x.py"
ROKO_MBOX="/Volumes/SSD-Jaybee/Metroperil-Backup/Takeout/Mail/All mail Including Spam and Trash.mbox"
ODUN_ZIP="/Volumes/SSD-Jaybee/Metroperil-Backup/a-odunlami-takeout-20260907T115358Z-1-001.zip"

busy() { ps -eo command | grep -q "[P]ython.*import-mbox"; }
wait_for_lane() { while busy; do sleep 60; done; }

# run <log> <done-marker> <max-attempts> <command...>
run() {
  local log=$1 marker=$2 max=$3; shift 3
  local attempt=0
  until grep -q "^$marker" "$log" 2>/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -gt "$max" ] && { echo "[$(date +%H:%M)] gave up after $max attempts: $log"; return 1; }
    echo "[$(date +%H:%M)] attempt $attempt: $(basename "$log")"
    "$@" > "$log" 2>&1
    grep -q "^$marker" "$log" || sleep 60
  done
  echo "[$(date +%H:%M)] DONE: $(basename "$log") — $(grep -A1 "^$marker" "$log" | tail -1 | sed 's/^ *//')"
}

roko_attach() {
  python3 "$IMPORTER" "$ROKO_MBOX" --owner rokoeman@metroperilinsbrokers.com \
    --attach-only --store s3 --replace-blob --workers 16 --chunks 6 --max-mbps 4.5
}
odun_phase1() {
  local entry; entry=$(unzip -l "$ODUN_ZIP" 2>/dev/null | grep -o "Takeout/Mail/.*\.mbox" | head -1)
  unzip -p "$ODUN_ZIP" "$entry" | python3 "$IMPORTER" - --owner aodunlami@metroperilinsbrokers.com --skip-attachments --writers 3
}
odun_attach() {
  local entry; entry=$(unzip -l "$ODUN_ZIP" 2>/dev/null | grep -o "Takeout/Mail/.*\.mbox" | head -1)
  unzip -p "$ODUN_ZIP" "$entry" | python3 "$IMPORTER" - --owner aodunlami@metroperilinsbrokers.com \
    --attach-only --store s3 --replace-blob --workers 16 --chunks 6 --max-mbps 4.5
}

echo "[$(date +%H:%M)] lane started; waiting for the current job to finish"
wait_for_lane
run "$S/import-rokoeman-attach.log"   "attachments backfilled" 20 roko_attach
wait_for_lane
run "$S/import-aodunlami-phase1.log"  "imported for"           10 odun_phase1
wait_for_lane
run "$S/import-aodunlami-attach.log"  "attachments backfilled" 20 odun_attach
echo "[$(date +%H:%M)] LANE COMPLETE"
