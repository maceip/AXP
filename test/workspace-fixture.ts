import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  ActionType,
  MessageKind,
  ResponsePartKind,
} from "@microsoft/agent-host-protocol";
import { Hub } from "../src/hub.js";
import { AxpClient } from "../src/client.js";
import { WorkspaceServer } from "../src/workspace.js";
import { channels } from "../src/protocol/types.js";
import type { Principal } from "../src/protocol/types.js";

/** Explicit demo/test data submitted through the real public protocol. No fixtures enter normal ui mode. */
export async function workspaceFixture() {
  const credentials = (
    ["maintainer", "contributor", "observer", "verifier"] as const
  ).map((role) => ({
    token: randomBytes(32).toString("hex"),
    principal: { id: role, role, sessions: "*" as const },
  }));
  const hub = new Hub({ repository: "demo/constellation", credentials });
  const url = await hub.listen();
  const clients = await Promise.all(
    credentials.map((credential) => AxpClient.connect(url, credential.token)),
  );
  const [maintainer, contributor, observer, verifier] = clients as [
    AxpClient,
    AxpClient,
    AxpClient,
    AxpClient,
  ];
  const servers: WorkspaceServer[] = [];
  const specs = [
    [
      "parser-errors",
      "Make parser errors feel human",
      "issue-42",
      "A useful error should tell you what happened and how to make it right. Preserve the existing parser API.",
    ],
    [
      "first-run",
      "A warmer first five minutes",
      "issue-57",
      "Help a first-time contributor connect their agent and see where they can make a difference.",
    ],
    [
      "mail-bridge",
      "Bring asynchronous agents into the fold",
      "issue-63",
      "Keep task delivery durable across network interruptions, and make every result part of the shared history.",
    ],
    [
      "contributor-guide",
      "Leave a trail for the next contributor",
      "issue-71",
      "Collect the things we wish we knew on day one. Small examples, clear steps, fewer dead ends.",
    ],
  ];
  for (const [id, title, task] of specs)
    await maintainer.ahp.request("createSession", {
      channel: channels(id!).session,
      provider: "axp",
      config: { title: title!, task: task! },
    });
  await contributor.call("_axp/register", {
    channel: "axp-executors://",
    executorId: "local-acp",
    name: "Local ACP agent",
    placement: "satellite",
    capabilities: ["acp/v1"],
    ttlMs: 300_000,
  });
  for (let i = 0; i < 3; i++) {
    const [id, , , text] = specs[i]!;
    const c = channels(id!);
    const turnId = `demo-${i}`;
    await contributor.call("_axp/grant", {
      channel: c.exchange,
      grantId: `grant-${i}`,
      limit: { tokens: 100_000, costMicros: 1000000, turns: 10 },
      enforcement: "accounting",
    });
    const lease = await contributor.call("_axp/claim", {
      channel: c.exchange,
      executorId: "local-acp",
      grantId: `grant-${i}`,
      leaseMs: 300_000,
    });
    await maintainer.dispatch(c.chat, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text: text!, origin: { kind: MessageKind.User } },
    });
    await contributor.call("_axp/reserve", {
      channel: c.exchange,
      epoch: lease.epoch,
      turnId,
      ceiling: { tokens: 1000, costMicros: 10000, turns: 1 },
    });
    await contributor.call("_axp/emit", {
      channel: c.exchange,
      epoch: lease.epoch,
      actions: [
        {
          type: ActionType.ChatResponsePart,
          turnId,
          part: {
            id: `response-${i}`,
            kind: ResponsePartKind.Markdown,
            content:
              i === 0
                ? "The parser currently discards the source location. I can preserve it and add a clear suggestion without changing the return type.\n\nThe patch is ready for a careful look."
                : i === 1
                  ? "I found the first-run entry point. Before changing it, I need permission to edit the welcome screen."
                  : "I’m checking restart behavior and duplicate delivery. The important part is that a retried message never starts duplicate work.",
          },
        },
      ],
    });
    if (i === 1)
      await contributor.call("_axp/emit", {
        channel: c.exchange,
        epoch: lease.epoch,
        actions: [
          {
            type: ActionType.ChatToolCallStart,
            turnId,
            toolCallId: "edit-welcome",
            toolName: "edit",
            displayName: "Update the welcome screen",
          },
          {
            type: ActionType.ChatToolCallReady,
            turnId,
            toolCallId: "edit-welcome",
            invocationMessage: "Edit the welcome screen",
            options: [
              { id: "allow-once", label: "Allow once", kind: "approve" },
              { id: "deny", label: "Deny", kind: "deny" },
            ],
          },
        ],
      });
    if (i === 0) {
      const patch =
        "diff --git a/src/parser.ts b/src/parser.ts\nindex 1234567..abcdef0 100644\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1,4 +1,7 @@\n export function parse(input: string) {\n-  if (!input) throw new Error('Invalid input');\n+  if (!input.trim()) {\n+    throw new Error('Add a value before parsing.');\n+  }\n+  // Preserve the public result shape.\n   return { value: input.trim() };\n }\ndiff --git a/README.md b/README.md\nindex 1234567..abcdef0 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n # Parser\n+\n+Empty input produces a clear, actionable error.\n";
      const ref = await contributor.call("_axp/blobPut", {
        channel: c.exchange,
        data: Buffer.from(patch).toString("base64"),
        mediaType: "text/x-diff",
      });
      await contributor.call("_axp/checkpoint", {
        channel: c.exchange,
        epoch: lease.epoch,
        checkpoint: {
          baseCommit: "a".repeat(40),
          headCommit: "b".repeat(40),
          branch: "axp/parser-errors",
          bundle: ref,
          patch: ref,
          createdAt: Date.now(),
        },
        files: [],
      });
      await contributor.call("_axp/settle", {
        channel: c.exchange,
        epoch: lease.epoch,
        turnId,
        usage: null,
        outcome: "complete",
      });
      await contributor.call("_axp/comment", {
        channel: c.exchange,
        body: "Kept the return type intact. I’d love a second pair of eyes on the wording before we call this ready.",
        checkpoint: "b".repeat(40),
        path: "src/parser.ts",
      });
      await maintainer.call("_axp/comment", {
        channel: c.exchange,
        body: "This is the kind of detail that makes a project easier to join. Thanks for keeping the change focused.",
        checkpoint: null,
        path: null,
      });
    }
  }
  const open = async (
    role: Principal["role"] = "maintainer",
    signingKey?: string,
  ) => {
    const server = new WorkspaceServer({
      url,
      token: credentials.find((c) => c.principal.role === role)!.token,
      assets: resolve("dist/ui"),
      ...(signingKey ? { signingKey } : {}),
    });
    servers.push(server);
    return server.listen();
  };
  const close = async () => {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(clients.map((client) => client.close()));
    await hub.close();
  };
  return {
    open,
    close,
    hub,
    url,
    credentials,
    maintainer,
    contributor,
    observer,
    verifier,
  };
}
