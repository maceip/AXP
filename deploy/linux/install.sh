#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $EUID -ne 0 || $# -ne 2 ]]; then
  echo 'Usage (as root): install.sh /opt/axp/releases/RELEASE owner/project' >&2
  exit 1
fi
release=$(realpath -- "$1")
case "$release" in
  /opt/axp/releases/*) ;;
  *) echo 'Use a dedicated release below /opt/axp/releases.' >&2; exit 1 ;;
esac
[[ -f "$release/dist/cli.js" && -d "$release/node_modules" ]]
[[ -f "$release/schema/upstream/ahp-actions.schema.json" ]]
/usr/bin/node --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw Error("Node >=24.15 required at /usr/bin/node");
  await import("node:sqlite");
'
if [[ -e /opt/axp/current || -L /opt/axp/current ]]; then
  if [[ $(realpath /opt/axp/current) != "$release" ]]; then
    echo 'A different release is installed. Follow the documented upgrade procedure.' >&2
    exit 1
  fi
fi
if ! getent passwd axp >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/axp --shell /usr/sbin/nologin axp
fi
install -d -o axp -g axp -m 0700 /var/lib/axp
install -d -o root -g axp -m 0750 /etc/axp
install -d -o root -g root -m 0700 /var/backups/axp
install -d -o root -g root -m 0755 /etc/caddy /var/www/axp.computer
chown -R root:root -- "$release"
chmod -R go-w -- "$release"
if [[ ! -e /opt/axp/current ]]; then ln -s "$release" /opt/axp/current; fi
/usr/bin/node "$release/scripts/ops.mjs" provision "$2" /etc/axp /var/lib/axp
chown root:axp /etc/axp/hub.json
chmod 0640 /etc/axp/hub.json
for unit in "$release"/deploy/linux/*.service "$release"/deploy/linux/*.timer; do
  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
done
if [[ ! -e /etc/caddy/axp.caddy ]]; then
  install -o root -g root -m 0644 "$release/deploy/linux/Caddyfile" /etc/caddy/axp.caddy
fi
systemd-analyze verify /etc/systemd/system/axp-*.service /etc/systemd/system/axp-*.timer
systemctl daemon-reload
cat <<'MESSAGE'
AXP service files are prepared. Existing identities and Caddy sites were retained.
Review /etc/axp/hub.json and keep /etc/axp/maintainer.json private.
Start the host and timers:
  systemctl enable --now axp-host.service axp-health.timer axp-backup.timer
Import /etc/caddy/axp.caddy into the existing Caddyfile, validate, then reload.
The public website assets and optional mail service still require deployment.
Read docs/linux-hosting.md for verification, backup/restore, and upgrades.
MESSAGE
