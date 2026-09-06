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
application; its local Node gateway talks to an AXP host. `demo/constellation`
contains sample data. Its people, work and checks are examples.

Try these three interactions:

1. Open **Explain parser errors**, then **Changes**. Switch between
   unified and split diffs, find a file and inspect its patch.
2. Choose **Discuss this file**, write a comment and reload. Attribution and
   the file/checkpoint reference remain attached to the contribution.
3. Open **Improve first-time setup** to inspect a pending permission.
   The demo control changes the session state. The request is an example;
   approving it does not run a model or tool.

Ctrl-C closes the demo. Its in-memory host disappears; the next invocation
starts fresh. Browser drafts stay in the current tab's session storage and are
never sent automatically. A persistent host saves accepted work in SQLite.

## Follow a contribution from start to finish

From the same checkout, run:

```sh
npm run demo
```

This separate terminal demo reproduces a failing test, launches an ACP
agent process, asks permission, edits an isolated Git worktree and tests the
result. A separate verifier restores the checkpoint. The agent follows a script
without calling a model; the sockets, processes, Git operations and tests run
locally. A successful demo ends with verification output. This checks the
contribution workflow, not how well a model solves tasks.

## What is running?

| Piece                       | Responsibility                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Repository host             | Saves shared state, identities, leases and command receipts. It makes no model calls.   |
| Personal browser gateway    | Keeps the host credential in Node and serves your workspace on loopback.                |
| Contributor's agent process | Runs tools on the contributor's machine or in their selected container. It is optional. |
| Git checkpoint              | Saves the proposed code for review and independent checks.                              |

The current UI is a personal client for a shared host. Public accounts,
automatic connection to the official AXP project and the community avatar task
are the [next proposed onboarding phase](community-onboarding-proposal.md).
Nothing about opening or browsing the workspace commits agent time.

## When you want to go further

- To improve this project, read [Contributing](../CONTRIBUTING.md).
- To connect an agent using an existing host identity, read [Agent setup](agent-setup.md).
- To administer a host, read [Hosting](hosting.md). This is a separate operator task.
- To integrate the protocol, read the [SDK guide](sdk.md).

If the browser cannot connect, keep the terminal running and reopen the
private link it printed. If the host disconnects, the workspace shows
its last update and pauses changes until it reconnects. A missing
contribution link should leave the rest of the workspace available.
