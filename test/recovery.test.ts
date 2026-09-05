import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { chatReducer } from "@microsoft/agent-host-protocol";
import type { ChatState, ChatAction } from "@microsoft/agent-host-protocol";
import { SocketTransport } from "../src/transport.js";
import { AxpClient } from "../src/client.js";
import { Hub } from "../src/hub.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { setup, dock, prompt } from "./helpers.js";

test("unmodified AHP client reconnects by replay and snapshot with convergent reducers", async (t) => {
  const f = await setup({ replayLimit: 100 });
  t.after(f.close);
  const initial = await f.observer.snapshot<ChatState>(f.c.chat);
  const cursor = f.hub.store.seq;
  const action = prompt();
  await f.maintainer.dispatch(f.c.chat, action);
  const transport = await SocketTransport.connect(
    f.url,
    f.credentials[2]!.token,
  );
  const native = new AhpClient(transport);
  native.connect();
  t.after(() => native.shutdown());
  const result = await native.reconnect({
    clientId: randomUUID(),
    lastSeenServerSeq: cursor,
    subscriptions: [f.c.chat, "ahp-session:/missing"],
  });
  assert.equal(result.type, "replay");
  if (result.type !== "replay") return;
  assert.deepEqual(result.missing, ["ahp-session:/missing"]);
  const rebuilt = result.actions.reduce(
    (s, e) => chatReducer(s, e.action as ChatAction),
    initial,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(rebuilt)),
    await f.observer.snapshot<ChatState>(f.c.chat),
  );
  const snapshotTransport = await SocketTransport.connect(
    f.url,
    f.credentials[2]!.token,
  );
  const snapshotClient = new AhpClient(snapshotTransport);
  snapshotClient.connect();
  t.after(() => snapshotClient.shutdown());
  f.hub.options.replayLimit = 0;
  const fresh = await snapshotClient.reconnect({
    clientId: randomUUID(),
    lastSeenServerSeq: 0,
    subscriptions: [f.c.chat],
  });
  assert.equal(fresh.type, "snapshot");
});

test("restart preserves receipts and checkpoints but interrupts and fences old execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "axp-durable-"));
  let cleanup = async () => {};
  t.after(async () => {
    try {
      await cleanup();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const f = await setup({ database: join(directory, "state.db") });
  cleanup = f.close;
  const lease = await dock(f.contributor, f.c.exchange);
  const turn = prompt();
  await f.maintainer.dispatch(f.c.chat, turn);
  const reservation = {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    ceiling: { tokens: 1234, costMicros: 4321, turns: 1 },
    operationId: "reserve-durable",
  };
  await f.contributor.call("_axp/reserve", reservation);
  const seq = f.hub.store.seq;
  await f.close();
  cleanup = async () => {};
  const hub = new Hub({
    repository: "example/project",
    credentials: f.credentials,
    database: join(directory, "state.db"),
  });
  const url = await hub.listen();
  cleanup = () => hub.close();
  const client = await AxpClient.connect(url, f.credentials[1]!.token);
  cleanup = async () => {
    await client.close();
    await hub.close();
  };
  const state = await client.snapshot<ExchangeState>(f.c.exchange);
  assert.equal(state.status, "orphaned");
  assert.equal(state.lease, null);
  assert.equal(state.grants.donation?.spent.tokens, 1234);
  assert.ok(hub.store.seq > seq);
  await client.call("_axp/reserve", reservation);
  assert.equal(
    (await client.snapshot<ExchangeState>(f.c.exchange)).reservation,
    null,
    "receipt replay must not reserve again",
  );
  await assert.rejects(
    client.call("_axp/reserve", {
      ...reservation,
      ceiling: { ...reservation.ceiling, tokens: 1 },
    }),
    /different input/,
  );
  await assert.rejects(
    client.call("_axp/renew", { channel: f.c.exchange, epoch: lease.epoch }),
    /stale/,
  );
});

test("client identities and blob references cannot cross authorization scopes", async (t) => {
  const f = await setup();
  t.after(f.close);
  await assert.rejects(AxpClient.connect(f.url, "x".repeat(64)), /401/);
  await assert.rejects(
    AxpClient.connect(f.url, f.credentials[1]!.token, f.maintainer.clientId),
    /another principal/,
  );
  const blob = await f.contributor.call("_axp/blobPut", {
    channel: f.c.exchange,
    data: Buffer.from("private output").toString("base64"),
    mediaType: "text/plain",
  });
  const other = `ahp-session:/${randomUUID()}`;
  await f.maintainer.ahp.request("createSession", {
    channel: other,
    provider: "axp",
  });
  await assert.rejects(
    f.observer.call("_axp/blobGet", { channel: other, digest: blob.sha256 }),
    /not found/,
  );
  await assert.rejects(f.observer.snapshot("axp-memory://"), /Maintainer/);
  await assert.rejects(
    f.observer.call("_axp/blobPut", {
      channel: f.c.exchange,
      data: "",
      mediaType: "text/plain",
    }),
    /Observers/,
  );
  await assert.rejects(
    f.contributor.call("_axp/blobPut", {
      channel: f.c.exchange,
      data: "not base64!",
      mediaType: "text/plain",
    }),
    /base64/,
  );
});
