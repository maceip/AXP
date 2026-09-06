import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub } from "../src/hub.js";
import { Store } from "../src/store.js";
import { AxpClient } from "../src/client.js";
import { ActionType } from "@microsoft/agent-host-protocol";
import { setup, prompt } from "./helpers.js";
import { actionFrom } from "../src/validation.js";

test("database identity survives empty-host restart and rejects a different repository without retaining its lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "axp-identity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    repository: "original/project",
    database: join(directory, "hub.db"),
    credentials: [
      {
        token: randomBytes(32).toString("hex"),
        principal: {
          id: "owner",
          role: "maintainer" as const,
          sessions: "*" as const,
        },
      },
    ],
  };
  const first = new Hub(options);
  await first.close();
  assert.throws(
    () => new Hub({ ...options, repository: "wrong/project" }),
    /another repository/,
  );
  const reopened = new Hub(options);
  await reopened.listen();
  await Promise.all([reopened.close(), reopened.close()]);
});

test("failed transaction establishment does not poison subsequent writes or roll back a caller transaction", () => {
  const store = new Store();
  try {
    store.db.exec("BEGIN IMMEDIATE");
    assert.throws(() => store.transaction(() => null), /transaction/);
    assert.equal(store.db.isTransaction, true);
    store.db.exec("ROLLBACK");
    store.transaction((tx) => tx.create("axp-session:/test", { ok: true }));
    assert.deepEqual(store.get("axp-session:/test"), { ok: true });
  } finally {
    store.close();
  }
});

test("reusing a stable client identity continues dispatch receipts instead of colliding with an earlier sequence", async (t) => {
  const f = await setup();
  t.after(f.close);
  const first = await AxpClient.connect(
    f.url,
    f.credentials[0]!.token,
    "stable-client",
  );
  const turn = prompt();
  await first.dispatch(f.c.chat, turn);
  await first.close();
  const second = await AxpClient.connect(
    f.url,
    f.credentials[0]!.token,
    "stable-client",
  );
  t.after(() => second.close());
  await second.dispatch(f.c.chat, {
    type: ActionType.ChatTurnCancelled,
    turnId: turn.turnId,
    duration: 0,
  });
  const archive = await second.call("_axp/export", { channel: f.c.exchange });
  assert.equal(
    archive.actions.filter(
      (e) => e.action.type === ActionType.ChatTurnCancelled,
    ).length,
    1,
  );
});

test("a full blob quota permits physical deduplication while keeping session access explicit", async (t) => {
  const f = await setup({ maxStorageBytes: 4 });
  t.after(f.close);
  const input = {
    channel: f.c.exchange,
    data: Buffer.from("same").toString("base64"),
    mediaType: "text/plain",
  };
  const blob = await f.contributor.call("_axp/blobPut", input);
  assert.deepEqual(await f.contributor.call("_axp/blobPut", input), blob);
  await f.maintainer.ahp.request("createSession", {
    channel: "ahp-session:/other",
    provider: "axp",
  });
  await assert.rejects(
    f.contributor.call("_axp/blobGet", {
      channel: "axp-session:/other",
      digest: blob.sha256,
    }),
    /not found/,
  );
  await f.contributor.call("_axp/blobPut", {
    ...input,
    channel: "axp-session:/other",
  });
  assert.equal(
    (
      await f.contributor.call("_axp/blobGet", {
        channel: "axp-session:/other",
        digest: blob.sha256,
      })
    ).data,
    input.data,
  );
  await assert.rejects(
    f.contributor.call("_axp/blobPut", {
      ...input,
      data: Buffer.from("more").toString("base64"),
    }),
    /quota/,
  );
});

test("AHP summaries retain their creation timestamp and discriminated action validation remains strict", async (t) => {
  let now = 100000;
  const f = await setup({ now: () => now });
  t.after(f.close);
  const before = (
    await f.maintainer.ahp.request("listSessions", { channel: "ahp-root://" })
  ).items[0]!;
  assert.equal(before.createdAt, new Date(now).toISOString());
  now += 1000;
  await f.maintainer.dispatch(f.c.chat, prompt());
  const after = (
    await f.maintainer.ahp.request("listSessions", { channel: "ahp-root://" })
  ).items[0]!;
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.modifiedAt, new Date(now).toISOString());
  assert.throws(
    () =>
      actionFrom({
        type: ActionType.ChatDelta,
        content: "missing required IDs",
      }),
    /Invalid AHP action/,
  );
  assert.throws(
    () => actionFrom({ type: "invented/action" }),
    /unknown action type/,
  );
});
