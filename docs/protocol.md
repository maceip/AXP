# Protocol and interoperability

AXP **0.2.0** is negotiated alongside **AHP 0.9.0**. Published AHP and ACP
packages are pinned. The AXP client is Node-only; other clients can use the
wire schemas and ordinary AHP clients can render the baseline experience.

Package release 0.3 adds the mailbox and workspace clients, durable dispatch
and discussion commands. The negotiated wire version remains 0.2.0; new methods
are advertised in initialization. Upgrade the host for these new commands.

## Baseline AHP

The host implements `initialize`, `ping`, `reconnect`, `subscribe`,
`unsubscribe`, `createSession`, `listSessions`, `dispatchAction` and blob-backed
`resourceRead`. It exposes root, session, chat and changeset snapshots.
Unsupported methods return `MethodNotFound`; no optional terminal,
filesystem-provider, automation or multi-chat capabilities are advertised.
Activity is authoritative on chat state and its catalog summary; AHP 0.9.0
has no independent session-status mutation.

Every command has `params.channel`. Accepted actions are standard `action`
notifications carrying `{channel, action, serverSeq, origin?}`. The host
creates response parts before deltas. Client dispatches retain
`{clientId, clientSeq}` origin data. Rejected notification dispatches receive
the standard `rejectionReason` echo; rejected request dispatches receive a
JSON-RPC error. Rejections never alter shared state.

Initialization advertises `result._meta["org.axp.exchange"]` with the extension
version, method list and authenticated identity. Roles come from transport
credentials, never from client-provided initialization data.

## Extension channels

| Channel            | State                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `axp-executors://` | Executor identity, placement, capabilities and expiring presence      |
| `axp-session:/ID`  | Lease, grants, usage, checkpoint, compaction, review and verification |
| `axp-memory://`    | Repository lesson revisions; direct subscription is maintainer-only   |

Ordinary AHP clients ignore these channels. AXP clients use the exported pure
reducers. Producers submit commands; the host validates authority and
invariants before generating extension actions.

## Commands

Schemas are in [`schema/`](../schema). The SDK's `call` validates parameters
and infers result types. Mutations require an `operationId`; callers can supply
one for retries across process restarts. Reusing an ID with different input is
a conflict. Read commands need no ID.

| Commands                                                       | Purpose                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `_axp/register`                                                | Discover and refresh contributor-owned executors                      |
| `_axp/dispatch`                                                | Durable, maintainer-authorized AHP interaction across client restarts |
| `_axp/comment`                                                 | Scoped, attributed discussion with optional checkpoint/file reference |
| `_axp/grant`, `_axp/revoke`                                    | Donor-owned allowances and revocation                                 |
| `_axp/claim`, `_axp/renew`, `_axp/release`                     | Atomic ownership and fencing                                          |
| `_axp/reserve`, `_axp/settle`, `_axp/emit`                     | Accounted, authorized execution                                       |
| `_axp/checkpoint`                                              | Git-bound changeset and portable artifact                             |
| `_axp/compact`, `_axp/acceptCompaction`                        | Proposed and reviewed context replacement                             |
| `_axp/memoryPropose`, `_axp/memoryReview`, `_axp/memorySearch` | Scoped lessons                                                        |
| `_axp/review`, `_axp/approveReview`, `_axp/verify`             | Artifact signatures and verification                                  |
| `_axp/blobPut`, `_axp/blobGet`                                 | Session-scoped content                                                |
| `_axp/context`, `_axp/export`                                  | Working context or full audit history                                 |

## Ordering and recovery

`_axp/comment` appends a discussion entry to an exchange and the shared audit.
The host assigns the authenticated author and current time. Scoped maintainers,
contributors and verifiers can post; observers cannot. Optional file references
must identify the current checkpoint. Retry receipts prevent duplicate posts.
Existing persisted sessions without a discussion field render an empty thread.
Comments remain independent of AHP user prompts and tool permissions.

