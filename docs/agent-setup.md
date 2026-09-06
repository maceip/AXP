# Connect an agent to a host

This is the operator/contributor setup path for an existing host. To explore AXP first, use the [local workspace demo](getting-started.md). Public AXP account provisioning is not available yet.

Install the CLI from the built checkout:

```sh
npm link
cd /path/to/your/project
axp init --repo your-org/your-project
axp serve
```

In another terminal, create a session:

```sh
axp create --id parser-fix --task issue-42 --title "Fix the parser"
```

Park an ACP agent with the contributor profile. For example, install the
[Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp) and supply
your local API-key environment variable:

```sh
npm install -g @agentclientprotocol/codex-acp@1.10.0
axp park parser-fix --profile .axp/contributor.json \
  --native --tokens 100000 --cost-micros 1000000 --turns 10 \
  --turn-tokens 10000 --turn-cost-micros 100000 \
  --agent-env OPENAI_API_KEY --auth-method api-key -- codex-acp
```

The `--` separates AXP options from the agent command. Any compatible ACP v1
agent can replace `codex-acp`; plain interactive CLIs need an ACP adapter.
For an already-authenticated adapter, omit the authentication and environment
options. The [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
can be selected with `-- claude-agent-acp` after its normal local authentication.
`--native` explicitly permits the agent's tools to run as your user. For an
offline container image with its dependencies already installed, use
`--image IMAGE` instead. Git worktrees isolate edits; they are not a sandbox.

Provider variables are explicit: add `--agent-env ANTHROPIC_API_KEY` (or your
adapter's environment-variable names, comma-separated) before `--` to pass
them from your local shell. Values never pass through the hub. Existing
provider login files remain available in native mode.
`--auth-method` invokes the adapter's advertised login method and uses its
configured local credential store, just as its normal login does.

Maintainer commands use `.axp/maintainer.json` by default:

```sh
axp executors
axp prompt parser-fix "Reproduce issue 42 and fix it without changing the API."
axp watch parser-fix
axp inspect parser-fix
axp approve parser-fix --tool TOOL_ID --option OPTION_ID
axp steer parser-fix "Keep the change in the parser."
axp export parser-fix --out parser-fix.json
```

Tool and option IDs are shown in `watch` and `inspect`. ACP v1 steering cancels
the current prompt and continues in a new turn; both remain in the audit
history. `queue` waits for the current turn. `cancel` stops it. Ctrl-C undocks
the executor, retaining its worktree and history under `.axp/`.
`close` archives a completed session and releases its task identity.

Keep `park` running through network interruptions: it reconnects automatically
with the same donation and worktree. The interrupted turn stays in the audit;
send a new prompt to continue after the executor reports `Parked` again.
Recovery stops if the donation is revoked, its allowance is exhausted or another
executor takes ownership. `--no-reconnect` opts out. Starting a new `park` process
creates a new donation and restores the latest uploaded checkpoint into a new
worktree; older local work is retained for inspection.

The host stores state in `.axp/hub.db`. Local profiles contain secrets and must
stay out of Git. `init` provides separate roles for trying the workflow; give
each real contributor a unique principal and token in the host configuration.
See [hosting and access](hosting.md) for remote TLS and scoped identities.
