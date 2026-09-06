# Linux hosting

Use one Ubuntu 24.04 VM, systemd, and Caddy. Keep one live AXP host per SQLite
database. A second host or load balancer does not make this release highly
available: subscriptions are process-local and the database has one writer.
Caddy serves public website files directly and proxies authenticated WebSockets.
This is sufficient for the initial deployment; measure traffic before adding a
CDN, Front Door, Redis, containers in production, or another server.

## Service layout

| Path / service                                  | Purpose                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| `/opt/axp/releases/RELEASE`, `/opt/axp/current` | Root-owned application releases and the selected release          |
| `/etc/axp`                                      | Root-owned configuration and access profiles                      |
| `/var/lib/axp`                                  | Private SQLite state owned by the `axp` service user              |
| `/var/backups/axp`                              | Seven completed daily recovery snapshots                          |
| `/var/www/axp.computer`                         | Public website files, readable by Caddy                           |
| `axp-host.service`                              | Loopback host, graceful SIGTERM, restart after failure            |
| `axp-health.timer`                              | Check the host every minute; restart it if it stops responding    |
| `axp-backup.timer`                              | Daily SQLite backup, integrity check, configuration and checksums |
| `axp-aamp.service`                              | Optional mailbox adapter; needs a configured mailbox              |

Host failures retry every ten seconds, including after a temporary configuration
or storage problem. Startup waits for a valid AXP health response. Three failed
health checks restart an unresponsive host. If you stop the service yourself,
it stays stopped. The host has a 1 GiB memory limit and the adapter 512 MiB.
Adjust these with `systemctl edit` after measuring. If a service runs out of
memory, systemd restarts it instead of letting it grow. Service logs go to
journald.

The service user cannot modify application releases or system files. The host
configuration is root-owned and readable only by root and the `axp` group; the
owner's remote access profile remains root-only.
The host and adapter do not run agent tools. This recipe does not install a
hosted agent; that requires a separate deployment.

## Prepare a release

Build with the checked-in lockfile on the build machine:

```sh
npm ci
npm run check
npm run test:ops
tar -czf axp-linux-release.tgz package.json package-lock.json dist schema deploy \
  scripts/ops.mjs docs/linux-hosting.md LICENSE THIRD_PARTY_NOTICES.md
shasum -a 256 axp-linux-release.tgz
```

Copy the artifact to the VM and verify its checksum. Install Node >=24.15 at
`/usr/bin/node`, npm, and Caddy through your normal OS provisioning. Extract to
a new release directory, then install only the locked runtime dependencies:

```sh
release=/opt/axp/releases/RELEASE
sudo install -d -m 0755 "$release"
sudo tar -xzf /tmp/axp-linux-release.tgz -C "$release"
sudo npm ci --omit=dev --ignore-scripts --prefix "$release"
sudo bash "$release/deploy/linux/install.sh" "$release" maceip/AXP
```

The installer prepares units and directories, generates one private owner
identity on first installation, and keeps existing credentials on later
runs. It does not start services or change the shared Caddy configuration. A
different existing release requires the upgrade procedure below. Keep the owner
profile private; add distinct principals for participants as described in
[hosting](hosting.md). Do not hand everyone the owner token.

Start the host and its timers:

```sh
sudo systemctl enable --now axp-host.service axp-health.timer axp-backup.timer
curl --fail http://127.0.0.1:7331/healthz
sudo systemctl list-timers 'axp-*'
```

The fixed paths in the units and backup script are intentional. Keep the host
database at `/var/lib/axp/hub.db`, the adapter journal at `/var/lib/axp/aamp.db`,
and configuration files directly inside `/etc/axp`.

## HTTPS and the website

