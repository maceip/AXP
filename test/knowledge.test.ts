import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { setup, dock, prompt } from "./helpers.js";
import type { Checkpoint, ExchangeState } from "../src/protocol/types.js";
import { hashObject, signObject } from "../src/hash.js";
import { cacheKey, SessionBank } from "../src/context.js";

test("explicit compaction retains raw history; scoped lessons need review and consolidate evidence", async (t) => {
  const f = await setup();
  t.after(f.close);
  const lease = await dock(f.contributor, f.c.exchange);
  const turn = prompt("Keep the parser API stable");
  await f.maintainer.dispatch(f.c.chat, turn);
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    ceiling: { tokens: 1000, costMicros: 100, turns: 1 },
  });
  await assert.rejects(
    f.maintainer.call("_axp/compact", {
      channel: f.c.exchange,
      expectedRevision: 0,
      throughTurn: 1,
      summary: "Done",
      decisions: [],
      activeFiles: [],
    }),
    /quiescent/,
  );
  await f.contributor.call("_axp/settle", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    usage: null,
    outcome: "complete",
  });
  const ref = await f.contributor.call("_axp/blobPut", {
    channel: f.c.exchange,
    data: Buffer.from("fixture").toString("base64"),
    mediaType: "application/octet-stream",
  });
  const checkpoint: Checkpoint = {
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    branch: "axp/test",
    bundle: ref,
    patch: ref,
    createdAt: 0,
  };
  await f.contributor.call("_axp/checkpoint", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    checkpoint,
    files: [],
  });
  const before = await f.observer.snapshot<ChatState>(f.c.chat);
  const proposal = await f.contributor.call("_axp/compact", {
    channel: f.c.exchange,
    expectedRevision: 0,
    throughTurn: 1,
    summary: "Preserve parser return types.",
    decisions: ["No public API changes"],
    activeFiles: ["parser.ts"],
  });
  await assert.rejects(
    f.contributor.call("_axp/acceptCompaction", {
      channel: f.c.exchange,
      proposalId: proposal.id,
    }),
    /Maintainer/,
  );
  await f.maintainer.call("_axp/acceptCompaction", {
    channel: f.c.exchange,
    proposalId: proposal.id,
  });
  assert.deepEqual(await f.observer.snapshot<ChatState>(f.c.chat), before);
  const context = await f.contributor.call("_axp/context", {
    channel: f.c.exchange,
    maxChars: 4096,
  });
  assert.match(context.text, /Preserve parser/);
  assert.equal(context.throughTurn, 1);
  await assert.rejects(
    f.contributor.call("_axp/compact", {
      channel: f.c.exchange,
      expectedRevision: 0,
      throughTurn: 1,
      summary: "Stale",
      decisions: [],
      activeFiles: [],
    }),
    /revision/,
  );
  const input = {
    channel: f.c.exchange,
    title: "Parser API",
    trigger: "parser edits",
    lesson: "Preserve the public return types",
    outcome: "failure" as const,
    fromSeq: 1,
    toSeq: f.hub.store.seq,
  };
  const memory = await f.contributor.call("_axp/memoryPropose", input);
  assert.equal(
    (
      await f.contributor.call("_axp/memorySearch", {
        channel: f.c.exchange,
        query: "parser",
        limit: 5,
      })
    ).total,
    0,
  );
  const duplicate = await f.contributor.call("_axp/memoryPropose", input);
  assert.equal(duplicate.revision, memory.revision);
  await f.maintainer.call("_axp/memoryReview", {
    channel: "axp-memory://",
    memoryId: memory.id,
    revision: memory.revision,
    status: "accepted",
  });
  const found = await f.contributor.call("_axp/memorySearch", {
    channel: f.c.exchange,
    query: "parser",
    limit: 5,
  });
  assert.equal(found.total, 1);
  assert.equal(found.items[0]?.outcome, "failure");
});

