# Security model

Use GitHub's private vulnerability reporting for security issues. Include a
minimal reproducer and affected version. Do not publish private session data
or credentials in an issue.

The host controls identities, access, event ordering, leases, spending records
and review. Contributors can be unreliable or dishonest. Agent output is
accepted only from the current lease holder, with a matching epoch, before
the lease expires. Contributors cannot approve their own tool requests, change
other contributors' budgets or record verification results. Sharing a blob
between sessions does not grant access to it.

**Git worktrees are not sandboxes.** Native mode allows agent tools
to run as the local user. ACP capability negotiation does not confine a
process's own filesystem or network access. The Docker launcher mounts the
worktree, drops capabilities, disables networking and provides a read-only
root with temporary storage. To use a remote model from a container, configure a proxy or network access.
Networking is disabled by default. TEE attestation is not implemented yet.

AXP control credentials are not inherited by the agent. Provider credentials
stay on the machine running the agent. To enforce a hard spending cap, use
provider limits or a quota proxy. Usage reports are self-reported. When usage
is unknown, the full reservation is charged. A signature identifies who made
a claim about an artifact; it does not prove the claim is true.

Use TLS remotely, separate contributor and verifier identities, and isolated
verification infrastructure. One live hub owns one database; do not share it
between concurrent hosts or expose its files to an agent. The current release
keeps all session history, so you are responsible for managing storage.