Import `/etc/caddy/axp.caddy` at the top level of the existing Caddyfile, preserving
its other sites. This fragment selects Let's Encrypt to match the
domain's CAA, redirects `www` to the apex, compresses static responses, and proxies
`/axp` and `/healthz` to loopback. Caddy preserves Authorization and performs
[WebSocket upgrades](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
without custom header rewriting. Clients reconnect after configuration reloads
or service restarts.

Validate the combined configuration before reloading:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

If the existing service disables the admin API, `caddy reload` will not work.
For a service started with `caddy run --config` without `--resume` or API-managed
changes, Caddy supports `systemctl kill --kill-who=main --signal=SIGUSR1 caddy`
to reload that file. Check the installed version's [signal support](https://caddyserver.com/docs/command-line#signals)
and read the journal for successful reload. Reload the configuration to add a site; avoid restarting a shared web server.
Review global settings before changing them.

Publish the public website artifact to `/var/www/axp.computer` separately. The
installer creates an empty directory; it does not create a website.
Do not expose `axp ui` through this proxy: its personal gateway holds one local
profile. Hosting the workspace publicly would need login
and account management first.

Verify valid HTTPS certificates for both names, the apex website, the
`www` redirect, and `/healthz`. Connect with an individual profile using
`AXP_URL=wss://axp.computer/axp`; verify authenticated session access and reject
missing/incorrect credentials. Working DNS, redirects and health checks do not mean the website is up.
Open the public page and check its content too.

## Mail

The AAMP service is a mailbox **client**, not an SMTP receiving server. Configure
a JMAP mailbox and authenticated SMTP submission using [the adapter guide](aamp.md).
Place its configuration in `/etc/axp/aamp.json`, its session-scoped maintainer
profile in `/etc/axp/aamp-profile.json`, and its password assignment in
`/etc/axp/aamp.env`. Set `database` to `/var/lib/axp/aamp.db`. All three files must
be root-owned. Give the two JSON files group `axp` and mode 0640; keep the password
environment file mode 0600. It uses systemd EnvironmentFile syntax and is loaded
by the service manager.
Then enable `axp-aamp.service`. A stopped adapter does not prevent the host starting.

Receiving mail for `@axp.computer` also needs a mail service, mailboxes,
MX and host records, DKIM, SPF, DMARC, and an authenticated sender policy suitable
for AAMP. Publish provider-issued values after provisioning. An arbitrary SMTP
server plus a From-address allowlist does not prove who sent a message.

For Azure subscriptions that restrict direct outbound SMTP, use an authenticated
relay on port 587. An inbound MTA on the VM may still queue mail locally, but it
needs that delivery path; opening an NSG port does not remove an Azure platform
restriction. [Azure SMTP policy](https://learn.microsoft.com/en-us/troubleshoot/azure/virtual-network/troubleshoot-outbound-smtp-connectivity).
Do not open mail ports or publish MX until the receiving service and relay are
ready. No mail service or relay is installed by this recipe.

## Backups and recovery

The backup service uses SQLite's online backup API for the host, including its
blobs, events and dispatch receipts. It briefly stops a running AAMP adapter so
mail cursors cannot advance between the host and journal snapshots, then resumes
it even if backup fails. Avoid manual adapter starts during that short window.
An inactive adapter stays inactive. Do not run `ops.mjs backup` directly while
AAMP is running; use `systemctl start axp-backup.service`.

Each successful snapshot contains standalone checked databases, private
configuration and a checksum manifest. Failed snapshots are not published, and
old snapshots are pruned only after a successful replacement. The timer catches
up after downtime. Inspect failures with `systemctl --failed` and
`journalctl -u axp-backup.service`. The health check restarts the host; it
does not alert anyone.

Local snapshots do not survive VM/disk loss. Before relying on this for public
work, enable daily Azure VM Backup (including the data disk if used) and perform
a restore drill. Back up Caddy's configuration/certificate storage and public
website artifacts as well. Reuse existing Azure monitoring for VM availability,
disk capacity, failed units and backup failures; add an HTTPS availability check
when the website is live. Make sure journald log retention is capped.

To restore: stop both AXP timers and services, keep a separate copy of the current
state and configuration directories, verify every checksum in the selected
snapshot, and place its databases in a **new, empty** `/var/lib/axp` directory.
Do not combine restored databases with old WAL/SHM/lock files. Restore matching
configuration to `/etc/axp`: root owns it, the directory has group `axp` and mode
0750, and the service JSON files have group `axp` and mode 0640. Keep other profiles
and the password file root-only mode 0600. State is owned by `axp:axp`, with its
directory mode 0700 and files 0600. Start the host, verify authenticated
history, then start the adapter if used and re-enable the timers. Restored mail
may be redelivered: keep task/Message-ID deduplication and review recovery from
an older snapshot before letting the adapter send messages or start tasks again.

## Upgrades and rollback

Extract and install dependencies into a new root-owned release directory. Take
a successful snapshot first, stop the timers and adapter, then stop the host.
Record the old `readlink -f /opt/axp/current`. Select the new release with a
temporary symlink and `mv -Tf` to `/opt/axp/current`, and run its installer to
update managed units. Start the host and verify authenticated access before
resuming the adapter and timers. `systemctl edit` drop-ins remain separate from
the managed units. Caddy fragments are kept; review any upstream changes.

If validation fails, stop the new host and restore the old symlink and units.
Read the release's schema compatibility notes before reopening its database with
older code; when necessary restore the matching pre-upgrade snapshot. Do not
start two releases against the same database or roll the database back without checking which changes would be lost.

When `aamp.json` is configured, a backup requires its `aamp.db` journal. A
missing journal fails the snapshot and preserves the previous backup; a recovery snapshot without delivery receipts is incomplete.
