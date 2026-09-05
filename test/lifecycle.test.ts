import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { setup, dock, prompt } from "./helpers.js";
import { AxpClient } from "../src/client.js";
import { channels, EXECUTORS } from "../src/protocol/types.js";
import type { ExchangeState, ExecutorRegistry } from "../src/protocol/types.js";

test("donor revocation settles once, fences output and releases the task only on explicit close", async (t) => {
  const f = await setup();
  t.after(f.close);
  const lease = await dock(f.contributor, f.c.exchange);
  const turn = prompt();
  await f.maintainer.dispatch(f.c.chat, turn);
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    ceiling: { tokens: 99, costMicros: 100, turns: 1 },
  });
  await f.maintainer.dispatch(f.c.chat, {
    type: ActionType.ChatPendingMessageSet,
    kind: PendingMessageKind.Queued,
    id: randomUUID(),
    message: { text: "Next", origin: { kind: MessageKind.User } },
  });
  await assert.rejects(
    f.maintainer.call("_axp/revoke", {
      channel: f.c.exchange,
      grantId: "donation",
    }),
    /donor/,
  );
  await f.contributor.call("_axp/revoke", {
    channel: f.c.exchange,
    grantId: "donation",
    operationId: "revoke",
  });
  await f.contributor.call("_axp/revoke", {
    channel: f.c.exchange,
    grantId: "donation",
    operationId: "revoke",
  });
  const state = await f.observer.snapshot<ExchangeState>(f.c.exchange);
  assert.equal(state.status, "orphaned");
  assert.equal(state.usage.length, 1);
  assert.equal(state.grants.donation?.spent.tokens, 99);
  await assert.rejects(
    f.contributor.call("_axp/settle", {
      channel: f.c.exchange,
      epoch: lease.epoch,
      turnId: turn.turnId,
      usage: null,
      outcome: "complete",
    }),
    /stale/,
  );
  const replacement = channels(randomUUID());
  const create = () =>
    f.maintainer.ahp.request("createSession", {
      channel: replacement.session,
      provider: "axp",
      config: { task: f.c.session },
    });
  await assert.rejects(create(), /already owns/);
  await assert.rejects(
    f.contributor.call("_axp/close", { channel: f.c.exchange }),
    /Maintainer/,
  );
  await f.maintainer.call("_axp/close", { channel: f.c.exchange });
  const closed = await f.observer.snapshot<ChatState>(f.c.chat);
  assert.equal(closed.turns.length, 1);
  assert.equal(closed.activeTurn, undefined);
  assert.equal(closed.queuedMessages, undefined);
  await create();
  assert.equal(
    (await f.observer.snapshot<ExchangeState>(f.c.exchange)).status,
    "closed",
  );
  await assert.rejects(f.maintainer.dispatch(f.c.chat, prompt()), /open chat/);
});

test("an executor cannot impersonate a registry owner or claim maintainer approval", async (t) => {
  const f = await setup();
  t.after(f.close);
  await f.maintainer.call("_axp/register", {
    channel: EXECUTORS,
    executorId: "hosted",
    placement: "hosted",
    name: "Hosted",
    capabilities: ["acp/stdio"],
    ttlMs: 3000,
  });
  await assert.rejects(
    f.contributor.call("_axp/register", {
      channel: EXECUTORS,
      executorId: "hosted",
      placement: "satellite",
      name: "Impostor",
      capabilities: [],
      ttlMs: 3000,
    }),
    /another contributor/,
  );
  const lease = await dock(f.contributor, f.c.exchange);
  const turn = prompt();
  await f.maintainer.dispatch(f.c.chat, turn);
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    ceiling: { tokens: 10, costMicros: 10, turns: 1 },
  });
  const emit = (actions: unknown[]) =>
    f.contributor.call("_axp/emit", {
      channel: f.c.exchange,
      epoch: lease.epoch,
      actions,
    });
  await emit([
    {
      type: ActionType.ChatToolCallStart,
      turnId: turn.turnId,
      toolCallId: "tool",
      toolName: "acp",
      displayName: "Build",
    },
  ]);
  await assert.rejects(
    emit([
      {
        type: ActionType.ChatToolCallReady,
        turnId: turn.turnId,
        toolCallId: "tool",
        invocationMessage: "Build",
        confirmed: "user-action",
      },
    ]),
    /cannot claim user approval/,
  );
  const registry = await f.observer.snapshot<ExecutorRegistry>(EXECUTORS);
  assert.equal(registry.entries.hosted?.owner, "maintainer");
});

test("a scoped contributor cannot read another task through subscriptions, blobs, exports or memories", async (t) => {
  const f = await setup();
  t.after(f.close);
  // Credentials are immutable within a host; provision a second host from the
  // same explicit session IDs to exercise the actual authentication boundary.
  const { Hub } = await import("../src/hub.js");
  const token = randomUUID();
  const hidden = channels(randomUUID());
  const hub = new Hub({
    repository: "scoped",
    credentials: [
      f.credentials[0]!,
      {
        token,
        principal: {
          id: "limited",
          role: "contributor",
          sessions: [f.c.session],
        },
      },
    ],
  });
  const url = await hub.listen();
  const admin = await AxpClient.connect(url, f.credentials[0]!.token);
  const limited = await AxpClient.connect(url, token);
  t.after(async () => {
    await limited.close();
    await admin.close();
    await hub.close();
  });
  for (const c of [f.c, hidden])
    await admin.ahp.request("createSession", {
      channel: c.session,
      provider: "axp",
    });
  const blob = await admin.call("_axp/blobPut", {
    channel: hidden.exchange,
    data: Buffer.from("secret").toString("base64"),
    mediaType: "text/plain",
  });
  assert.equal(
    (await limited.ahp.request("listSessions", { channel: "ahp-root://" }))
      .items.length,
    1,
  );
  await limited.snapshot(f.c.chat);
  await assert.rejects(limited.snapshot(hidden.chat), /scope/);
  await assert.rejects(
    limited.call("_axp/export", { channel: hidden.exchange }),
    /scope/,
  );
  await assert.rejects(
    limited.ahp.request("resourceRead", {
      channel: "ahp-root://",
      uri: blob.uri,
    }),
    /scope/,
  );
  await assert.rejects(
    limited.call("_axp/blobGet", {
      channel: f.c.exchange,
      digest: blob.sha256,
    }),
    /not found/,
  );
  const lease = await dock(admin, hidden.exchange);
  const lesson = await admin.call("_axp/memoryPropose", {
    channel: hidden.exchange,
    title: "Secret task",
    trigger: "secret",
    lesson: "Private lesson",
    outcome: "failure",
    fromSeq: 0,
    toSeq: hub.store.seq,
  });
  await admin.call("_axp/memoryReview", {
    channel: "axp-memory://",
    memoryId: lesson.id,
    revision: lesson.revision,
    status: "accepted",
  });
  assert.equal(
    (
      await limited.call("_axp/memorySearch", {
        channel: f.c.exchange,
        query: "secret",
      })
    ).total,
    0,
  );
  await admin.call("_axp/release", {
    channel: hidden.exchange,
    epoch: lease.epoch,
  });
});
