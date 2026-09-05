# Validation evidence

Validation distinguishes the protocol, a real process exercising it, and a
model performing useful work. None substitutes for the others.

## Reproducible checks

Run on macOS arm64 with Node 24.15.0 and Git:

```sh
npm ci
npm run check
npm run schema
npm run demo
npm pack
npm run test:package
```

Checks cover strict TypeScript, lint, formatting, a distributable build,
the complete pinned AHP reducer corpus and AXP's pure reducers at 100% branch
and line coverage. Upstream fixtures and the AHP action schema retain their
exact source bytes and MIT license.

Behavioral evidence includes:

- Real authenticated WebSockets, an unmodified AHP client, streamed actions,
  gated permissions and replay/snapshot convergence.
- Scoped subscription, blob, export and memory authorization; donor-only
  revocation, conservative settlement and stale-epoch rejection.
- SIGKILL during an open SQLite transaction: acknowledged work survives,
  partial writes roll back and retry receipts do not execute twice. A second
  process cannot own the database; a crashed owner releases its OS lock.
- Actual ACP child processes, permission denial, cancellation, steering and
  subsequent permission routing. A four-second tool survives a three-second
  lease through independent heartbeat renewal.
- Missing executables and oversized unterminated ACP frames fail without
  stranding their process. An unread socket disconnects on queue overflow.
- Real Git edits and repository tests. Planning-only and changed-code bundles
  restore the exact commit. Dual signatures gate a real push to a local bare
  fork. The original checkout and unrelated work are preserved.
- Explicit compaction retains raw history. Memory requires review and checks
  evidence scope. Incompatible cache identities miss safely.
- A local HTTP server exercises MTPLX headers, isolated session keys, returned
  usage and bounded lesson extraction.
- A tarball installs into a fresh directory, loads its packaged schema,
  executes the CLI under symlinked paths and initializes private profiles.

The deterministic demo reproduces a failing addition test, parks the fixture
ACP agent, obtains maintainer approval, edits the isolated checkout, uploads
a checkpoint, and independently restores and tests it as a verifier. It uses
actual processes, Git and tests, without a model or provider credits.

## CI

[CI](https://github.com/maceip/AXP/actions/workflows/ci.yml) runs checks, schema
drift detection, the demo and packaged CLI on Linux, macOS and Windows. A
separate Linux job runs the contribution and cancellation tests inside the
offline Docker launcher. Consult the run for the evaluated commit; workflow
configuration alone is not a passing result.

## Evidence limits

The live `@agentclientprotocol/claude-agent-acp` 0.75.1 adapter completed
initialization and session creation, then rejected its first turn with
`Authentication required`. A direct Claude CLI 2.1.259 prompt also returned
`Not logged in` before a provider call. This is **not** a successful live-model
contribution test. Configure an authenticated adapter on the executor; API-key
environment variables require explicit `--agent-env` names.

MTPLX/Qwen hardware inference, KV speedups, large-fleet throughput and a hard
provider spending boundary have not been demonstrated. MTPLX tests establish
the HTTP contract. AXP accounts and cancels opaque agents; provider/proxy
limits supply hard caps. Consumer TEE attestation is intentionally deferred.
