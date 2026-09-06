# Acceptance criteria

Quality is measured by a usable contribution loop and supported failure paths,
not by the number of tests or SDK languages.

- A fresh clone installs, builds and runs a local demonstration without model
  credentials. Documentation then shows replacing the example with an actual
  ACP agent and connecting remotely.
- An unmodified AHP client can initialize, discover a session, subscribe,
  send a turn, see streamed text/tools, approve a request, and replay after
  disconnect. Both maintainer and contributor converge on identical state.
- Real outbound WebSockets carry the satellite connection. A real ACP child
  process performs initialization, streams updates, asks permission and cancels.
- Concurrent claims have one winner; stale epochs cannot emit, renew, finish,
  settle another executor's budget or approve their own tools. Restart preserves
  receipts and state, and crash recovery does not invent completed turns.
- Donor revocation, budget exhaustion, long compiles, disconnected approvals,
  replay gaps, malformed traffic and slow subscribers have observable outcomes.
- Parked contributors reconnect after transient network failures or host restart
  with one donation and their retained local work. Lost replies cannot duplicate
  spending or model execution. Ownership transfer and revocation stop recovery.
- Git worktrees leave the contributor's checkout intact. A checkpoint bundle
  restores on another checkout, with validated provenance and exact-commit
  verification. Publication requires explicit maintainer review authorization.
- Compaction changes the working context and preserves the audit transcript.
  Compatible caches may help; incompatible caches miss safely. Scoped memory
  deduplicates with evidence and requires approval before shared retrieval.
- Upstream AHP reducer fixtures run against the pinned SDK. AXP reducer branches
  receive the same 100% branch coverage standard. Integration tests exercise
  persistence, actual sockets, child processes, authorization and Git, with
  clean-install CI across supported operating systems.
- Public documentation accurately distinguishes supported behavior, tested
  interoperability, trust assumptions and optional integrations.
