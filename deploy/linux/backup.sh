#!/usr/bin/env bash
set -euo pipefail
umask 077

# systemd serializes scheduled/manual starts; flock also covers direct invocation.
exec 9>/var/backups/axp/.backup.lock
flock -n 9 || { echo 'An AXP backup is already running.' >&2; exit 1; }
resume_mail=0
finish() {
  local result=$?
  trap - EXIT
  if (( resume_mail )); then
    systemctl start axp-aamp.service || result=1
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Freeze mail admission/cursors while taking the two database snapshots. The host
# remains online; its events, blobs and dispatch receipts share one SQLite DB.
if systemctl is-active --quiet axp-aamp.service; then
  resume_mail=1
  systemctl stop axp-aamp.service
fi
/usr/bin/node /opt/axp/current/scripts/ops.mjs backup /var/lib/axp /etc/axp /var/backups/axp
