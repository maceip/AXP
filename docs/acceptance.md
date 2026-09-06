# Acceptance criteria

Quality is measured by a usable contribution loop and supported failure paths,
not by the number of tests or SDK languages.

- A fresh clone installs, builds and runs a local demonstration without model
  credentials. Documentation then shows replacing the example with your own
  ACP agent and connecting remotely.
- An unmodified AHP client can initialize, discover a session, subscribe,
  send a turn, see streamed text/tools, approve a request, and replay after
  disconnect. Both maintainer and contributor converge on identical state.
- Outbound WebSockets carry the satellite connection. An ACP child
  process performs initialization, streams updates, asks permission and cancels.
- Concurrent claims have one winner; stale epochs cannot emit, renew, finish,
  settle another executor's budget or approve their own tools. Restart preserves
  receipts and state, and crash recovery never marks an unfinished turn complete.
- Budget revocation, budget exhaustion, long compiles, disconnected approvals,
  replay gaps, malformed traffic and slow subscribers have observable outcomes.
- Agents reconnect after transient network failures or host restart
  with one budget grant and their saved local work. Lost replies cannot duplicate
  spending or model execution. Ownership transfer and revocation stop recovery.
- Git worktrees leave the contributor's checkout intact. A checkpoint bundle
  restores on another checkout, after checking its origin and verifying
  the commit. Publishing requires maintainer approval.
- Compaction changes the working context and preserves the session transcript.
  Compatible caches may help; incompatible caches miss safely. Scoped memory
  deduplicates with evidence and requires approval before shared retrieval.
- Upstream AHP reducer fixtures run against the pinned SDK. AXP reducer branches
  receive the same 100% branch coverage standard. Integration tests exercise
  persistence, sockets, child processes, authorization and Git, with
  clean-install CI across supported operating systems.
- Public documentation accurately distinguishes supported behavior, tested
  interoperability, trust assumptions and optional integrations.
- AAMP tasks pass local sender/session/context checks before acknowledgement.
  Duplicate delivery, uncertain host replies and uncertain SMTP delivery cannot
  start duplicate turns. Expiry, cancellation and route revocation survive
  adapter downtime. Results identify their own checkpoint.
- The browser supports contribution discovery, agent permissions, code review
  and persistent, attributed discussion. Separate contributor and maintainer
  signing identities act on the exact artifact shown; a changed review cannot
  silently replace an open approval. Disconnection is visible and recoverable.
- The workspace is usable with a keyboard and in narrow viewports. Its
  overview and diff integrations pass automated WCAG A/AA checks, backed by
  visual inspection and a real browser-to-ACP-to-Git contribution test.
