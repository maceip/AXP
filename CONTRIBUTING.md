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
| Formatting                       | `npm run format` includes the UI and project documentation                |

Before proposing a change, run `npm run check` and `npm run demo`. For browser
changes, also run `npx playwright install chromium` and `npm run test:ui`.
Check the interaction with a keyboard and at a narrow viewport; an
accessibility scan alone does not prove usability. [Validation details](docs/validation.md)
explain what each check covers.

## Find the right boundary

| Location                                        | Owns                                                         |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `src/protocol/`                                 | Extension types, schemas and pure reducers                   |
| `src/hub.ts`, `sessions.ts`, `store.ts`         | Authentication, session transitions and SQLite storage       |
| `src/satellite*.ts`, `acp.ts`                   | Agent connections, turns and process cleanup                 |
| `src/git.ts`, `artifacts.ts`, `verification.ts` | Checkpoints, signatures and commit verification              |
| `src/aamp/`, `aamp.ts`                          | Mail transport, task routing and delivery recovery           |
| `src/workspace*.ts`, `ui/src/`                  | Personal gateway, typed browser commands and user experience |
| `docs/`, `deploy/linux/`, `scripts/`            | Explanation, service setup and release verification          |

Preserve the AHP/ACP boundary: reuse pinned upstream types and reducers;
add optional capabilities without changing how other AHP clients display
sessions. Commands that change shared state need a runtime schema, typed result,
permission check and transaction that saves the change. Keep I/O out of reducers
and awaits out of database transactions. The host must check permissions for
browser requests just as it does for every other client. [Design rationale](docs/design.md)

Each test should cover a behavior users can observe or a way things can fail.
Prioritize sockets, process cleanup, recovery, spending and authorization over
tests that only check internal structure. Upstream fixtures prove conformance;
do not modify them, and keep their license. When updating an SDK version, verify
compatibility with its fixtures. Maintain 100% branch and line coverage for AXP's
pure reducers, while judging overall quality by how well the product works.

After command schema changes, run `npm run schema` and commit the generated
files. CI checks drift. Describe public behavior changes in the changelog.
For performance work, report the workload and before/after measurements. A local microbenchmark
does not measure how many concurrent contributors a deployment can support.

Never commit credentials, profiles, databases, private transcripts or
contributor histories. Use the private process in [SECURITY.md](SECURITY.md)
for security reports. The official community onboarding change is
[awaiting owner approval](docs/community-onboarding-proposal.md).