test("artifact signatures bind to exact code and trace; verifier has separate authority", async (t) => {
  const f = await setup();
  t.after(f.close);
  const lease = await dock(f.contributor, f.c.exchange);
  const ref = await f.contributor.call("_axp/blobPut", {
    channel: f.c.exchange,
    data: Buffer.from("fixture").toString("base64"),
    mediaType: "application/octet-stream",
  });
  await f.contributor.call("_axp/checkpoint", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    checkpoint: {
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      branch: "axp/test",
      bundle: ref,
      patch: ref,
      createdAt: 0,
    },
    files: [],
  });
  const state = await f.contributor.snapshot<ExchangeState>(f.c.exchange);
  const archive = await f.contributor.call("_axp/export", {
    channel: f.c.exchange,
  });
  const manifest = {
    version: 1 as const,
    repository: state.repository,
    session: state.session,
    baseCommit: state.checkpoint!.baseCommit,
    headCommit: state.checkpoint!.headCommit,
    model: "fixture",
    promptHash: "f".repeat(64),
    traceHash: hashObject(
      archive.actions.filter((e) => e.channel !== f.c.changeset),
    ),
    traceThroughSeq: archive.serverSeq,
    checkpointDigest: hashObject(state.checkpoint),
  };
  const key = () =>
    generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
  const contributor = signObject(manifest, key());
  const incomplete = {
    ...manifest,
    traceThroughSeq: 0,
    traceHash: hashObject([]),
  };
  await assert.rejects(
    f.contributor.call("_axp/review", {
      channel: f.c.exchange,
      manifest: incomplete,
      contributor: signObject(incomplete, key()),
    }),
    /include the current checkpoint/,
  );
  await assert.rejects(
    f.contributor.call("_axp/checkpoint", {
      channel: f.c.exchange,
      epoch: lease.epoch,
      checkpoint: state.checkpoint!,
      files: [
        {
          id: "secret",
          edit: { after: { uri: "file:///etc/passwd", content: ref } },
        },
      ],
    }),
    /File identity/,
  );
  await assert.rejects(
    f.contributor.call("_axp/review", {
      channel: f.c.exchange,
      manifest: { ...manifest, headCommit: "c".repeat(40) },
      contributor,
    }),
    /checkpoint/,
  );
  await f.contributor.call("_axp/review", {
    channel: f.c.exchange,
    manifest,
    contributor,
  });
  await assert.rejects(
    f.contributor.call("_axp/approveReview", {
      channel: f.c.exchange,
      signature: signObject(manifest, key()),
    }),
    /Maintainer/,
  );
  await f.maintainer.call("_axp/approveReview", {
    channel: f.c.exchange,
    signature: signObject(manifest, key()),
  });
  const verification = {
    channel: f.c.exchange,
    headCommit: manifest.headCommit,
    command: ["node", "--test"],
    exitCode: 0,
    output: ref,
  };
  await assert.rejects(
    f.contributor.call("_axp/verify", verification),
    /verifier/,
  );
  await f.verifier.call("_axp/verify", verification);
  const reviewed = await f.observer.snapshot<ExchangeState>(f.c.exchange);
  assert.ok(reviewed.review?.maintainer);
  assert.equal(reviewed.verification?.headCommit, manifest.headCommit);
});

test("prefix affinity isolates repository, model and runtime; misses remain explicit", async () => {
  const identity = {
    repository: "repo",
    baseCommit: "a".repeat(40),
    model: "qwen",
    tokenizer: "tok-v1",
    template: "chat-v1",
    runtime: "mtplx",
    format: "kv-v1",
  };
  const bank = new SessionBank();
  const key = cacheKey(identity, "exact prefix");
  assert.deepEqual(await bank.lookup(key, identity), {
    hit: false,
    cachedTokens: 0,
  });
  bank.remember(key, identity, "local-only-handle", 123);
  assert.equal((await bank.lookup(key, identity)).cachedTokens, 123);
  for (const changed of [
    "repository",
    "model",
    "runtime",
    "format",
    "tokenizer",
    "template",
    "baseCommit",
  ] as const)
    assert.equal(
      (await bank.lookup(key, { ...identity, [changed]: "different" })).hit,
      false,
    );
  assert.notEqual(cacheKey(identity, "exact prefix "), key);
  bank.invalidate(key);
  assert.equal((await bank.lookup(key, identity)).hit, false);
});
