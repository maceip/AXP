# Protocol and interoperability

AXP **0.2.0** is negotiated alongside **AHP 0.9.0**. Published AHP and ACP
packages are pinned. The AXP client is Node-only; other clients can use the
wire schemas. Standard AHP clients can show the basic session view.

Package release 0.3 adds the mailbox and workspace clients, persistent dispatch
and discussion commands. The negotiated wire version remains 0.2.0; new methods
are advertised in initialization. Upgrade the host for these new commands.

## Baseline AHP

The host implements `initialize`, `ping`, `reconnect`, `subscribe`,
`unsubscribe`, `createSession`, `listSessions`, `dispatchAction` and blob-backed
`resourceRead`. It exposes root, session, chat and changeset snapshots.
Unsupported methods return `MethodNotFound`; no optional terminal,
filesystem-provider, automation or multi-chat capabilities are advertised.
Session catalog entries include stable `createdAt` and changing `modifiedAt`.
Session activity is determined by chat state and reflected in the session
list summary. AHP 0.9.0 has no separate action for changing session status.

Every command has `params.channel`. Accepted actions are standard `action`
notifications carrying `{channel, action, serverSeq, origin?}`. The host
creates response parts before deltas. Client dispatches keep
`{clientId, clientSeq}` origin data. Rejected notification dispatches receive
the standard `rejectionReason` echo; rejected request dispatches receive a
JSON-RPC error. Rejections never alter shared state.

Initialization advertises `result._meta["org.axp.exchange"]` with the extension
version, method list, authenticated identity and `lastClientSeq`. The latter
lets an AXP client reuse its stable ID sequentially without colliding with
previous dispatch receipts; it does not permit concurrent reuse. Roles come from transport
credentials, never from client-provided initialization data.

## Extension channels

| Channel            | State                                                                           |
| ------------------ | ------------------------------------------------------------------------------- |
| `axp-executors://` | Executor identity, placement, capabilities and connection status with a timeout |
| `axp-session:/ID`  | Lease, grants, usage, checkpoint, compaction, review and verification           |
| `axp-memory://`    | Repository lesson revisions; direct subscription is maintainer-only             |

Standard AHP clients ignore these channels. AXP clients use the exported pure
reducers. Clients send commands; the host checks permissions and consistency before
emitting extension actions.

## Commands

Schemas are in [`schema/`](../schema). The SDK's `call` validates parameters
and infers result types. Mutations require an `operationId`; callers can supply
one for retries across process restarts. Reusing an ID with different input is
a conflict. Read commands need no ID.

| Commands                                                       | Purpose                                                               |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `_axp/register`                                                | Discover and refresh contributor-owned executors                      |
| `_axp/dispatch`                                                | Maintainer commands with retry receipts that survive client restarts  |
| `_axp/comment`                                                 | Scoped, attributed discussion with optional checkpoint/file reference |
| `_axp/grant`, `_axp/revoke`                                    | Contributor budgets and revocation                                    |
| `_axp/claim`, `_axp/renew`, `_axp/release`                     | Atomic ownership and fencing                                          |
| `_axp/reserve`, `_axp/settle`, `_axp/emit`                     | Budgeted, authorized execution                                        |
| `_axp/checkpoint`                                              | Git changeset and checkpoint bundle                                   |
| `_axp/compact`, `_axp/acceptCompaction`                        | Proposed and reviewed context replacement                             |
| `_axp/memoryPropose`, `_axp/memoryReview`, `_axp/memorySearch` | Scoped lessons                                                        |
| `_axp/review`, `_axp/approveReview`, `_axp/verify`             | Artifact signatures and verification                                  |
| `_axp/blobPut`, `_axp/blobGet`                                 | Session-scoped content                                                |
| `_axp/context`, `_axp/export`                                  | Working context or full session history                               |

## Ordering and recovery

`_axp/comment` appends a discussion entry to an exchange and the shared history.
The host assigns the authenticated author and current time. Scoped maintainers,
contributors and verifiers can post; observers cannot. Optional file references
must identify the current checkpoint. Retry receipts prevent duplicate posts.
Existing persisted sessions without a discussion field render an empty thread.
Comments remain independent of AHP user prompts and tool permissions.

