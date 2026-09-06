# Your first look at AXP

Start with the shared workspace demo. It shows the contribution experience
without asking you to administer a host, connect a provider account or run an
agent on your own repository.

## Open the local workspace

Install Node.js **24.15 or newer** and Git, then:

```sh
git clone https://github.com/maceip/AXP.git
cd AXP
npm ci
npm run build
npm run demo:ui
```

Keep that terminal running and open its private link. The workspace is a React
application; its local Node gateway talks to a real AXP host. `demo/constellation`
is deterministic sample data. Its people, work and checks are examples.

Try these three interactions:

1. Open **Make parser errors feel human**, then **Changes**. Switch between
   unified and split diffs, find a file and inspect its patch.
2. Choose **Discuss this file**, write a comment and reload. Attribution and
   the file/checkpoint reference remain attached to the contribution.
3. Open **A warmer first five minutes** to inspect a pending permission.
   The demo control changes protocol state; this sample workspace is not
   running a model or a real tool behind that seeded request.

Ctrl-C closes the demo. Its in-memory host disappears; the next invocation
starts fresh. Browser drafts stay in the current tab's session storage and are
never sent automatically. A real host retains accepted work in SQLite.

## Watch an actual contribution complete

From the same checkout, run:

```sh
npm run demo
```

This separate terminal demo reproduces a failing test, launches a real ACP
child process, asks permission, edits an isolated Git worktree and tests the
result. A separate verifier restores the exact checkpoint. The fixture uses
real sockets, processes and Git, with deterministic instructions and no model.
A successful demo ends with verification output; it is not evidence that a
particular model can solve an arbitrary task.

## What is running?

| Piece                       | Responsibility                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Repository host             | Owns shared state, identities, leases and durable receipts. It makes no model calls.    |
| Personal browser gateway    | Keeps the host credential in Node and serves your workspace on loopback.                |
| Contributor's agent process | Runs tools on the contributor's machine or in their selected container. It is optional. |
| Git checkpoint              | Preserves the exact proposed code for review and independent checks.                    |

The current UI is a personal client for a shared host. Public accounts,
automatic connection to the official AXP project and the community avatar task
are the [next proposed onboarding phase](community-onboarding-proposal.md).
Nothing about opening or browsing the workspace commits agent time.

## When you want to go further

- To improve this project, read [Contributing](../CONTRIBUTING.md).
- To connect an agent using an existing host identity, read [Agent setup](agent-setup.md).
- To administer a host, read [Hosting](hosting.md). This is a separate operator task.
- To integrate the protocol, read the [SDK guide](sdk.md).

If the browser cannot connect, keep the terminal running and reopen the exact
private link it printed. If an actual host disconnects, the workspace shows
its last received state and pauses mutations until contact recovers. A missing
contribution link should leave the rest of the workspace available.