`AxpClient.dispatch(channel, action, operationId)` uses `_axp/dispatch` when
an operation ID is supplied. It applies the same action validation, session
scope and maintainer authority as AHP `dispatchAction`, with a durable retry
receipt. This path does not invent a client-sequence origin. Without the third
argument, dispatch retains the ordinary AHP client origin and behavior. The
[AAMP adapter](aamp.md) uses this path for mail admission and cancellation.

`_axp/close` is maintainer-only. It cancels outstanding work, clears pending
messages, releases the task identity and archives the session without deleting
its audit. Closed sessions cannot be claimed or prompted.

One SQLite transaction serializes state changes, action sequence allocation
and retry receipts. It commits before broadcast. Rollback leaves no accepted
action. Reducers do no I/O and read no clocks; timers emit explicit expiry
actions. One open session owns a task. Another open session with the same task
or a second executor claim is rejected.

Leases last 3–300 seconds, with heartbeats every third of that duration. Every
executor mutation checks owner, epoch, expiry and grant. Token output is not
a heartbeat, so quiet compiles can remain live. New claims advance the epoch.
Host restart interrupts work and clears old leases. A disconnected satellite
cancels its agent and reconnects with the same donation and local worktree.
An uncertain turn is settled conservatively and is not automatically replayed.
A new ACP process hydrates from the shared context when a maintainer sends the
next prompt. Unuploaded local edits survive on the original machine; only
uploaded checkpoints are recoverable on another machine.

`_axp/claim` accepts `resumeEpoch` for automatic recovery. In one transaction,
the host checks that the epoch has not advanced and any remaining lease belongs
to the same principal, executor and grant, interrupts uncertain work, and issues
the next epoch. An intervening owner causes rejection even if it has already
released its lease. Retrying an uncertain claim uses its original operation ID;
the returned receipt does not authorize execution under an expired epoch.

The satellite retries transient transport errors with jittered exponential
backoff, capped at 30 seconds by default. Authentication, protocol, ownership,
budget and local agent failures stop it. Reconnecting never resets spending,
widens a donor's updated limit or reverses revocation. `--no-reconnect` disables
automatic retry. A new invocation of `park` is a new donation, restoring the
host's latest checkpoint into a new worktree and preserving older local trees.

Upgrade the host and satellites together from 0.1: AXP version negotiation is
exact. The SQLite state format and ordinary AHP channels are unchanged.

Reconnect returns ordered replay within the replay budget, otherwise fresh
snapshots. Future cursors and another principal's client ID are rejected.
Socket queues are bounded; overflow disconnects rather than silently dropping
events. Audit history is retained. Deployments must provision storage and
their own archival policy. This release makes no thousand-node throughput claim.

## Spending

Budgets use integer tokens, turns and USD millionths. Cache reads are a subset
of input tokens and are not counted twice. Reserve exactly one turn before
producing output. Settlement is idempotent. Missing usage consumes the ceiling;
reported overspend remains visible and revokes further work. An opaque ACP
process requires an external provider/proxy cap for a hard spending boundary.
`enforcement: provider` is a donor declaration, not an attestation by AXP.
ACP cache-inclusive and cache-exclusive reports are normalized against their
reported total; inconsistent telemetry falls back to the reservation. Raw
prompt usage remains in the audit. `costSource` identifies whether USD was
reported or charged from the reserved ceiling, independently of token source.

## Upstream compatibility

The full upstream reducer corpus is kept byte-for-byte with its MIT license.
AHP 0.9.0's generated `StateAction` schema contains a dangling `#/$defs/`
reference. AXP compiles the concrete discriminated definitions from that
unchanged schema, preserving field validation.

The ACP boundary advertises v1 with file and terminal provider RPCs disabled.
An explicitly configured `authMethod` is checked against advertised methods
and invoked before creating the agent session. Keys stay in the local agent
environment and are never sent to the repository host.
Permission choices keep their original IDs, allow/deny grouping and tool
input. Edited-input approvals are rejected because ACP outcomes cannot carry
edits. Unknown provider updates are retained as content references. ACP v1
steering cancels and continues in a new durable turn.
