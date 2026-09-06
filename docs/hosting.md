# Hosting and access

Run `axp init --repo owner/project` inside a Git repository, then `axp serve`.
The default endpoint is `ws://127.0.0.1:7331/axp`; `/healthz` is the health check.
The host never runs agent tools or calls a model provider.

For a persistent Linux deployment, use the [systemd services and recovery
runbook](linux-hosting.md). They keep the host behind Caddy, restart after crashes
and failed health checks, and snapshot SQLite without copying a live WAL.

`.axp/hub.json` contains the database path and credentials. Profiles contain
the endpoint and one credential. Files are created with mode 0600 and `init`
never overwrites them. `init` and worktree creation exclude `/.axp/` in the
repository's local Git exclude file. Keep signing keys in `.axp/` as well.

For participants, configure distinct random tokens and principal IDs.
Each principal has `maintainer`, `contributor`, `observer` or `verifier` role,
and `sessions: "*"` or an array of `ahp-session:/ID` / `axp-session:/ID` URIs.
Restart after changing credentials; restarting disconnects any connected
agents and clears their leases. User provisioning and OIDC are up to your
deployment. Give each contributor their own identity instead of sharing the
demo contributor profile.

Tokens are carried in the HTTP upgrade Authorization header. Client IDs are
persistently bound to principals. Reconnecting with a new client ID does not
change permissions. Direct memory subscription requires a maintainer with repository-wide access; search
checks the source session scopes before returning a lesson.

For remote use, terminate TLS at a reverse proxy and forward WebSocket upgrade
and Authorization headers. Keep idle timeouts longer than the heartbeat
interval and frame limits compatible with blobs. Use `wss://your-host/axp`;
the Node client rejects remote plaintext. Browser Origin headers are rejected
unless listed in `allowedOrigins`. The packaged [workspace](workspace.md)
uses a personal loopback gateway with a local profile; each participant runs
their own gateway against the shared host. Public browser hosting still needs
login and account management, which are not included.

Defaults: 16 MB per blob, 2 GB aggregate blob storage, 256 subscriptions per
connection, 64 KiB command envelopes. Large outputs use blob
references. The aggregate quota counts physical blob bytes: re-uploading an
existing digest consumes no additional quota, but still requires permission
to associate it with the session. Deduplication never grants access on
its own.

Back up SQLite with its backup tooling or stop the host before copying files.
Do not copy a live database without its WAL. One live hub owns a database:
an exclusive OS-backed SQLite lock rejects a second process and releases on
crash. The database is bound to its repository name, including before the first
session; reusing it under a different name fails startup. Subscriptions only receive events from that host process.
History and blobs are not deleted automatically, so plan for storage growth.

For hosted execution, run the same satellite on project infrastructure with
its own contributor principal and a locally configured budget-limited proxy.
Model keys stay on the machine running that agent. Contributors can attach as observers
and export the same resulting history.
