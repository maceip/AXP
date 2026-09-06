# CLI reference

Build the checkout and run `npm link` to install the `axp` command locally.
`axp --help` lists commands; `axp --version` prints the package version.
The [first-look demo](getting-started.md) does not require global CLI installation.

## Choose the connection

An explicit `--profile FILE` wins over environment variables. Otherwise,
`AXP_URL` and `AXP_TOKEN` must either both be present or both be absent.
A partial pair is an error. With neither, AXP reads the command's default profile:

| Commands                 | Default profile         |
| ------------------------ | ----------------------- |
| `park`, `submit`         | `.axp/contributor.json` |
| `verify`                 | `.axp/verifier.json`    |
| Other connected commands | `.axp/maintainer.json`  |

`--directory PATH` selects the Git checkout and the location of default `.axp`
profiles/configuration. Explicit file paths such as `--profile`, `--config`,
`--key` and `--out` are relative to your shell's current directory. Environment
credentials apply to the host connection only; they never enter agent processes.
Remote hosts require `wss://`.

## Everyday commands

```sh
axp sessions
axp ui
axp inspect SESSION
axp watch SESSION
axp export SESSION --out history.json
```

`ui` prints a private browser link and keeps running; `--port 0` chooses a free
port. `watch` prints an initial snapshot and live actions. It exits with an
explanation when the host disconnects; run it again to synchronize. `park`
has its own automatic reconnection lifecycle and preserves the current donation.

Maintainers create and guide sessions:

```sh
axp create --id parser-fix --task issue-42 --title "Fix the parser"
axp prompt parser-fix "Reproduce the issue and preserve the public API."
axp queue parser-fix "Document the fix after this turn."
axp steer parser-fix "Keep the change in the parser."
axp approve parser-fix --tool TOOL_ID --option OPTION_ID
axp cancel parser-fix
axp close parser-fix
```

`steer` cancels and continues in a new turn. `queue` waits. `cancel` stops the
active turn. `close` archives the session and releases its task identity while
retaining history. Permission IDs come from `inspect` or `watch`.

[Agent setup](agent-setup.md) explains `park`, isolation and spending limits.
[Artifact review](artifacts.md) explains `keygen`, `submit`, `accept`, `verify`
and explicit publication to a configured fork. [AAMP](aamp.md) documents the
optional mailbox command. `rpc METHOD --params FILE` exposes typed AXP commands
for integrations and operators; ordinary browser use does not need it.

## Create a local host

`axp init --repo OWNER/PROJECT` creates private configuration and separate local
role profiles. It requires Git, refuses existing files and does not rotate
credentials. If profile creation fails, newly created profiles are removed and
existing files are preserved. The host configuration is published last.

Use a fixed port for initialization; `--port 0` would leave unusable saved
profiles and is rejected. `axp serve` owns one SQLite database. That database
is permanently associated with its repository identity. Changing the configured
name requires a deliberate migration or a new database, not a restart with a
new label.

The bundled role profiles are for trying the workflow. Give each real person
an independent, scoped identity as described in [Hosting](hosting.md).
