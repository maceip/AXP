# Contribution workspace

The workspace brings together contributions, live agent sessions, code
changes, discussion and participation history. Every displayed contribution
comes from the repository host. The browser sends commands to the host, which
checks execution and review permissions.

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
shared host, not a publicly hosted signup or identity service. Anyone with the printed
link can act as that profile, so treat it like a password. Its fragment becomes a per-tab gateway token;
the browser removes the fragment immediately. The host token remains in Node.
No cookies or model credentials are needed in the browser.

To explore a demo from the checkout, run `npm run demo:ui`. It creates sample
sessions in a temporary in-memory host and prints a private link. The people
and work in `demo/constellation` are examples. Ctrl-C closes it.
Normal `axp ui` never seeds sample content.

## Work together

- **Overview** shows contributions, agents that are currently connected, and the
  people participating through agent time, discussion and verification.
- **Contributions** can be searched and filtered. Maintainers can create one,
  start or queue prompts, interrupt with new guidance, cancel a turn and answer
  the agent's permission requests.
- **Changes** shows the checkpoint patch with Pierre Diffs. Use unified
  or split views and the searchable Pierre file tree. The discussion button
  attaches a comment to that file and checkpoint.
- **Discussion** is saved with the contribution. Contributors, maintainers and
  verifiers can post; observers read. The host assigns authors and timestamps.
  Discussion does not send instructions to the agent or grant tool permissions.
- **People and activity** show participation and current checkpoint/check
  records from the visible contributions. These counts describe activity, not how useful the work was.

The agent connects from its own machine using `axp park`. Native execution,
provider credentials and spending limits stay there. AAMP mail tasks appear in
the same session and are labelled in the transcript. Permission requests from
those tasks are answered here or through the CLI, never by replying to an email.

## Submit and review an artifact

Create a signing identity once with `axp keygen --out .axp/signing-key.pem`,
then pass that existing private key to your local gateway:

```sh
axp ui --profile .axp/contributor.json --key .axp/signing-key.pem
```

The contributor running the connected agent can inspect Changes and select **Submit for review**,
enter the agent/model description, and sign the checkpoint and trace manifest.
The CLI and browser use the same manifest builder. Wait for the current turn to finish
before submitting. Keep the signing key; AXP binds public keys to principals.

A maintainer runs their gateway with their own `--key`, inspects
Changes, and selects **Approve artifact**. The dialog binds to the checkpoint
and manifest that were opened. If the checkpoint or manifest changes
while the dialog is open, approval is rejected. Reopen Changes to review the
new version. Neither browser receives a private signing key.

Verification results are recorded separately from approvals. Run `axp verify` with a verifier
profile to restore and test the Git checkpoint; the workspace displays
the command, verifier, commit and outcome. Approval does not merge or publish
code. Pushing to Git is a separate step: `axp publish`.

## Design and component decisions

Huabu is the design reference: calm surfaces, a persistent workspace and
focused detail views that keep context near the work. The first surface is a
contribution workspace, with the code and people visible. An infinite canvas
can add context later if people need it.

| Component                 | Decision                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Huabu                     | Adapt its semantic design tokens and stateless tab component, keeping MIT notices. Add accessible tab navigation and AXP's palette. Keep its separate agent/server runtime out of the execution path. |
| Pierre Diffs 1.4.1        | Use for patch parsing, syntax highlighting and split/unified rendering. Load it only when Changes opens. Use a contrast-adjusted GitHub theme.                                                        |
| Pierre Trees 1.0.0-beta.6 | Use for keyboard file navigation. Keep the search input outside the tree's ARIA composite and adjust muted text contrast; browser checks cover this integration.                                      |
| CodeMirror 6              | Selected for a future editing surface, when the workspace supports editing a worktree. It is not installed just to render diffs.                                                                      |
| xterm.js                  | Reserved for a future terminal surface. The first release has no terminal emulator or browser shell.                                                                                                  |
| Git worktrees and merges  | Use Git and existing AXP artifact operations. A diff control does not implement Git merge semantics.                                                                                                  |

Huabu sources are pinned at
`a3c411e1f655191344285141f08c4738fa6015f7`; adapted files and the full license
are in `ui/src/vendor/huabu`. This is selective reuse, not a vendored copy of
the complete Huabu application. The attention and review flow borrows ideas from Zana;
SimpleChat is not a dependency. The build includes license texts for bundled
UI dependencies under `/licenses/bundled.txt`.

## Architecture and limits

`WorkspaceServer` is a small local client gateway over `AxpClient`. It exposes
a small set of typed read endpoints and commands. Session and role checks stay on
the AXP host. Ordered host actions update cached snapshots through the same pure reducers
used by the host. The cache holds at most 128 subscriptions; browser streams
trigger coalesced refreshes. Catalog refreshes are limited to once per second
and cold pages load four contributions concurrently. Every workspace refresh pings the host,
so the UI cannot look connected while the repository host is unreachable.
Reconnection fetches fresh snapshots. Controls pause when the UI loses contact.

The gateway checks the exact Host and Origin, requires its own bearer
token for every API request, limits request sizes and open streams, and serves only packaged
assets. Raw HTML and remote images in Markdown are not rendered. Signing and
protocol code stay outside the browser bundle. There is no telemetry.

Contributions are paged in groups of 40, with Previous/Next controls and title
or session-ID search across the host catalog. Status/person filters and
participation counts describe the current page, as explained in the interface.
A selected transcript shows 40 completed turns, patches are limited to 2 MB,
and discussion keeps up to 256 comments per session. Open a session directly
with `?session=ID` or use `axp export` for its full history. An agent being connected does not
mean its owner is online.

Prompt and discussion drafts, including a file/checkpoint attachment, survive
reload in the same tab when session storage is available. They are never sent
automatically. Pending commands keep their operation ID for retry; accepted
comments/prompts reconcile against shared history. If the browser blocks storage, drafts still work but are lost on reload. Drafts are local
and are not a cross-device backup.

The gateway freezes permission choices and signed manifests before sending a
mutation. It keeps up to 256 prepared command receipts during its lifetime,
so retrying a lost response does not construct a different signature after the
trace advances. The host saves receipts in SQLite. After gateway restart or cache
eviction, inspect the shared outcome before retrying a state-dependent action.

You can open a preview of stored output, limited to 64 KB, or download the
full output after authentication. HTML is displayed as text, never executed. Tool
results and turn errors remain visible; missing contribution links have a
working return path and do not take down the rest of the workspace.

Not in this release: public signup, a social feed outside the repository,
an interactive Git merge editor or browser file editing. Tests cover desktop
and phone-sized Chromium viewports. There is no native mobile app.
