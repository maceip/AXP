# Contributing to AXP

AXP is TypeScript on Node.js, with a React browser workspace. Start by
[trying the local demo](docs/getting-started.md); you do not need a provider
account, your own host or donated agent time to work on the project.

Documentation, accessibility, interaction design, bug reproduction and protocol
integration are useful contributions. Choose a concrete user problem, open an
issue or propose a focused pull request. Community tasks and recognition are
planned; there is no automated credit system in this release.

## Work locally

Use Node.js 24.15+, npm and Git. After `npm ci`:

| Change                           | Useful development loop                                                   |
| -------------------------------- | ------------------------------------------------------------------------- |
| Browser workspace                | `npm run build` then `npm run demo:ui`; rebuild and reload after UI edits |
| Host, agent or protocol behavior | `npx tsx --test test/NAME.test.ts`                                        |
| SDK or CLI packaging             | `npm run build && npm pack && npm run test:package`                       |
| Linux service tooling            | `npm run test:ops`; the disposable Linux systemd fixture runs in CI       |
| Formatting                       | `npm run format` includes the UI and owned docs                           |

Before proposing a change, run `npm run check` and `npm run demo`. For browser
changes, also run `npx playwright install chromium` and `npm run test:ui`.
Check the actual interaction with a keyboard and at a narrow viewport; an
accessibility scan alone does not prove usability. [Validation details](docs/validation.md)
explain what each check establishes.

## Find the right boundary

| Location                                        | Owns                                                           |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `src/protocol/`                                 | Extension types, schemas and pure reducers                     |
| `src/hub.ts`, `sessions.ts`, `store.ts`         | Transport authority, session transitions and SQLite durability |
| `src/satellite*.ts`, `acp.ts`                   | Contributor connection supervision, turns and agent processes  |
| `src/git.ts`, `artifacts.ts`, `verification.ts` | Checkpoints, signatures and exact-commit checks                |
| `src/aamp/`, `aamp.ts`                          | Mail transport, local admission and durable reconciliation     |
| `src/workspace*.ts`, `ui/src/`                  | Personal gateway, typed browser commands and user experience   |
| `docs/`, `deploy/linux/`, `scripts/`            | Explanation, service setup and release verification            |

Preserve the AHP/ACP boundary: reuse pinned upstream types and reducers;
prefer additive capabilities. Public mutations need a runtime schema, typed
result, authority check and durable transition. Keep I/O out of reducers and
awaits out of database transactions. The browser must not acquire a separate
execution or review authority. [Design rationale](docs/design.md)

Tests should explain an externally meaningful contract or failure mode.
Prioritize real sockets, process lifetime, recovery, spending and authorization
over implementation-shape assertions. Keep the upstream fixture bytes and
license intact. Change SDK pins and conformance evidence together. AXP's pure
reducers retain 100% branch and line coverage; that is a floor, not a measure
of overall product quality.

After command schema changes, run `npm run schema` and commit the generated
files. CI checks drift. Describe public behavior changes in the changelog.
For performance work, report the workload and before/after evidence; do not
turn a local microbenchmark into a fleet-capacity claim.

Never commit credentials, profiles, databases, private transcripts or
contributor histories. Use the private process in [SECURITY.md](SECURITY.md)
for security reports. The official community onboarding change is explicitly
[awaiting owner approval](docs/community-onboarding-proposal.md).
