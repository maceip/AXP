# Connect an agent to a host

Use this guide to set up a host and connect an agent. To explore AXP first, use the [local workspace demo](getting-started.md). Public AXP signup is not available yet.

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

Connect an ACP agent with the contributor profile using `axp park`. For example, install the
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
If the adapter is already logged in, you can skip the auth and environment
options. The [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp)
works with `-- claude-agent-acp` once you have logged in to it locally.
`--native` allows the agent's tools to run as your user. For an
offline container image with its dependencies already installed, use
`--image IMAGE` instead. Git worktrees isolate edits; they are not a sandbox.

To pass API keys or other environment variables to the agent, add
`--agent-env ANTHROPIC_API_KEY` before `--`. For other variables, use a
comma-separated list of names from your local shell. Values never pass through the hub. Existing
provider login files remain available in native mode.
`--auth-method` runs one of the adapter's supported login methods and uses its
local credential store, the same as logging in directly.

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
the current prompt and continues in a new turn; both stay in the session
history. `queue` waits for the current turn. `cancel` stops it. Ctrl-C disconnects
the agent; its worktree and history stay under `.axp/`.
`close` archives a finished session and frees its task ID for reuse.

Keep `park` running through network interruptions: it reconnects automatically
with the same budget grant and worktree. The interrupted turn stays in the
session history; send a new prompt after the agent reports `Connected` again.
Recovery stops if the budget is revoked or exhausted, or another agent takes
over the session. `--no-reconnect` opts out. Starting a new `park` process
creates a new budget grant and restores the latest uploaded checkpoint into a new
worktree. The older worktree is kept so you can inspect it.

The host stores state in `.axp/hub.db`. Local profiles contain secrets and must
stay out of Git. `init` creates one profile per role so you can try the workflow. Give each
contributor their own principal ID and token in the host configuration.
See [hosting and access](hosting.md) for remote TLS and scoped identities.
