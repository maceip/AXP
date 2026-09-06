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
      "Explain parser errors",
      "issue-42",
      "Explain why parsing failed and how to fix the input. Keep the existing parser API.",
    ],
    [
      "first-run",
      "Improve first-time setup",
      "issue-57",
      "Help a first-time contributor connect an agent and choose a task.",
    ],
    [
      "mail-bridge",
      "Handle email task retries",
      "issue-63",
      "Save incoming email tasks so they survive network interruptions. Record each result in the session history.",
    ],
    [
      "contributor-guide",
      "Write a contributor guide",
      "issue-71",
      "Write setup instructions and examples for new contributors.",
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
                ? "The parser rejects empty input with a generic error. The patch explains how to fix the input without changing the return type.\n\nThe patch is ready for review."
                : i === 1
                  ? "I found the first-run entry point. Before changing it, I need permission to edit the welcome screen."
                  : "I am checking that tasks survive a restart and that retrying a message does not start the same task twice. Here is the path a task takes:\n\n```mermaid\ngraph TD\n  A[Email arrives] --> B{Sender allowed?}\n  B -->|no| C[Warn locally]\n  B -->|yes| D[Save task]\n  D --> E([Acknowledge])\n  D --> F{Session free?}\n  F -->|no| G[Queue]\n  G --> F\n  F -->|yes| H[Start turn]\n  H --> I[(Checkpoint)]\n  I --> J([Reply with result])\n```",
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
        body: "The return type is unchanged. Please check the error message before approving.",
        checkpoint: "b".repeat(40),
        path: "src/parser.ts",
      });
      await maintainer.call("_axp/comment", {
        channel: c.exchange,
        body: "Thanks. The error now explains how to fix the input.",
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
