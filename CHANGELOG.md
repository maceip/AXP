# Changelog

## Unreleased

- Clarify workspace labels, CLI help, errors, email responses and documentation.
- Show readable turn and tool statuses, including failed tool calls.

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

- AAMP mailbox adapter with saved tasks, delivery and retry journals.
- Personal browser workspace for contributions, discussion, streamed sessions,
  Git diffs and independent signed artifact review.
- Namespaced dispatch commands with saved receipts and attributed discussion.
- Linux service wrappers, health checks and automatic restart and verified SQLite backups.

## 0.2.0

- Automatic agent reconnection with limited backoff, one budget grant and a
  saved local worktree. Interrupted prompts and permissions are not replayed.
- Reconnecting agents recover from lost replies and stop if another agent took
  over in between. Revocation and exhausted allowances stop recovery.
- Separate connection supervision and lease execution, with heartbeat deadlines,
  complete process cleanup and cancellation during connection setup.
- `--no-reconnect`, observable satellite connection states and clean CLI signal
  handling during startup, retries and normal exit.
- Real socket fault tests cover lost acknowledgements, half-open connections,
  host restart, ownership transfer, revocation and spending carrying over correctly.
- Upgrade host and satellite together: AXP negotiation is now 0.2.0. AHP 0.9.0,
  ACP v1 and the SQLite state format are unchanged.

## 0.1.0

- AHP 0.9.0 host and Node client with persistent state, replay and scoped access.
- ACP v1 satellites with streaming, maintainer permissions, steering, local
  worktrees and saved history.
- Executor discovery, fenced claims, heartbeats and contributor budgets.
- Content-addressed artifacts, Git bundle recovery, signed review and separate
  exact-commit verification.
- Context compaction, reviewed repository memory, cache compatibility and an
  MTPLX HTTP/distillation adapter.
- Upstream AHP conformance fixtures and behavioral integration tests.
- Local ACP authentication, provider-usage normalization and live
  a recorded Codex ACP contribution run.
