# Changelog

## 0.3.1

- Fix uncertain browser permission/signature retries, reload-safe discussion
  drafts, missing contribution links, tool results and stored output access.
- Add contribution pagination and project-wide title/session search; preserve
  workspace navigation on reload and browser history.
- Apply streamed state locally in the gateway, reconcile satellites only on
  control changes, index lease/task lookup and dispatch action validators by type.
- Bind database identity, continue sequential client dispatch IDs, preserve
  physical blob deduplication at quota, and release failed startup resources.
- Reconnect stalled AAMP clients; terminate native process descendants after
  their leader exits; reject incomplete configured-mail backups.
- Correct CLI profile precedence/defaults, directory resolution and failed-init
  cleanup. Add an installed version command.
- Rewrite entry documentation around a local first experience, with dedicated
  architecture, SDK, CLI and operator guides. Community onboarding is proposed
  separately and remains unimplemented.
- Preserve AHP 0.9.0 fixtures and AXP wire negotiation 0.2.0. Existing databases
  adopt repository metadata after validating their stored session identities.

## 0.3.0

- AAMP mailbox adapter with durable admission, delivery and retry journals.
- Personal browser workspace for contributions, discussion, streamed sessions,
  Git diffs and independent signed artifact review.
- Namespaced durable dispatch and attributed discussion commands.
- Linux service wrappers, health supervision and verified SQLite backups.

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
