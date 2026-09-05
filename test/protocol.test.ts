import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exchangeReducer,
  memoryReducer,
  executorReducer,
} from "../src/protocol/reducer.js";
import type {
  ExchangeAction,
  ExchangeState,
  Memory,
  MemoryState,
} from "../src/protocol/types.js";
import { Store } from "../src/store.js";
import { Sessions } from "../src/sessions.js";
import { channels } from "../src/protocol/types.js";

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) frozen(item);
  }
  return value;
}

test("AXP reducer replay preserves prior state, audit usage, context and review invalidation", () => {
  const store = new Store();
  try {
    const sessions = new Sessions(store, "repo", () => 1000);
    const c = channels("test");
    const initial = store.transaction((tx) =>
      sessions.create(
        tx,
        { id: "m", role: "maintainer", sessions: "*" },
        c.session,
        "test",
        "test",
      ),
    ).result;
    const grant = {
      id: "grant",
      owner: "c",
      limit: { tokens: 100, costMicros: 10, turns: 1 },
      spent: { tokens: 0, costMicros: 0, turns: 0 },
      revoked: false,
      enforcement: "accounting" as const,
    };
    const ref = {
      uri: "axp-blob:/test",
      sha256: "a".repeat(64),
      size: 10,
      mediaType: "application/octet-stream",
    };
    const checkpoint = {
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      branch: "axp/test",
      bundle: ref,
      patch: ref,
      createdAt: 1000,
    };
    const manifest = {
      version: 1 as const,
      repository: "repo",
      session: c.session,
      baseCommit: checkpoint.baseCommit,
      headCommit: checkpoint.headCommit,
      model: "test",
      promptHash: "a".repeat(64),
      traceHash: "b".repeat(64),
      traceThroughSeq: 1,
      checkpointDigest: "c".repeat(64),
    };
    const review = {
      manifest,
      contributor: { publicKey: "key", signature: "sig" },
      maintainer: null,
    };
    const context = {
      ...initial.context,
      revision: 1,
      summary: "Keep the parser API stable",
      throughTurn: 1,
    };
    const memory: Memory = {
      id: "m",
      revision: 1,
      scope: "repo",
      title: "Keep API stable",
      trigger: "parser",
      lesson: "Use the existing parse result",
      outcome: "failure",
      evidence: [],
      status: "proposed",
      author: "c",
    };
    const actions: ExchangeAction[] = [
      { type: "_axp/grantChanged", grant },
      {
        type: "_axp/leaseChanged",
        lease: {
          owner: "c",
          executorId: "e",
          epoch: 1,
          expiresAt: 4000,
          heartbeatMs: 1000,
          grantId: "grant",
        },
        epoch: 1,
        status: "open",
      },
      {
        type: "_axp/reserved",
        reservation: {
          turnId: "t",
          grantId: "grant",
          epoch: 1,
          ceiling: grant.limit,
          startedAt: 1000,
        },
      },
      {
        type: "_axp/settled",
        turnId: "t",
        grant: { ...grant, spent: grant.limit },
        usage: {
          inputTokens: 80,
          outputTokens: 20,
          cacheReadTokens: 40,
          costMicros: 10,
          source: "reported",
        },
      },
      { type: "_axp/checkpointChanged", checkpoint },
      {
        type: "_axp/compactionProposed",
        proposal: {
          id: "p",
          author: "c",
          expectedRevision: 0,
          context,
          evidence: { fromSeq: 0, toSeq: 10 },
        },
      },
      { type: "_axp/contextChanged", context },
      { type: "_axp/reviewChanged", review },
      {
        type: "_axp/verificationChanged",
        verification: {
          headCommit: checkpoint.headCommit,
          verifier: "v",
          command: ["test"],
          exitCode: 0,
          output: ref,
          verifiedAt: 1000,
        },
      },
      { type: "_axp/memoryChanged", memory },
    ];
    let state: ExchangeState = frozen(initial);
    for (const action of actions) {
      const before = JSON.stringify(state);
      const next = exchangeReducer(state, frozen(action));
      assert.equal(JSON.stringify(state), before);
      state = frozen(next);
    }
    assert.deepEqual(actions.reduce(exchangeReducer, initial), state);
    assert.equal(state.usage.length, 1);
    assert.equal(state.context.summary, context.summary);
    assert.equal(state.compaction, null);
    assert.equal(state.reservation, null);
    const next = exchangeReducer(state, {
      type: "_axp/checkpointChanged",
      checkpoint: { ...checkpoint, headCommit: "d".repeat(40) },
    });
    assert.equal(next.review, null);
    assert.equal(next.verification, null);
    const unknown = { type: "_axp/future" } as unknown as ExchangeAction;
    assert.equal(exchangeReducer(state, unknown), state);
    const bank: MemoryState = frozen({
      resource: "axp-memory://",
      entries: {},
    });
    assert.equal(memoryReducer(bank, unknown), bank);
    const executors = { resource: "axp-executors://", entries: {} };
    assert.equal(executorReducer(executors, unknown), executors);
    assert.equal(
      executorReducer(executors, {
        type: "_axp/executorChanged",
        executor: {
          id: "e",
          owner: "c",
          name: "ACP agent",
          placement: "hosted",
          capabilities: ["acp/v1"],
          expiresAt: 1000,
          online: true,
        },
      }).entries.e?.owner,
      "c",
    );
    const added = memoryReducer(bank, { type: "_axp/memoryChanged", memory });
    assert.equal(added.entries.m, memory);
    assert.deepEqual(bank.entries, {});
  } finally {
    store.close();
  }
});
