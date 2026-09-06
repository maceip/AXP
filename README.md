# AXP · Agent Exchange Protocol

[![CI](https://github.com/maceip/AXP/actions/workflows/ci.yml/badge.svg)](https://github.com/maceip/AXP/actions/workflows/ci.yml)

**Park your agent at a repository. Let its maintainers steer the work. Keep the shared history.**

AXP connects contributor-owned agents to an authoritative repository host.
Maintainers send prompts, watch streamed output, answer tool permissions and
steer running sessions. Contributors supply their own agent and compute, set
an allowance, and retain the same session history. The agent can run on a
laptop or on project infrastructure. An unattended run is an ordinary session
that people can attach to when needed.

AXP uses the published [AHP SDK](https://github.com/microsoft/agent-host-protocol)
for shared presentation state and the official
[ACP SDK](https://github.com/agentclientprotocol/typescript-sdk) to drive agent
processes. It adds executor ownership, leases, budget accounting, Git
checkpoints, context compaction and reviewed repository memory through
negotiated extension channels. It does not fork either project.

## Try the contribution loop

Requires Node **24.15+**, npm and Git. No model credentials are needed for the demo.

```sh
git clone https://github.com/maceip/AXP.git
cd AXP
npm ci
npm run build
npm run demo
```

The demo reproduces a failing test, parks an actual ACP child process over a
WebSocket, approves its tool, fixes code in an isolated worktree, and restores
its Git bundle for independent verification. The contributor's original
checkout stays intact. This deterministic fixture exercises real processes,
Git and tests; it is explicitly not an LLM demonstration.

## Use your own agent

Install the CLI from the built checkout:

```sh
npm link
cd /path/to/your/project
axp init --repo your-org/your-project
axp serve
```

In another terminal, create a session:

```sh
axp create --id parser-fix --task issue-42 --title "Fix the parser"
```

Park an ACP agent with the contributor profile. For example, install the
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) and supply
your local API-key environment variable:

```sh
npm install -g @agentclientprotocol/codex-acp@1.10.0
axp park parser-fix --profile .axp/contributor.json \
  --native --tokens 100000 --cost-micros 1000000 --turns 10 \
  --turn-tokens 10000 --turn-cost-micros 100000 \
  --agent-env OPENAI_API_KEY --auth-method api-key -- codex-acp
```

The `--` separates AXP options from the agent command. Any compatible ACP v1
agent can replace `codex-acp`; plain interactive CLIs need an ACP adapter.
For an already-authenticated adapter, omit the authentication and environment
options. The [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
can be selected with `-- claude-agent-acp` after its normal local authentication.
`--native` explicitly permits the agent's tools to run as your user. For an
offline container image with its dependencies already installed, use
`--image IMAGE` instead. Git worktrees isolate edits; they are not a sandbox.

Provider variables are explicit: add `--agent-env ANTHROPIC_API_KEY` (or your
adapter's environment-variable names, comma-separated) before `--` to pass
them from your local shell. Values never pass through the hub. Existing
provider login files remain available in native mode.
`--auth-method` invokes the adapter's advertised login method and uses its
configured local credential store, just as its normal login does.

Maintainer commands use `.axp/maintainer.json` by default:

```sh
axp executors
axp prompt parser-fix "Reproduce issue 42 and fix it without changing the API."
axp watch parser-fix
axp inspect parser-fix
axp approve parser-fix --tool TOOL_ID --option OPTION_ID
axp steer parser-fix "Keep the change in the parser."
axp export parser-fix --out parser-fix.json
```

Tool and option IDs are shown in `watch` and `inspect`. ACP v1 steering cancels
the current prompt and continues in a new turn; both remain in the audit
history. `queue` waits for the current turn. `cancel` stops it. Ctrl-C undocks
the executor, retaining its worktree and history under `.axp/`.
`close` archives a completed session and releases its task identity.

Keep `park` running through network interruptions: it reconnects automatically
with the same donation and worktree. The interrupted turn stays in the audit;
send a new prompt to continue after the executor reports `Parked` again.
Recovery stops if the donation is revoked, its allowance is exhausted or another
executor takes ownership. `--no-reconnect` opts out. Starting a new `park` process
creates a new donation and restores the latest uploaded checkpoint into a new
worktree; older local work is retained for inspection.

The host stores state in `.axp/hub.db`. Local profiles contain secrets and must
stay out of Git. `init` provides separate roles for trying the workflow; give
each real contributor a unique principal and token in the host configuration.
See [hosting and access](docs/hosting.md) for remote TLS and scoped identities.

## What the implementation provides

| Area                | Behavior                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Collaboration       | AHP root/session/chat/changeset state, streaming, confirmations, steering, queued turns and session export                       |
| Participation       | Outbound connections, executor discovery, atomic claims, renewable leases and increasing fencing epochs                          |
| Recovery            | SQLite transactions before broadcast, durable retry receipts, replay/snapshot fallback and interrupted-turn recovery             |
| AAMP mail           | Locally authorized text tasks, durable JMAP ingestion, threaded SMTP acknowledgements, permissions, cancellation and results     |
| Contributor control | Per-donor token, turn and USD-micro-unit allowances; pre-turn reservations, revocation and conservative unknown-usage accounting |
| Artifacts           | Session-scoped SHA-256 blobs, local Git checkpoints, portable bundles, dual-signed manifests and separate verifier records       |
| Context             | Revision-checked compaction that preserves the full transcript; portable text resumption and explicit cache compatibility        |
| Memory              | Evidence-backed success/failure lessons, deduplication, maintainer review, bounded retrieval and retirement                      |
| Local models        | MTPLX HTTP adapter with isolated session keys, clone restore, actual cache-usage reporting and bounded distillation              |

An opaque ACP agent controls its own provider calls. AXP can stop future turns
and cancel a running process, but **a hard provider spending cap requires a
provider limit or quota proxy**. Unknown usage consumes the reserved allowance.
Consumer TEE attestation is deferred. Independent tests and review establish
artifact confidence; contributor traces and signatures do not prove execution.

## Build on AXP

The package has four entry points: `@maceip/axp/protocol` for types, schemas and
pure reducers; `@maceip/axp/client` for the Node client; `@maceip/axp/aamp` for
the mailbox adapter; and `@maceip/axp` for the host, satellite, Git and model
integration APIs. Install from a built tarball
with `npm pack`; npm registry publication is not required to use the checkout.

- [Protocol and interoperability](docs/protocol.md)
- [AAMP mailbox setup and supported profile](docs/aamp.md)
- [Context, memory and MTPLX](docs/memory.md)
- [Hosting and access](docs/hosting.md)
- [Artifact review and verification](docs/artifacts.md)
- [Design decisions](docs/design.md) · [Acceptance criteria](docs/acceptance.md)
- [Validation evidence](docs/validation.md) · [Contributing](CONTRIBUTING.md)

`npm run check` runs strict TypeScript checks, lint, formatting, builds, the
upstream AHP reducer fixtures and behavioral integration tests. AXP reducers
must maintain 100% branch and line coverage. CI also runs the complete demo
and a packaged CLI smoke test.

MIT licensed. AXP is an independent project.
