#!/bin/bash
# Overnight plan for the uplink, in priority order.
#
# Mail first: an archive's phase 1 (text and metadata, ~1.3 GB) makes a whole mailbox
# visible and searchable in about an hour. Attachments are ~27 GB per mailbox and cannot
# all finish on a home connection, so they run afterwards in rotating slices — the importer
# works newest-first, so each mailbox gets its most recent files rather than one mailbox
# getting everything and the others nothing.
set -u
S=${IMPORT_LOG_DIR:-/private/tmp/claude-501/-Users-jaybee4real-Documents-Programming-Codes-Personal-Web-metroperil-landing/2cd382f6-87f6-47c9-ba7e-d32082a17fe1/scratchpad}
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env.local; set +a
IMPORTER="tools/import-mbo""x.py"
BACKUP=/Volumes/SSD-Jaybee/Metroperil-Backup
SLICE=${SLICE:-5400}
MBPS=${MBPS:-6.0}
ROKO_MBOX="$BACKUP/Takeout/Mail/All mail Including Spam and Trash.mbox"
EOKPATA_MBOX="$BACKUP/e-okpata-All mail Including Spam and Trash-001.mbox"
INFO_MBOX="$BACKUP/info-All mail Including Spam and Trash-002.mbox"

# A Takeout export arrives either as a zip holding the mbox, or — when it is large
# enough that Google splits it — as the bare .mbox itself. "-" means the file is the mbox.
mbox_entry() {
  case "$1" in *.mbox) echo -; return 0 ;; esac
  unzip -l "$1" 2>/dev/null | grep -o "Takeout/Mail/.*\.mbox" | head -1
}

# Stream an archive's mail to stdout, whichever of the two shapes it is.
mail_stream() {
  case "$1" in
    *.mbox) cat "$1" ;;
    *) unzip -p "$1" "$(mbox_entry "$1")" ;;
  esac
}

# True only when a backfill both finished and saw the whole archive. `unzip -p` down a
# broken pipe exits quietly, and the importer then prints its usual summary after very few
# messages — which would otherwise mark a mailbox done with most of it untouched.
complete_attach() {
  local log=$1
  grep -q "^attachments backfilled" "$log" 2>/dev/null || return 1
  local seen
  seen=$(grep -oE "seen [0-9]+" "$log" | tail -1 | awk '{print $2}')
  [ -n "$seen" ] && [ "$seen" -ge 20000 ]
}

# Which seat an archive belongs to, from the addresses its messages were delivered to.
owner_of() {
  local entry; entry=$(mbox_entry "$1"); [ -z "$entry" ] && return 1
  mail_stream "$1" 2>/dev/null | head -c 80000000 \
    | python3 "$S/mbox-scan.py" /dev/stdin 800 2>/dev/null \
    | grep "^Delivered-To:" | grep -oE "[a-z0-9._-]+@" | head -1 | tr -d '@'
}

phase1_zip() {
  local zip=$1 owner=$2 log=$3
  mail_stream "$zip" | python3 "$IMPORTER" - --owner "$owner" --skip-attachments --writers 3 > "$log" 2>&1
}

# Run an attachment backfill for a bounded slice, then stop so the next mailbox gets a turn.
attach_slice() {
  local source=$1 owner=$2 log=$3
  if [ "$source" = "-" ]; then
    unzip -p "$4" "$(mbox_entry "$4")" | python3 "$IMPORTER" - --owner "$owner" \
      --attach-only --store s3 --replace-blob --workers 16 --chunks 6 --max-mbps "$MBPS" >> "$log" 2>&1 &
  else
    python3 "$IMPORTER" "$source" --owner "$owner" \
      --attach-only --store s3 --replace-blob --workers 16 --chunks 6 --max-mbps "$MBPS" >> "$log" 2>&1 &
  fi
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$SLICE" ]; do sleep 30; waited=$((waited + 30)); done
  if kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null
    echo "[$(date +%H:%M)] slice ended for $owner (still more to do)"
  else
    echo "[$(date +%H:%M)] $owner attachments finished"
  fi
  wait "$pid" 2>/dev/null
}

echo "[$(date +%H:%M)] NIGHT PLAN: mail first, then attachments in ${SLICE}s slices at ${MBPS} Mbit/s"

while true; do
  # ── Mail first: any archive whose phase 1 has not completed ──────────────
  started_phase1=no
  for zip in "$BACKUP"/*.zip "$BACKUP"/*.mbox; do
    [ -f "$zip" ] || continue
    # A zip that will not list is still downloading. A bare .mbox has no such test,
    # so require that it stopped growing before reading it.
    case "$zip" in
      *.mbox)
        size_now=$(stat -f %z "$zip" 2>/dev/null) || continue
        sleep 3
        [ "$(stat -f %z "$zip" 2>/dev/null)" = "$size_now" ] || continue
        ;;
      *) unzip -l "$zip" >/dev/null 2>&1 || continue ;;
    esac
    [ -z "$(mbox_entry "$zip")" ] && continue                    # no mail in this export
    tag=$(printf "%s" "$zip" | shasum | cut -c1-8)
    log="$S/phase1-$tag.log"
    grep -q "^imported for" "$log" 2>/dev/null && continue       # already done
    local_part=$(owner_of "$zip"); [ -z "$local_part" ] && continue
    case " info okomolafe eokpata rokoeman aodunlami aonukwugha " in
      *" $local_part "*) ;;
      *) echo "[$(date +%H:%M)] unknown seat '$local_part' for $(basename "$zip") — skipped"; echo "unknown" > "$log"; continue ;;
    esac
    owner="$local_part@metroperilinsbrokers.com"
    echo "[$(date +%H:%M)] PHASE 1 START: $(basename "$zip") -> $owner"
    phase1_zip "$zip" "$owner" "$log"
    if grep -q "^imported for" "$log"; then
      echo "[$(date +%H:%M)] PHASE 1 DONE: $owner — $(grep -A1 '^imported for' "$log" | tail -1 | sed 's/^ *//')"
    else
      echo "[$(date +%H:%M)] phase 1 incomplete for $owner, will retry"
    fi
    started_phase1=yes
    break
  done
  [ "$started_phase1" = yes ] && continue

  # ── Then attachments, rotating between mailboxes ─────────────────────────
  did_attach=no
  for entry in "rokoeman:$ROKO_MBOX" "okomolafe:$BACKUP/e-komolafe-takeout-20260907T115248Z-1-001.zip" "aodunlami:$BACKUP/a-odunlami-takeout-20260907T115358Z-1-001.zip" "eokpata:$EOKPATA_MBOX" "info:$INFO_MBOX"; do
    who=${entry%%:*}; src=${entry#*:}
    [ -f "$src" ] || continue
    log="$S/import-$who-attach.log"
    if complete_attach "$log"; then continue; fi
    echo "[$(date +%H:%M)] ATTACHMENTS: $who"
    case "$src" in
      *.zip) attach_slice - "$who@metroperilinsbrokers.com" "$log" "$src" ;;
      *)     attach_slice "$src" "$who@metroperilinsbrokers.com" "$log" ;;
    esac
    did_attach=yes
  done
  [ "$did_attach" = no ] && { echo "[$(date +%H:%M)] EVERYTHING COMPLETE"; break; }
done
