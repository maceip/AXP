import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDispatchHeaders,
  buildCancelHeaders,
  parseAampHeaders,
} from "aamp-sdk";
import { ActionType, ResponsePartKind } from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { AampBridge } from "../src/aamp.js";
import type { AampMailbox, AampMail, AampReply } from "../src/aamp.js";
import { aampReplyHeaders, parseAampMail } from "../src/aamp/wire.js";
import { setup, dock, prompt } from "./helpers.js";
import { faultProxy } from "./fault-proxy.js";
import { AxpClient } from "../src/client.js";
import type { AampBridgeOptions } from "../src/aamp.js";
import type { ExchangeState } from "../src/protocol/types.js";

class Mailbox implements AampMailbox {
  email = "axp@example.com";
  inbox: AampMail[] = [];
  sent: AampReply[] = [];
  uncertain = false;
  async read(cursor: string | null) {
    return {
      messages: this.inbox.slice(Number(cursor ?? 0)),
      cursor: String(this.inbox.length),
    };
  }
  async send(reply: AampReply) {
    this.sent.push(structuredClone(reply));
    if (this.uncertain && reply.intent === "task.result") {
      this.uncertain = false;
      throw new Error("SMTP reply lost after delivery");
    }
  }
  close() {}
}

function mail(
  taskId: string,
  text = "Fix the parser",
  additions: Partial<AampMail> = {},
): AampMail {
  return {
    id: taskId,
    from: "maintainer@example.com",
    to: ["axp@example.com"],
    messageId: `<${taskId}@example.com>`,
    subject: "Review a contribution",
    text,
    attachments: [],
    headers: Object.entries(
      buildDispatchHeaders({
        taskId,
        sessionKey: "project-room",
        dispatchContext: { project: "demo repo" },
      }),
    ).map(([name, value]) => ({ name, value })),
    ...additions,
  };
}
function cancel(taskId: string, from = "maintainer@example.com") {
  return mail(taskId, "Stop", {
    id: `cancel-${taskId}-${from}`,
    from,
    messageId: `<cancel-${taskId}@example.com>`,
    headers: Object.entries(buildCancelHeaders({ taskId })).map(
      ([name, value]) => ({ name, value }),
    ),
  });
}

