# Security model

Use GitHub's private vulnerability reporting for security issues. Include a
minimal reproducer and affected version. Do not publish private session data
or credentials in an issue.

The host is authoritative for identities, scopes, sequence, claims, spending
records and review. Contributors can be unreliable or dishonest. Output is
fenced by lease owner, epoch and expiry. Contributors cannot approve their
own permissions, change other donors' grants or write verifier results. Blob
access is scoped independently of physical deduplication.

**Git worktrees are not sandboxes.** Native mode explicitly permits agent tools
to run as the local user. ACP capability negotiation does not confine a
process's own filesystem or network access. The Docker launcher mounts the
worktree, drops capabilities, disables networking and provides a read-only
root with temporary storage. Remote models in containers require deployment-
provided proxy/network integration; general networking is not enabled silently.
Consumer TEE is deferred.

AXP control credentials are not inherited by the agent. Provider credentials
remain local to the executor. Opaque agents require provider/proxy limits for
hard spending caps. Reports are claims; unknown usage consumes reservations.
Signatures identify the author of an artifact declaration, not runtime truth.

Use TLS remotely, separate contributor and verifier identities, and isolated
verification infrastructure. One live hub owns one database; do not share it
between concurrent hosts or expose its files to an agent. The current release
retains all audit history and requires deployment-owned storage management.
