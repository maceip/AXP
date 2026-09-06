# Changelog

## 0.2.0

- Automatic satellite reconnection with bounded backoff, one donation and a
  retained local worktree. Interrupted prompts and permissions are not replayed.
- Atomic resume claims reconcile lost responses and reject intervening ownership
  changes. Revocation and exhausted allowances stop recovery.
- Separate connection supervision and lease execution, with heartbeat deadlines,
  complete process cleanup and cancellation during connection setup.
- `--no-reconnect`, observable satellite connection states and clean CLI signal
  handling during startup, retries and natural termination.
- Real socket fault tests cover lost acknowledgements, half-open connections,
  host restart, ownership transfer, revocation and spending continuity.
- Upgrade host and satellite together: AXP negotiation is now 0.2.0. AHP 0.9.0,
  ACP v1 and the SQLite state format are unchanged.

## 0.1.0

- AHP 0.9.0 host and Node client with durable state, replay and scoped access.
- ACP v1 satellites with streaming, maintainer permissions, steering, local
  worktrees and retained history.
- Executor discovery, fenced claims, heartbeats and donor allowances.
- Content-addressed artifacts, Git bundle recovery, signed review and separate
  exact-commit verification.
- Context compaction, reviewed repository memory, cache compatibility and an
  MTPLX HTTP/distillation adapter.
- Upstream AHP conformance fixtures and behavioral integration tests.
- Explicit local ACP authentication, provider-usage normalization and live
  Codex ACP contribution evidence.
