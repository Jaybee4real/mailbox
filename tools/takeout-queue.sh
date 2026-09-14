#!/bin/bash
# Watch for completed Takeout zips, identify whose mailbox each is, and import them one at a time.
# A zip counts as complete once its central directory reads (Chrome only renames .crdownload
# to .zip when the download finishes). Owners are matched against existing seats only.
set -u
S=${IMPORT_LOG_DIR:-/private/tmp/claude-501/-Users-jaybee4real-Documents-Programming-Codes-Personal-Web-metroperil-landing/2cd382f6-87f6-47c9-ba7e-d32082a17fe1/scratchpad}
STATE="$S/takeout-queue.state"; touch "$STATE"
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env.local; set +a
SEATS="info okomolafe eokpata rokoeman aodunlami aonukwugha"
DOMAIN=metroperilinsbrokers.com
status_of() { grep -F "$1|" "$STATE" | tail -1 | cut -d'|' -f2; }
mark() { echo "$1|$2|$(date +%FT%T)" >> "$STATE"; }
owner_of() {
  local entry; entry=$(unzip -l "$1" 2>/dev/null | grep -o "Takeout/Mail/.*\.mbox" | head -1)
  [ -z "$entry" ] && return 1
  unzip -p "$1" "$entry" 2>/dev/null | head -c 120000000 | python3 "$S/mbox-scan.py" /dev/stdin 1200 2>/dev/null \
    | grep "^Delivered-To:" | grep -oE "[a-z0-9._-]+@" | head -1 | tr -d '@'
}
while true; do
  for zip in /Volumes/SSD-Jaybee/Metroperil-Backup/*.zip "$HOME"/Downloads/*takeout*.zip; do
    [ -f "$zip" ] || continue
    st=$(status_of "$zip")
    case "$st" in ""|pending|running:*|failed:*) ;; hold:*) continue ;; *) continue ;; esac
    unzip -l "$zip" >/dev/null 2>&1 || continue
    local_part=$(owner_of "$zip")
    if [ -z "$local_part" ]; then echo "[$(date +%H:%M)] could not identify owner of $(basename "$zip") — skipping for now"; continue; fi
    if ! echo " $SEATS " | grep -q " $local_part "; then echo "[$(date +%H:%M)] UNKNOWN SEAT '$local_part' for $(basename "$zip") — not importing"; mark "$zip" "unknown:$local_part"; continue; fi
    owner="$local_part@$DOMAIN"
    echo "[$(date +%H:%M)] ARCHIVE START: $(basename "$zip") -> $owner ($(du -h "$zip" | cut -f1))"
    mark "$zip" "running:$owner"
    if tools/import-takeout.sh "$zip" "$owner"; then mark "$zip" "done:$owner"; echo "[$(date +%H:%M)] ARCHIVE DONE: $(basename "$zip") -> $owner"
    else mark "$zip" "failed:$owner"; echo "[$(date +%H:%M)] ARCHIVE FAILED: $(basename "$zip") -> $owner"; fi
  done
  sleep 120
done
