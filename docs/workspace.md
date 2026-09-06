# Contribution workspace

The workspace gives people a place to return to: contributions, live agent
sessions, code changes, discussion and participation that survives a single
pull request. Every displayed contribution comes from the repository host.
There is no separate browser execution or review authority.

## Open your workspace

Build the checkout, start the host with `axp serve`, then run:

```sh
axp ui
```

Open the private link printed by the CLI. The default port is 4318; use
`--port 0` to choose a free port. The local maintainer profile is the default.
Other people run their own gateway with their host-issued profile:

```sh
axp ui --profile .axp/contributor.json
```

The gateway always binds to `127.0.0.1`. It can connect to a remote AXP host
through the normal `wss://` profile. This is a personal browser client for a
shared host, not a publicly hosted signup or identity service. Treat the printed
link as access to that profile. Its fragment becomes a per-tab gateway token;
the browser removes the fragment immediately. The host token remains in Node.
No cookies or model credentials are needed in the browser.

For an explorable demo from the checkout, run `npm run demo:ui`. It creates
explicit deterministic sample sessions in a temporary in-memory host and
prints a private link. The `demo/constellation` project is sample data, not
evidence of real contributors or model-generated work. Ctrl-C closes it.
Normal `axp ui` never seeds sample content.

## Work together

- **Overview** shows contributions, agents with current presence, and the
  people participating through donations, discussion and verification.
- **Contributions** can be searched and filtered. Maintainers can create one,
  start or queue prompts, interrupt with new guidance, cancel a turn and answer
  the agent's offered tool-permission choices.
- **Changes** renders the exact checkpoint patch with Pierre Diffs. Use unified
  or split views and the searchable Pierre file tree. The discussion button
  attaches a comment to that file and checkpoint.
- **Discussion** belongs to the contribution. Contributors, maintainers and
  verifiers can post; observers read. The host assigns authors and timestamps.
  Discussion does not send instructions to the agent or grant tool permissions.
- **People and activity** show participation and current checkpoint/check
  records from the visible contributions. They are not a leaderboard or a
  claim that accounted compute proves useful work.

The agent still parks from its own machine using `axp park`. Native execution,
provider credentials and spending limits stay there. AAMP mail tasks appear in
the same session and are labelled in the transcript. Permission requests from
those tasks are answered here or through the CLI, never by an email approval.

## Submit and review an artifact

Create a signing identity once with `axp keygen --out .axp/signing-key.pem`,
then pass that existing private key to your local gateway:

```sh
axp ui --profile .axp/contributor.json --key .axp/signing-key.pem
```

The current executor owner can inspect Changes and select **Submit for review**,
enter the agent/model description, and sign the checkpoint and trace manifest.
The CLI and browser use the same manifest builder. Finish the reserved turn
before submitting. Keep the signing key; AXP binds public keys to principals.

A maintainer runs their gateway with their own independent `--key`, inspects
Changes, and selects **Approve artifact**. The dialog binds to the checkpoint
and manifest that were opened. A different checkpoint or manifest arriving
while the dialog is open causes rejection; it cannot silently replace the
artifact being approved. Neither browser receives a private signing key.

Independent checks are separate records. Run `axp verify` with a verifier
profile to restore and test the exact Git checkpoint; the workspace displays
the command, verifier, commit and outcome. Approval does not merge or publish
code. `axp publish` remains the explicit Git publication step.

## Design and component decisions

Huabu is the design reference: calm surfaces, a persistent workspace and
focused detail views that keep context near the work. The first surface is a
contribution workspace, with the code and people visible. An infinite canvas
can add context later when actual usage justifies it.

| Component                 | Decision                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Huabu                     | Adapt its semantic design tokens and stateless tab component, retaining MIT notices. Add accessible tab navigation and AXP's palette. Keep its separate agent/server runtime out of the execution path. |
| Pierre Diffs 1.4.1        | Use for patch parsing, syntax highlighting and split/unified rendering. Load it only when Changes opens. Use a contrast-adjusted GitHub theme.                                                          |
| Pierre Trees 1.0.0-beta.6 | Use for keyboard file navigation. Keep the search input outside the tree's ARIA composite and adjust muted text contrast; browser checks cover this integration.                                        |
| CodeMirror 6              | Selected for a future editing surface, when the workspace supports editing a real worktree. It is not installed just to render diffs.                                                                   |
| xterm.js                  | Reserved for a future terminal surface. The first release has no terminal emulator or browser shell.                                                                                                    |
| Git worktrees and merges  | Keep Git and existing AXP artifact operations authoritative. A diff control does not implement Git merge semantics.                                                                                     |

Huabu sources are pinned at
`a3c411e1f655191344285141f08c4738fa6015f7`; adapted files and the full license
are in `ui/src/vendor/huabu`. This is selective reuse, not a vendored copy of
the complete Huabu application. Zana informed the attention/review workflow;
SimpleChat is not a dependency. The build includes license texts for bundled
UI dependencies under `/licenses/bundled.txt`.

## Architecture and current bounds

`WorkspaceServer` is a small local client gateway over `AxpClient`. It exposes
typed read models and a finite command union. Session and role checks stay on
the AXP host. Ordered host actions update cached snapshots through the same pure reducers
used by the host. The cache holds at most 128 subscriptions; browser streams
trigger coalesced refreshes. Catalog refreshes are limited to once per second
and cold pages load four contributions concurrently. Every workspace refresh pings the actual host,
so a responsive local gateway cannot disguise an unreachable repository host.
Reconnection fetches fresh snapshots. Controls pause when the UI loses contact.

The gateway checks the exact Host and Origin, requires its independent bearer
token for every API request, bounds bodies and streams, and serves only packaged
assets. Raw HTML and remote images in Markdown are not rendered. Signing and
protocol code stay outside the browser bundle. There is no telemetry.

Contributions are paged in groups of 40, with Previous/Next controls and title
or session-ID search across the host catalog. Status/person filters and
participation counts describe the current page, as disclosed in the interface.
A selected transcript shows 40 completed turns, patches are limited to 2 MB,
and discussion retains up to 256 comments per session. Open a session directly
with `?session=ID` or use `axp export` for its full audit. Agent presence is not
human online status.

Prompt and discussion drafts, including a file/checkpoint attachment, survive
reload in the same tab when session storage is available. They are never sent
automatically. Pending commands retain their operation ID for retry; accepted
comments/prompts reconcile against shared history. Storage being blocked does
not crash the application, but disables reload persistence. Drafts are local
and are not a cross-device backup.

The gateway freezes permission choices and signed manifests before sending a
mutation. It retains up to 256 prepared command receipts during its lifetime,
so retrying a lost response does not construct a different signature after the
trace advances. Host receipts remain durable. After gateway restart or cache
eviction, inspect the shared outcome before retrying a state-dependent action.

Stored output has an inert, explicitly opened preview of at most 64 KB and an
authenticated full download. HTML is displayed as text, never executed. Tool
results and turn errors remain visible; missing contribution links have a
working return path and do not take down the rest of the workspace.

This release does not add public account provisioning, a social feed outside
repository scope, an interactive Git merge editor, browser worktree writes or
consumer TEE attestation. Tests exercise desktop and phone-sized Chromium
viewports; they do not establish a native mobile application.