`AxpClient.dispatch(channel, action, operationId)` uses `_axp/dispatch` when
an operation ID is supplied. It applies the same action validation, session
access and maintainer permissions as AHP `dispatchAction`, with a saved retry receipt. This path does not attach a client sequence number.
Without the third argument, dispatch keeps the standard AHP client origin and
behavior. The
[AAMP adapter](aamp.md) uses this path for accepting and cancelling mail tasks.

`_axp/close` is maintainer-only. It cancels outstanding work, clears pending
messages, frees the task ID for reuse and archives the session without deleting
its history. Closed sessions cannot be claimed or prompted.

One SQLite transaction serializes state changes, action sequence allocation
and retry receipts. Changes are committed before broadcasting.
If the transaction rolls back, no action is recorded. Reducers do no I/O and read no clocks; timers emit expiry
actions. One open session owns a task. Another open session with the same task
or a second executor claim is rejected.

Leases last 3–300 seconds, with heartbeats every third of that duration. Every
executor mutation checks owner, epoch, expiry and grant. Token output is not
a heartbeat, so quiet compiles can remain live. New claims advance the epoch.
Host restart interrupts work and clears old leases. A disconnected satellite
cancels its agent and reconnects with the same budget grant and local worktree.
If a turn's outcome is unknown, the full reservation is charged and the turn
is not rerun. A new ACP process starts with the shared context when a
maintainer sends the
next prompt. Unuploaded local edits survive on the original machine; only
uploaded checkpoints are recoverable on another machine.

`_axp/claim` accepts `resumeEpoch` for automatic recovery. In one transaction,
the host checks that the epoch has not advanced and any remaining lease belongs
to the same principal, executor and grant, cancels any in-flight work, and issues
the next epoch. If another agent held the lease in between, the claim is rejected even if
that agent has already released it. Retrying an uncertain claim uses its original operation ID;
the returned receipt does not authorize execution under an expired epoch.

The satellite retries transient transport errors with jittered exponential
backoff, capped at 30 seconds by default. Authentication, protocol, ownership,
budget and local agent failures stop it. Reconnecting never resets spending,
raises a limit the contributor has lowered or reverses revocation. `--no-reconnect` disables
automatic retry. A new invocation of `park` is a new budget grant, restoring the
host's latest checkpoint into a new worktree and preserving older local trees.

Upgrade the host and satellites together from 0.1: AXP version negotiation is
exact. The SQLite state format and standard AHP channels are unchanged.

Reconnect returns ordered replay within the replay budget, otherwise fresh
snapshots. Future cursors and another principal's client ID are rejected.
Socket queues have limits; a full queue disconnects the client instead of
silently dropping events. Session history is kept. Operators must provide
storage and choose how to archive it. We have not tested this at scale.

## Spending

Budgets use integer tokens, turns and USD millionths. Cache reads are a subset
of input tokens and are not counted twice. Reserve exactly one turn before
producing output. Settlement is idempotent. If usage is not reported, the full reservation is charged.
If reported usage exceeds the limit, it is recorded and no further turns are
allowed. An opaque ACP
process requires an external provider/proxy cap for a hard spending boundary.
`enforcement: provider` records the contributor's statement that a provider
limit is configured. AXP does not verify that limit.
ACP cache-inclusive and cache-exclusive reports are normalized against their
reported total; inconsistent telemetry falls back to the reservation. Raw
prompt usage stays in the history. `costSource` identifies whether USD was
reported or charged from the reserved ceiling, independently of token source.

## Upstream compatibility

The full upstream reducer corpus is kept byte-for-byte with its MIT license.
AHP 0.9.0's generated `StateAction` schema contains a dangling `#/$defs/`
reference. AXP compiles the concrete discriminated definitions from that
unchanged schema, preserving field validation.

The ACP boundary advertises v1 with file and terminal provider RPCs disabled.
A configured `authMethod` is checked against the adapter's supported methods
and invoked before creating the agent session. Keys stay in the local agent
environment and are never sent to the repository host.
Permission choices keep their original IDs, allow/deny grouping and tool
input. Edited-input approvals are rejected because ACP outcomes cannot carry
edits. Unknown provider updates are saved as content references. ACP v1
steering cancels and continues in a new turn.
