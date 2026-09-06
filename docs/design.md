# Design

## The contribution experience

A contributor parks an ACP-speaking agent at a repository. The maintainer
opens a durable session and sends a prompt. Either party can watch the same
ordered AHP stream. Maintainers can steer, cancel, and answer permission
requests. Detaching an observer does not end execution. An unattended run is
the same session without an attached human.

The host is authoritative for session state and access control. Git is
authoritative for code. A session claim only prevents accidental duplicate
work; it is not a scheduler, bidding market, or agent conflict-resolution engine.

## Upstream boundary

Use the published AHP 0.9.0 types, reducers and client, without forking.
Inspected upstream: `0d6d98392b06d1e698e20b538e99e8ed1e304935`.
Use ACP SDK 1.4.0, protocol v1, for initialization, sessions, cancellation,
streaming updates and permission requests. Inspected SDK:
`5e2cfcabb5303dc93c093da788b68460b9958526`.

Keep ordinary AHP root, session, chat and changeset channels displayable by
ordinary AHP clients. Add namespaced, capability-advertised AXP channels and
commands for execution authority, budgets, Git checkpoints, context and memory.
Every command has a top-level channel. Unknown optional capabilities are ignored;
unsupported methods return explicit JSON-RPC errors.

ACP file and terminal provider RPCs are not advertised. The agent uses its
own local tools in an isolated Git worktree. ACP capabilities are protocol
negotiation, not a security sandbox. Native execution requires contributor
consent; a container launcher can supply an actual process boundary. Toolchains
are contributor-managed, as requested in the transcript.

## Durable authority

Transport authentication assigns identities and roles; clients cannot grant
themselves privileges in initialize. Claims are atomic and carry increasing
fencing epochs. Every executor mutation checks the current owner and epoch.
Heartbeats are independent of token output so a long compile stays alive.
Disconnects cancel local execution, and expiry makes a session claimable again.
The timer emits an explicit state transition: reducers never read a clock.

The satellite supervises connections separately from a runner that owns one
lease and ACP process. Before reconnecting, it waits for the old runner's
process, requests and Git operations to finish. It keeps one donation identity
and one local worktree for that parking lifetime. An atomic resume claim checks
the previous epoch; another contributor's intervening claim ends automatic
recovery. Lost mutation responses are reconciled through durable receipts.
Recovery does not resubmit an interrupted prompt or carry over tool approvals.

SQLite transactions commit the action log, current state and retry receipts
together before broadcasting. Reconnect returns replay or snapshots. Slow
consumers are disconnected and resynchronize rather than silently losing events.
Session export preserves the observed transcript; it cannot expose hidden model
reasoning that a provider does not supply.

## Contributor control

Donations have explicit limits. Reserve before work and settle once, accounting
for input, output, cache reads and cost independently. Revocation fences future
work and cancels the agent. An opaque ACP process cannot provide a universal
hard provider spending cap; strict monetary enforcement requires an external
quota proxy/provider limit. The host must disclose that distinction.

## Context and memory

The immutable audit history and the model's working context are separate.
Compaction is a versioned, compare-and-swap proposal with a covered turn range,
summary, decisions, active files and Git checkpoint. It cannot silently erase
the audit log or discard unresolved approvals. Resumption uses portable text
context; KV reuse is an optional, measured optimization.

Cache identity includes repository, base commit, exact prompt prefix, model,
tokenizer, template, runtime and cache format. Prefix hashes alone do not make
KV state portable between different runtimes or models. MTPLX integration must
use observed APIs, report misses and retain a cold-start fallback.

ReasoningBank informs structured success/failure lessons. Extraction happens
outside the live turn. New lessons are proposals with evidence and scope;
maintainers approve repo-shared memory. Exact duplicates consolidate, conflicting
lessons require revision, stale revisions remain inspectable. Private contributor
memory stays local and is never automatically uploaded. Retrieval is bounded,
scope-checked and treated as contextual evidence rather than policy authority.

## Artifacts and trust

Large outputs use SHA-256 content references. Access remains session-scoped even
if physical blobs deduplicate. Git checkpoints stay local until explicit review
approval; portable bundles enable recovery without polluting upstream refs.
Signed manifests bind code, prompt and trace digests to contributor and
maintainer signatures. Signatures establish who attested, not whether a test
ran. Independent verification records name the exact tested commit and remain
distinct from contributor claims. Consumer TEE is deferred.