async function fixture(t: TestContext) {
  const host = await setup();
  const directory = await mkdtemp(join(tmpdir(), "axp-aamp-"));
  const mailbox = new Mailbox();
  const options = {
    url: host.url,
    token: host.credentials[0]!.token,
    mailbox,
    database: join(directory, "mail.db"),
    routes: [
      {
        from: "maintainer@example.com",
        session: host.c.exchange.slice("axp-session:/".length),
        sessionKey: "project-room",
        context: { project: ["demo repo"] },
      },
    ],
  };
  let bridge = new AampBridge(options);
  t.after(async () => {
    await bridge.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  const restart = async (overrides: Partial<AampBridgeOptions> = {}) => {
    await bridge.close();
    bridge = new AampBridge({ ...options, ...overrides });
    return bridge;
  };
  return {
    host,
    mailbox,
    options,
    restart,
    get bridge() {
      return bridge;
    },
  };
}

async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  text = "Fixed the parser.",
  checkpoint = false,
) {
  const chat = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  assert.ok(chat.activeTurn);
  const turnId = chat.activeTurn.id;
  const lease = await dock(f.host.contributor, f.host.c.exchange);
  await f.host.contributor.call("_axp/reserve", {
    channel: f.host.c.exchange,
    epoch: lease.epoch,
    turnId,
    ceiling: { tokens: 100, costMicros: 100, turns: 1 },
  });
  await f.host.contributor.call("_axp/emit", {
    channel: f.host.c.exchange,
    epoch: lease.epoch,
    actions: [
      {
        type: ActionType.ChatResponsePart,
        turnId,
        part: { id: "reply", kind: ResponsePartKind.Markdown, content: text },
      },
    ],
  });
  if (checkpoint) await publishCheckpoint(f, lease.epoch, "b");
  await f.host.contributor.call("_axp/settle", {
    channel: f.host.c.exchange,
    epoch: lease.epoch,
    turnId,
    usage: null,
    outcome: "complete",
  });
  return turnId;
}

async function publishCheckpoint(
  f: Awaited<ReturnType<typeof fixture>>,
  epoch: number,
  head: string,
) {
  const ref = await f.host.contributor.call("_axp/blobPut", {
    channel: f.host.c.exchange,
    data: Buffer.from("checkpoint fixture").toString("base64"),
    mediaType: "application/octet-stream",
  });
  await f.host.contributor.call("_axp/checkpoint", {
    channel: f.host.c.exchange,
    epoch,
    checkpoint: {
      baseCommit: "a".repeat(40),
      headCommit: head.repeat(40),
      branch: "axp/test",
      bundle: ref,
      patch: ref,
      createdAt: 0,
    },
    files: [],
  });
}

test("AAMP expiry survives downtime and cannot start queued work after its deadline", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  await f.restart({ now: () => now });
  const active = mail("expires-running"),
    queued = mail("expires-queued");
  for (const message of [active, queued])
    message.headers.push({
      name: "X-AAMP-Expires-At",
      value: new Date(now + 1000).toISOString(),
    });
  f.mailbox.inbox.push(active, queued);
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn
      ?.message.text,
    active.text,
  );
  now += 2000;
  await f.restart({ now: () => now });
  await f.bridge.sync();
  const chat = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  assert.equal(chat.activeTurn, undefined);
  assert.equal(chat.turns.length, 1);
  assert.equal(chat.turns[0]?.state, "cancelled");
  assert.deepEqual(
    f.mailbox.sent
      .filter((r) => r.intent === "task.result")
      .map((r) => r.status),
    ["rejected", "rejected"],
  );
});

test("AAMP revoked routes stop active work and withhold previously unsent output", async (t) => {
  const f = await fixture(t);
  f.mailbox.inbox.push(mail("revoke-result"), mail("revoke-running"));
  await f.bridge.sync();
  await complete(f, "Private output");
  f.mailbox.uncertain = true;
  await assert.rejects(f.bridge.sync(), /SMTP reply lost/);
  const count = f.mailbox.sent.length;
  await f.restart({
    routes: [
      {
        from: "replacement@example.com",
        session: f.options.routes[0]!.session,
      },
    ],
  });
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn,
    undefined,
  );
  const replies = f.mailbox.sent.slice(count);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]?.taskId, "revoke-running");
  assert.doesNotMatch(replies[0]!.text, /Private output/);
});

test("AAMP result metadata names its own checkpoint even if the session advanced before polling", async (t) => {
  const f = await fixture(t);
  f.mailbox.inbox.push(mail("checkpoint"));
  await f.bridge.sync();
  await complete(f, "Contribution ready", true);
  const state = await f.host.maintainer.snapshot<ExchangeState>(
    f.host.c.exchange,
  );
  await publishCheckpoint(f, state.lease!.epoch, "c");
  await f.bridge.sync();
  assert.equal(
    f.mailbox.sent
      .at(-1)
      ?.structuredResult?.find((field) => field.fieldKey === "axp.checkpoint")
      ?.value,
    "b".repeat(40),
  );
});

test("AAMP does not admit another task using an already consumed Message-ID", async (t) => {
  const f = await fixture(t);
  const warnings: Error[] = [];
  f.bridge.on("warning", (error) => warnings.push(error));
  f.mailbox.inbox.push(
    mail("original"),
    mail("different", "Different input", {
      messageId: "<original@example.com>",
    }),
  );
  await f.bridge.sync();
  await complete(f);
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn,
    undefined,
  );
  assert.equal(f.mailbox.sent.filter((r) => r.intent === "task.ack").length, 1);
  assert.match(warnings[0]!.message, /Message-ID reused/);
});

