import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ActionType,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ConfirmationOptionKind,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import type { ExchangeState } from "../src/protocol/types.js";
import { setup, dock, prompt } from "./helpers.js";

test("real sockets: one atomic claim, gated AHP streaming and idempotent spending", async (t) => {
  const f = await setup();
  t.after(f.close);
  const lease = await dock(f.contributor, f.c.exchange);
  await assert.rejects(
    f.contributor.call("_axp/claim", {
      channel: f.c.exchange,
      grantId: "donation",
      executorId: "second",
      leaseMs: 30_000,
    }),
    /already has/,
  );
  const action = prompt();
  await assert.rejects(f.observer.dispatch(f.c.chat, action), /Maintainer/);
  await f.maintainer.dispatch(f.c.chat, action);
  await assert.rejects(
    f.contributor.call("_axp/emit", {
      channel: f.c.exchange,
      epoch: lease.epoch,
      actions: [],
    }),
    /Too small/,
  );
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: action.turnId,
    ceiling: { tokens: 1000, costMicros: 10_000, turns: 1 },
  });
  await f.contributor.call("_axp/emit", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    actions: [
      {
        type: ActionType.ChatResponsePart,
        turnId: action.turnId,
        part: { kind: ResponsePartKind.Markdown, id: "text", content: "" },
      },
      {
        type: ActionType.ChatDelta,
        turnId: action.turnId,
        partId: "text",
        content: "Working together.",
      },
      {
        type: ActionType.ChatToolCallStart,
        turnId: action.turnId,
        toolCallId: "tool",
        toolName: "test",
        displayName: "Run tests",
      },
      {
        type: ActionType.ChatToolCallReady,
        turnId: action.turnId,
        toolCallId: "tool",
        invocationMessage: "Run the suite",
        options: [
          {
            id: "yes",
            label: "Allow once",
            kind: ConfirmationOptionKind.Approve,
          },
        ],
      },
    ],
  });
  const approve = {
    type: ActionType.ChatToolCallConfirmed,
    turnId: action.turnId,
    toolCallId: "tool",
    approved: true,
    confirmed: ToolCallConfirmationReason.UserAction,
    selectedOptionId: "yes",
  } as const;
  await assert.rejects(f.contributor.dispatch(f.c.chat, approve), /Maintainer/);
  await f.maintainer.dispatch(f.c.chat, approve);
  await f.contributor.call("_axp/emit", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    actions: [
      {
        type: ActionType.ChatToolCallComplete,
        turnId: action.turnId,
        toolCallId: "tool",
        result: { success: true, pastTenseMessage: "Passed" },
      },
    ],
  });
  const settlement = {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: action.turnId,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      costMicros: 100,
      source: "reported" as const,
    },
    outcome: "complete" as const,
    operationId: "settle-once",
  };
  await f.contributor.call("_axp/settle", settlement);
  await f.contributor.call("_axp/settle", settlement);
  const state = await f.observer.snapshot<ExchangeState>(f.c.exchange);
  assert.equal(state.grants.donation?.spent.tokens, 120);
  assert.equal(state.usage.length, 1);
  const a = await f.contributor.snapshot<ChatState>(f.c.chat);
  const b = await f.maintainer.snapshot<ChatState>(f.c.chat);
  assert.deepEqual(a, b);
  assert.equal(a.turns.length, 1);
  assert.equal(a.activeTurn, undefined);
});

test("lease expiry conservatively settles in-flight usage and fences old output", async (t) => {
  let now = 100_000;
  const f = await setup({ now: () => now });
  t.after(f.close);
  const lease = await dock(f.contributor, f.c.exchange, 3000);
  const action = prompt();
  await f.maintainer.dispatch(f.c.chat, action);
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: action.turnId,
    ceiling: { tokens: 1000, costMicros: 10_000, turns: 1 },
  });
  now += 3001;
  f.hub.tick();
  const state = await f.observer.snapshot<ExchangeState>(f.c.exchange);
  assert.equal(state.status, "orphaned");
  assert.equal(state.grants.donation?.spent.tokens, 1000);
  assert.equal(state.usage[0]?.usage.source, "reservation");
  await assert.rejects(
    f.contributor.call("_axp/renew", {
      channel: f.c.exchange,
      epoch: lease.epoch,
    }),
    /stale/,
  );
  const next = await f.contributor.call("_axp/claim", {
    channel: f.c.exchange,
    grantId: "donation",
    executorId: "replacement",
    leaseMs: 3000,
  });
  assert.ok(next.epoch > lease.epoch);
});
