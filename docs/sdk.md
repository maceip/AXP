# Build with AXP

AXP ships a TypeScript SDK and CLI in `@maceip/axp`. The runtime requires
Node.js 24.15+. Build the checkout and use `npm pack` to produce an installable
tarball; the checkout workflow does not depend on an npm registry release.

## Package boundaries

| Import                 | Use                                                        |
| ---------------------- | ---------------------------------------------------------- |
| `@maceip/axp/protocol` | Extension types, runtime schemas and pure reducers         |
| `@maceip/axp/client`   | The Node AHP/AXP client and typed command results          |
| `@maceip/axp/aamp`     | Mailbox adapter and its transport contracts                |
| `@maceip/axp`          | Host, satellite, Git, verification and context integration |

The browser application uses a personal Node gateway; `AxpClient` is not a
browser WebSocket client. Importing the pure protocol entry point does not
start a host or an agent.

## Read a contribution

Use an existing host-issued observer profile. This example reads data and
closes its connection even if a request fails:

```ts
import { readFile } from "node:fs/promises";
import { AxpClient } from "@maceip/axp/client";
import { channels, ROOT } from "@maceip/axp/protocol";
import type { ExchangeState } from "@maceip/axp/protocol";

const profile = JSON.parse(await readFile(".axp/observer.json", "utf8"));
const client = await AxpClient.connect(profile.url, profile.token);
try {
  const catalog = await client.ahp.request("listSessions", { channel: ROOT });
  console.log(catalog.items);
  const state = await client.snapshot<ExchangeState>(
    channels("parser-fix").exchange,
  );
  console.log(state.checkpoint);
} finally {
  await client.close();
}
```

A snapshot subscribes that connection to its channel. Listen for `action`
events if you need live updates, and unsubscribe channels you no longer use.
The host bounds each connection to 256 subscriptions. Its AHP client and the
AXP reducers are the reference for applying ordered state changes.

## Make a mutation safely

`client.call` validates its input and infers the result. The host independently
validates scope, role and state. A contributor profile can post discussion;
an observer cannot. In a separate connection using a contributor profile, put
this mutation inside the same `try`/`finally` lifetime shown above:

```ts
const operationId = crypto.randomUUID(); // Persist alongside the intended input.
const input = {
  channel: channels("parser-fix").exchange,
  operationId,
  body: "The parser API remains unchanged; I checked the error path.",
  checkpoint: null,
  path: null,
};
const comment = await client.call("_axp/comment", input);
```

If the reply is lost, reconnect and retry with **the same operation ID and
input**. The durable receipt returns the original result. Changed input under
that ID is a conflict. A new operation ID means new work; do not generate one
for an uncertain retry. The same rule applies to
`client.dispatch(channel, action, operationId)`.

The default client ID is unique. If you supply a stable client ID across
sequential connections, the AXP client resumes its dispatch sequence from the
host's committed receipts. Do not use one client ID concurrently. Reuse of a
client ID does not resume an agent process; `Satellite` owns agent reconnection.

## Errors and lifetime

`AxpClient.connect` accepts an abort signal for connection/initialization and a
request timeout. Transport loss and RPC rejection are distinct: reconnect for
transport loss, then reconcile receipts; correct a rejected request before
retrying it. A stale lease is not permission to continue execution.

The host has one owner process per database and binds that database to one
repository name. `Hub.close`, `WorkspaceServer.close` and agent shutdown are
safe to call repeatedly. A new satellite instance represents a new donation;
its internal reconnection preserves the original donation and local worktree.

See [Protocol](protocol.md) for commands and authority, [Artifacts](artifacts.md)
for signing and verification, and [Memory](memory.md) for context integration.