test("AAMP SDK dispatches enter AHP once; results round-trip through the upstream parser", async (t) => {
  const f = await fixture(t);
  f.mailbox.inbox.push(mail("first"), mail("second", "Then document the fix"));
  await f.bridge.sync();
  const first = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  assert.equal(first.activeTurn?.message.text, "Fix the parser");
  assert.equal(f.mailbox.sent.filter((r) => r.intent === "task.ack").length, 2);
  const turnId = await complete(f);
  await f.bridge.sync();
  const result = f.mailbox.sent.find((r) => r.intent === "task.result")!;
  const decoded = parseAampHeaders({
    from: f.mailbox.email,
    to: result.to,
    messageId: result.messageId,
    subject: "Result",
    headers: aampReplyHeaders(result),
    bodyText: result.text,
  });
  if (!decoded || !("intent" in decoded) || decoded.intent !== "task.result")
    assert.fail();
  assert.equal(decoded.status, "completed");
  assert.equal(decoded.output, "Fixed the parser.");
  assert.deepEqual(decoded.structuredResult, [
    { fieldKey: "axp.session", fieldTypeKey: "text", value: f.host.c.session },
    { fieldKey: "axp.turn", fieldTypeKey: "text", value: turnId },
  ]);
  assert.equal(result.inReplyTo, "<first@example.com>");
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn
      ?.message.text,
    "Then document the fix",
  );
  f.mailbox.inbox.push(
    mail("first", "Fix the parser", {
      id: "redelivery",
      messageId: "<another-delivery@example.com>",
    }),
  );
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).turns.length,
    1,
  );
  assert.equal(
    f.mailbox.sent.filter(
      (r) => r.taskId === "first" && r.intent === "task.result",
    ).length,
    1,
  );
});

test("AAMP sender/context admission, cancellation tombstones, and stale or incomplete mail", async (t) => {
  const f = await fixture(t);
  const expired = mail("expired");
  expired.headers.push({
    name: "X-AAMP-Expires-At",
    value: "2020-01-01T00:00:00Z",
  });
  const wrongContext = mail("wrong-context");
  wrongContext.headers = wrongContext.headers.filter(
    (h) => h.name !== "X-AAMP-Dispatch-Context",
  );
  f.mailbox.inbox.push(
    mail("unknown", "Intrude", { from: "intruder@example.com" }),
    wrongContext,
    mail("truncated", "Partial", { truncated: true }),
    mail("attachment", "Read attachment", {
      attachments: [{ name: "task.txt", size: 100 }],
    }),
    expired,
    mail("cancelled"),
    cancel("cancelled"),
  );
  await f.bridge.sync();
  const chat = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  assert.equal(chat.activeTurn, undefined);
  assert.equal(chat.turns.length, 0);
  assert.deepEqual(
    f.mailbox.sent.map((r) => [r.taskId, r.status]).sort(),
    ["truncated", "attachment", "expired", "cancelled"]
      .map((id) => [id, "rejected"])
      .sort(),
  );
  f.mailbox.inbox.push(mail("active"));
  await f.bridge.sync();
  f.mailbox.inbox.push(cancel("active", "intruder@example.com"));
  await f.bridge.sync();
  assert.ok(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn,
  );
  f.mailbox.inbox.push(cancel("active"));
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).turns[0]
      ?.state,
    "cancelled",
  );
  assert.equal(f.mailbox.sent.at(-1)?.status, "rejected");
});

test("AAMP durable admission survives a lost AHP reply and SMTP uncertainty across adapter restarts", async (t) => {
  const f = await fixture(t);
  const proxy = await faultProxy(f.host.url);
  t.after(proxy.close);
  // A separate journal identity keeps the configured host address stable through restart.
  await f.restart({
    url: proxy.url,
    database: join(f.options.database, "..", "proxy.db"),
  });
  f.mailbox.inbox.push(mail("durable"));
  proxy.dropReplyTo("_axp/dispatch");
  await assert.rejects(f.bridge.sync());
  const admitted = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  assert.ok(admitted.activeTurn);
  await f.restart({
    url: proxy.url,
    database: join(f.options.database, "..", "proxy.db"),
  });
  await f.bridge.sync();
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).activeTurn?.id,
    admitted.activeTurn.id,
  );
  await complete(f);
  f.mailbox.uncertain = true;
  await assert.rejects(f.bridge.sync(), /SMTP reply lost/);
  const sent = f.mailbox.sent.at(-1)!;
  await f.restart({
    url: proxy.url,
    database: join(f.options.database, "..", "proxy.db"),
  });
  await f.bridge.sync();
  assert.deepEqual(
    f.mailbox.sent.at(-1),
    sent,
    "retry must preserve Message-ID and exact result",
  );
  assert.equal(
    (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat)).turns.length,
    1,
  );
});

