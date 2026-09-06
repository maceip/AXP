# Design

## Implementation map

The project is TypeScript on Node.js 24.15+, with a React/Vite browser client
and one SQLite database per repository host. The browser connects through a personal gateway to the repository host.

| Boundary                                        | Owns                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `hub.ts`, `store.ts`                            | Authentication, RPC routing, transactional state, receipts and fanout  |
| `sessions.ts`, `knowledge.ts`, `artifacts.ts`   | Leases/budgets, context/memory, signed Git artifacts                   |
| `channel-state.ts`, `protocol/`                 | Shared pure reduction and extension contracts                          |
| `satellite.ts`, `satellite-runner.ts`, `acp.ts` | Connection recovery, one leased runner, provider process lifecycle     |
| `workspace.ts`, `workspace-commands.ts`         | Personal read cache and browser command translation                    |
| `ui/src/`                                       | Navigation, contribution interaction, transcript, diffs and discussion |
| `aamp.ts`, `aamp/`                              | Mail routing, delivery recovery and transport                          |

These boundaries are worth keeping. Separate components when they have different lifetimes
or permissions; avoid a service framework or separate database for each
feature. The browser and mailbox adapter both use the existing host contracts.

## The contribution experience

A contributor connects an ACP agent to a repository. The maintainer
opens a session and sends a prompt. Either party can watch the same
ordered AHP stream. Maintainers can steer, cancel, and answer permission
requests. Detaching an observer does not end execution. An unattended run is
the same session without an attached human.

The host controls session state and access. Git stores code history. A session claim only prevents accidental duplicate
work; it is not a scheduler, bidding market, or agent conflict-resolution engine.

## Upstream boundary

Use the published AHP 0.9.0 types, reducers and client, without forking.
Inspected upstream: `0d6d98392b06d1e698e20b538e99e8ed1e304935`.
Use ACP SDK 1.4.0, protocol v1, for initialization, sessions, cancellation,
streaming updates and permission requests. Inspected SDK:
`5e2cfcabb5303dc93c093da788b68460b9958526`.

Keep AHP root, session, chat and changeset channels compatible with standard
AHP clients. List optional AXP capabilities during initialization and use
namespaced channels and commands for execution permissions, budgets, Git
checkpoints, context and memory.
Every command has a top-level channel. Unknown optional capabilities are ignored;
unsupported methods return JSON-RPC errors.

AXP does not offer ACP file and terminal provider RPCs. The agent uses its
own local tools in an isolated Git worktree. ACP capabilities are protocol
negotiation, not a security sandbox. Native execution requires contributor
consent; a container launcher can restrict filesystem and network access.
Contributors manage their own toolchains.

## State and recovery

Transport authentication assigns identities and roles; clients cannot grant
themselves privileges in initialize. Claims are atomic and carry increasing
fencing epochs. Every executor mutation checks the current owner and epoch.
Heartbeats are independent of token output so a long compile stays alive.
Disconnects cancel local execution, and expiry makes a session claimable again.
The timer emits an expiry action: reducers never read a clock.

The satellite supervises connections separately from a runner that owns one
lease and ACP process. Before reconnecting, it waits for the old runner's
process, requests and Git operations to finish. It keeps one budget grant
and one local worktree for the lifetime of that `park` process. An atomic resume claim checks
the previous epoch; automatic recovery stops if another contributor held the lease in between.
If a command reply is lost, a saved receipt lets the client recover its result.
Recovery does not resubmit an interrupted prompt or carry over tool approvals.

SQLite transactions commit the action log, current state and retry receipts
together before broadcasting. Database metadata binds even an empty store to
one repository identity; a configuration typo cannot relabel historical work. Reconnect returns replay or snapshots. Slow
consumers are disconnected and resynchronize rather than silently losing events.
Session export preserves the observed transcript; it cannot expose hidden model
reasoning that a provider does not supply.

## Contributor control

Contributors set limits on tokens, turns and cost. Each turn reserves a budget
before work starts, then records its usage once. Input, output, cache reads and
cost are tracked separately. Revoking a budget prevents further work and cancels
the agent. AXP relies on the agent to report usage; enforcing a hard spending
cap requires a quota proxy or provider limit. The host makes this distinction
clear.

## Context and memory

The immutable session history and the model's working context are separate.
Compaction is a versioned, compare-and-swap proposal with a covered turn range,
summary, decisions, active files and Git checkpoint. It cannot silently erase
the session history or discard unresolved approvals. Resumption uses text
context; KV reuse is an optional, measured optimization.

Cache identity includes repository, base commit, exact prompt prefix, model,
tokenizer, template, runtime and cache format. Prefix hashes alone do not make
KV state portable between different runtimes or models. MTPLX integration must
use observed APIs, report cache misses and support starting without a cache.

Repository lessons follow ReasoningBank's approach to learning from successes and failures. Extraction happens
outside the live turn. New lessons are proposals with evidence and scope;
maintainers approve shared repository memory. Duplicate lessons combine their
sources, conflicting lessons require revision, and older revisions remain
available. Private contributor
memory stays local and is never automatically uploaded. Search limits the number of results and checks access to their sources.
Retrieved lessons provide context; they cannot grant permissions.

## Artifacts and trust

Large outputs use SHA-256 content references. Access remains session-scoped even
if physical blobs deduplicate. Agents upload Git checkpoint bundles to the AXP host for review. Publishing
to a Git remote requires maintainer approval. Bundles support recovery without
creating upstream branches.
Signed manifests bind code, prompt and trace digests to contributor and
maintainer signatures. Signatures identify who submitted and approved an artifact. They do not prove
that a test ran. Independent verification records identify the tested commit
and are kept separately from the contributor's reports.

## Performance limits

Lease expiry and open-task lookup use SQLite expression indexes. Action
validation selects the upstream schemas for that action type, keeping all
variants with the same discriminator. Satellites reconcile on control changes,
not on their own streamed text. The workspace applies ordered deltas locally
and limits active subscriptions. None of these changes weaken validation or
replace committed writes with an asynchronous queue.

SQLite is still a synchronous single writer. Each action persists a current
channel JSON snapshot, and session history and receipts grow without automatic
cleanup. Long transcripts, full catalog scans and session exports therefore
remain important capacity limits. UI pagination does not make the underlying
wire catalog or session history paginated. Measure realistic concurrent contributors and
long histories before promising support for a large public deployment. Add paginated
protocol reads and summary tables when measurements show they are needed.
