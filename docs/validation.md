# Validation

Protocol tests, process integration tests and live-model runs answer different
questions. This guide records what each checks and what remains untested.

## Reproducible checks

Run on macOS arm64 with Node 24.15.0 and Git:

```sh
npm ci
npm run check
npm run schema
npm run demo
npx playwright install chromium
npm run test:ui
npm run test:ops
npx tsx scripts/benchmark.ts
npm pack
npm run test:package
```

Checks cover strict TypeScript, lint, formatting, a distributable build,
the complete pinned AHP reducer corpus and AXP's pure reducers at 100% branch
and line coverage. Upstream fixtures and the AHP action schema are unchanged, with their MIT
license kept intact.

The tests cover:

- Authenticated WebSockets, an unmodified AHP client, streamed actions,
  gated permissions and replay/snapshot convergence.
- Scoped subscription, blob, export and memory authorization; contributor-only
  budget revocation, charging the full reservation when usage is unknown, and
  stale-epoch rejection.
- SIGKILL during an open SQLite transaction: acknowledged work survives,
  partial writes roll back and retry receipts do not execute twice. A second
  process cannot own the database; a crashed owner releases its OS lock.
- ACP child processes, permission denial, cancellation, steering and
  subsequent permission routing. A four-second tool survives a three-second
  lease through independent heartbeat renewal.
- Missing executables and oversized unterminated ACP frames fail without
  leaving a process behind. An unread socket disconnects on queue overflow.
- A WebSocket proxy drops committed grant/claim replies, severs connections
  and stalls traffic without closing TCP. Recovery preserves one budget grant and
  unuploaded edits, cancels the old ACP process, and does not replay its prompt.
  Host restart resumes the same connected agent. Revocation, exhausted
  allowances and another agent taking over stop automatic recovery. Cancellation also
  interrupts HTTP upgrade and AHP initialization; an unresponsive peer cannot
  hold socket shutdown open indefinitely.
- Git edits and repository tests. Planning-only and changed-code bundles
  restore the exact commit. Dual signatures gate a push to a local bare
  fork. The original checkout and unrelated work are preserved.
- Compaction keeps raw history. Memory requires review and checks
  evidence scope. Incompatible cache identities miss safely.
- A local HTTP server exercises MTPLX headers, isolated session keys, returned
  usage and size-limited lesson extraction.
- AAMP reference SDK requests start tasks in AHP sessions. Loopback SMTP/JMAP
  verifies threaded results, full backlog pagination and expired-cursor
  recovery. Dropped committed dispatch replies and uncertain SMTP delivery
  survive adapter restarts. Tests exercise sender/context authorization,
  cancellation before dispatch, expiry during downtime, route revocation,
  permission help and checkpoint attribution after later session changes.
- Browser interaction exercises contribution creation, scoped controls,
  permission choices, checkpoint diffs, file discussion, reload and reconnect.
  An ACP child process fixes a Git worktree after browser approval; a
  verifier restores/tests its exact commit, a contributor signs through their
  browser and an independent maintainer approves. A manifest changing under
  an open approval dialog is rejected. Accessibility checks run on the overview
  and diff surfaces; desktop and phone-sized layouts are captured and inspected.
- If the WebSocket goes silent, the cached snapshot cannot hide it: the ping
  fails, the UI shows the host as unavailable, and it reloads once the
  connection is back.
- A tarball installs into a fresh directory, loads its packaged schema,
  executes the CLI under symlinked paths and initializes private profiles.

The scripted demo reproduces a failing addition test, connects the sample
ACP agent, obtains maintainer approval, edits the isolated checkout, uploads
a checkpoint, and independently restores and tests it as a verifier. It uses
processes, Git and tests, without a model or provider credits.

## September 6 review regression checks

The [engineering review](review-2026-09-06.md) adds regression coverage for
stable client reconnect sequences, empty-database identity, failed transaction
and startup cleanup, CLI profile precedence, quota deduplication,
and required AHP catalog fields. An ACP agent process confirms that tool output
survives portable context reconstruction and that 100 streamed text chunks do
not cause a snapshot request for every chunk.

Gateway tests check that cached snapshots match host state with no additional subscription
RPCs during a 100-update stream, and retry the same permission and signed
manifest after losing a committed reply and advancing host state. Browser
checks exercise older contributions, missing links, visible agent errors,
reload-safe file drafts and stored HTML previews/downloads that do not execute scripts. AAMP tests
force a half-open RPC timeout and verify a new connection without replaying the
accepted task. A native process test makes the leader exit while its descendant
ignores SIGTERM, then verifies that descendant stops. Linux backup checks
reject a missing configured mail journal without pruning the last good backup.

CPU measurements use a warmup and the median of seven batches, running the
same benchmark against the pre-review tree and revised tree on one machine.
The [raw result](evidence/review-performance.json) records the workload and
machine. This does not measure network latency, provider speed, disk durability
cost or concurrent production capacity. The diff renderer and language assets
remain lazy loaded; a large lazy chunk is still a first-open cost on slow links.

## CI

[CI](https://github.com/maceip/AXP/actions/workflows/ci.yml) runs checks, schema
drift detection, the demo and packaged CLI on Linux, macOS and Windows. A
separate Linux job runs the contribution and cancellation tests inside the
offline Docker launcher. Check the CI run for the specific commit; a workflow file existing does
not mean it passed.

## What remains unverified

The authenticated Codex ACP 1.10.0 adapter completed the live contribution
loop: it fixed the test repository, produced a Git checkpoint, recorded usage,
and passed independent exact-commit verification. Its configured mode used
no interactive tool approval; approval/denial is separately exercised by the
scripted ACP tests. The [live receipt](evidence/live-codex.json) records
the tested commit, verification output digest, normalized usage and saved
history digest without credentials or private conversation data.

The live `@agentclientprotocol/claude-agent-acp` 0.75.1 adapter completed
initialization and session creation, then rejected its first turn with
`Authentication required`. A direct Claude CLI 2.1.259 prompt also returned
`Not logged in` before a provider call. This is **not** a successful live-model
contribution test. Configure an authenticated adapter on the executor; API-key
environment variables must be named with `--agent-env`.

MTPLX/Qwen hardware inference, KV speedups, large-fleet throughput and a hard
provider spending boundary have not been demonstrated. MTPLX tests check
the HTTP contract. AXP accounts and cancels opaque agents; provider/proxy
limits supply hard caps.