test("durable AHP dispatch keeps maintainer authority and detects changed retries across clients", async (t) => {
  const f = await setup();
  t.after(f.close);
  const action = prompt();
  await assert.rejects(
    f.contributor.dispatch(f.c.chat, action, "attempt"),
    /Maintainer/,
  );
  await f.maintainer.dispatch(f.c.chat, action, "durable-action");
  const client = await AxpClient.connect(f.url, f.credentials[0]!.token);
  t.after(() => client.close());
  const seq = f.hub.store.seq;
  await client.dispatch(f.c.chat, action, "durable-action");
  assert.equal(f.hub.store.seq, seq);
  await assert.rejects(
    client.dispatch(f.c.chat, prompt("Changed"), "durable-action"),
    /different input/,
  );
});

test("AAMP help requests report pending permissions without granting email execution authority", async (t) => {
  const f = await fixture(t);
  f.mailbox.inbox.push(mail("permission"));
  await f.bridge.sync();
  const turnId = (await f.host.maintainer.snapshot<ChatState>(f.host.c.chat))
    .activeTurn!.id;
  const lease = await dock(f.host.contributor, f.host.c.exchange);
  await f.host.contributor.call("_axp/reserve", {
    channel: f.host.c.exchange,
    epoch: lease.epoch,
    turnId,
    ceiling: { tokens: 100, costMicros: 100, turns: 1 },
  });
  await f.host.contributor.call("_axp/emit", {
    channel: f.host.c.exchange,
    epoch: lease.epoch,
    actions: [
      {
        type: ActionType.ChatToolCallStart,
        turnId,
        toolCallId: "write",
        toolName: "edit",
        displayName: "Edit parser",
      },
      {
        type: ActionType.ChatToolCallReady,
        turnId,
        toolCallId: "write",
        invocationMessage: "Edit parser",
        options: [{ id: "yes", label: "Allow once", kind: "approve" }],
      },
    ],
  });
  await f.bridge.sync();
  await f.bridge.sync();
  assert.equal(
    f.mailbox.sent.filter((r) => r.intent === "task.help_needed").length,
    1,
  );
  assert.match(f.mailbox.sent.at(-1)!.text, /Mail replies do not grant/);
  const chat = await f.host.maintainer.snapshot<ChatState>(f.host.c.chat);
  const part = chat.activeTurn!.responseParts[0];
  assert.equal(
    part?.kind === "toolCall" && part.toolCall.status,
    "pending-confirmation",
  );
});

test("AAMP wire validation rejects ambiguous controls and preserves unknown-extension compatibility", () => {
  const input = mail("wire");
  input.headers = input.headers.map((h) => ({
    name: h.name.toLowerCase(),
    value: h.value,
  }));
  input.headers.push(
    { name: "X-AAMP-Future", value: "one" },
    { name: "x-aamp-future", value: "two" },
  );
  assert.equal(
    parseAampMail(input, "axp@example.com")?.context.project,
    "demo repo",
  );
  input.headers.push({ name: "X-AAMP-TaskId", value: "another" });
  assert.throws(() => parseAampMail(input, "axp@example.com"), /Duplicate/);
  assert.throws(
    () =>
      parseAampMail(
        {
          ...mail("old"),
          headers: mail("old").headers.filter(
            (h) => h.name !== "X-AAMP-Version",
          ),
        },
        "axp@example.com",
      ),
    /version/,
  );
});
