# Hosting and access

Run `axp init --repo owner/project` inside a Git repository, then `axp serve`.
The default endpoint is `ws://127.0.0.1:7331/axp`; `/healthz` provides liveness.
The host runs no agent tools or provider calls.

`.axp/hub.json` contains the database path and credentials. Profiles contain
the endpoint and one credential. Files are created with mode 0600 and `init`
never overwrites them. `init` and worktree creation exclude `/.axp/` in the
repository's local Git exclude file. Keep signing keys in `.axp/` as well.

For real participants, configure distinct random tokens and principal IDs.
Each principal has `maintainer`, `contributor`, `observer` or `verifier` role,
and `sessions: "*"` or an array of `ahp-session:/ID` / `axp-session:/ID` URIs.
Restart after changing credentials; restart fences existing executors.
Identity provisioning/OIDC is deployment-owned. Do not distribute the shared
demo contributor identity to multiple independent donors.

Tokens are carried in the HTTP upgrade Authorization header. Client IDs are
persistently bound to principals. Reconnecting with a new client ID does not
change authority. Direct memory subscription requires a maintainer; search
checks the source session scopes before returning a lesson.

For remote use, terminate TLS at a reverse proxy and forward WebSocket upgrade
and Authorization headers. Keep idle timeouts longer than the heartbeat
interval and frame limits compatible with blobs. Use `wss://your-host/axp`;
the Node client rejects remote plaintext. Browser Origin headers are rejected
unless listed in `allowedOrigins`. The packaged [workspace](workspace.md)
uses a personal loopback gateway with a local profile; each participant runs
their own gateway against the shared host. Public browser hosting still needs
an authenticated session integration and account provisioning.

Defaults: 16 MB per blob, 2 GB aggregate blob storage, 256 subscriptions per
connection, 64 KiB ordinary command envelopes. Large outputs use blob
references. Physical SHA-256 deduplication never grants cross-session access.

Back up SQLite with its backup tooling or stop the host before copying files.
Do not copy a live database without its WAL. One live hub owns a database:
an exclusive OS-backed SQLite lock rejects a second process and releases on
crash. Subscription fanout is process-local. This
release has no automatic audit deletion or blob collection.

For hosted execution, run the same satellite on project infrastructure with
its own contributor principal and a locally configured budget-limited proxy.
Model keys remain local to that executor. Contributors can attach as observers
and export the same resulting history.
