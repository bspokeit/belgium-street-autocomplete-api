#!/bin/bash
set -euo pipefail

NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
LOG_FILE="/tmp/best-import-$$.log"

notify() {
  local subject="$1"
  local body="$2"
  echo "$body"
  if [ -n "$NOTIFY_EMAIL" ]; then
    echo "$body" | mail -s "$subject" "$NOTIFY_EMAIL"
  fi
}

echo "[$(date)] Starting BeSt Address update" | tee "$LOG_FILE"

if wget --progress=bar:force https://opendata.bosa.be/download/best/best-full-latest.zip -O /tmp/best.zip \
  && rm -rf /tmp/best && mkdir /tmp/best \
  && unzip -q /tmp/best.zip -d /tmp/best/ \
  && docker compose run --rm -v /tmp/best:/tmp/best api node dist/scripts/import.js 2>&1 | tee -a "$LOG_FILE"; then

  notify "✅ BeSt import succeeded" "$(cat "$LOG_FILE")"
  echo "[$(date)] Update complete"
else
  notify "❌ BeSt import FAILED" "$(cat "$LOG_FILE")"
  rm -f "$LOG_FILE"
  echo "[$(date)] Update failed"
  exit 1
fi

rm -f "$LOG_FILE"
