import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { request } from "node:http";
import { setup, prompt } from "./helpers.js";
import { WorkspaceServer } from "../src/workspace.js";
import type { WorkspaceView } from "../src/workspace-contract.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { faultProxy } from "./fault-proxy.js";

test("workspace gateway keeps credentials private, rejects hostile origins and preserves host role authority", async (t) => {
  const f = await setup();
  t.after(f.close);
  const server = new WorkspaceServer({
    url: f.url,
    token: f.credentials[2]!.token,
    assets: resolve("dist/ui"),
  });
  const link = new URL(await server.listen());
  t.after(() => server.close());
  const access = new URLSearchParams(link.hash.slice(1)).get("access")!;
  const headers = {
    authorization: `Bearer ${access}`,
    origin: link.origin,
    "content-type": "application/json",
  };
  assert.equal((await fetch(`${link.origin}/api/workspace`)).status, 403);
  assert.equal(
    (
      await fetch(`${link.origin}/api/workspace`, {
        headers: { ...headers, origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const hostileHost = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = request(
        `${link.origin}/api/workspace`,
        { headers: { ...headers, host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(hostileHost, 403);
  const view = (await (
    await fetch(`${link.origin}/api/workspace`, { headers })
  ).json()) as WorkspaceView;
  assert.equal(view.principal.role, "observer");
  assert.equal(view.total, 1);
  assert.ok(!JSON.stringify(view).includes(f.credentials[2]!.token));
  const command = {
    session: f.c.session.slice("ahp-session:/".length),
    operationId: randomUUID(),
    startedAt: new Date().toISOString(),
    action: { kind: "prompt", mode: "start", text: "Run untrusted work" },
  };
  assert.equal(
    (
      await fetch(`${link.origin}/api/command`, {
        headers,
        method: "POST",
        body: JSON.stringify(command),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${link.origin}/api/command`, {
        headers: {
          authorization: headers.authorization,
          "content-type": "application/json",
        },
        method: "POST",
        body: JSON.stringify(command),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${link.origin}/api/command`, {
        headers,
        method: "POST",
        body: JSON.stringify({
          ...command,
          action: { kind: "rpc", method: "_axp/grant" },
        }),
      })
    ).status,
    400,
  );
});

test("workspace cached views require real host contact and recover after a silent WebSocket stall", async (t) => {
  const f = await setup();
  t.after(f.close);
  const proxy = await faultProxy(f.url);
  t.after(proxy.close);
  const server = new WorkspaceServer({
    url: proxy.url,
    token: f.credentials[0]!.token,
  });
  const link = new URL(await server.listen());
  t.after(() => server.close());
  const headers = {
    authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("access")!}`,
  };
  const read = () => fetch(`${link.origin}/api/workspace`, { headers });
  assert.equal((await read()).status, 200);
  const subscriptions = proxy.requests.filter(
    (method) => method === "subscribe",
  ).length;
  assert.equal((await read()).status, 200);
  assert.equal(
    proxy.requests.filter((method) => method === "subscribe").length,
    subscriptions,
    "unchanged views reuse their live subscriptions",
  );
  proxy.pause(true);
  assert.equal(
    (await read()).status,
    503,
    "a responsive local gateway must not mask a silent host",
  );
  proxy.pause(false);
  const recovered = (await (await read()).json()) as WorkspaceView;
  assert.equal(recovered.total, 1);
});

test("discussion has host-authored identity, scoped access, stable retry receipts and checkpoint binding", async (t) => {
  const f = await setup();
  t.after(f.close);
  const comment = {
    channel: f.c.exchange,
    body: "I can help review this.",
    checkpoint: null,
    path: null,
    operationId: randomUUID(),
  };
  const posted = await f.contributor.call("_axp/comment", comment);
  assert.equal(posted.author, "contributor");
  assert.deepEqual(await f.contributor.call("_axp/comment", comment), posted);
  await assert.rejects(
    f.contributor.call("_axp/comment", { ...comment, body: "Changed retry" }),
    /different input/,
  );
  await assert.rejects(
    f.observer.call("_axp/comment", { ...comment, operationId: randomUUID() }),
    /Observers/,
  );
  await assert.rejects(
    f.contributor.call("_axp/comment", {
      ...comment,
      operationId: randomUUID(),
      checkpoint: "a".repeat(40),
    }),
    /checkpoint changed/,
  );
  await assert.rejects(
    f.contributor.call("_axp/comment", {
      ...comment,
      operationId: randomUUID(),
      path: "parser.ts",
    }),
    /checkpoint/,
  );
  const state = await f.maintainer.snapshot<ExchangeState>(f.c.exchange);
  assert.equal(state.discussion?.length, 1);
  const archive = await f.observer.call("_axp/export", {
    channel: f.c.exchange,
  });
  assert.ok(
    archive.actions.some(
      (event) =>
        event.action.type === "_axp/commentAdded" &&
        event.action.comment.author === "contributor",
    ),
  );
  await f.maintainer.dispatch(f.c.chat, prompt());
  await f.contributor.call("_axp/comment", {
    ...comment,
    operationId: randomUUID(),
    body: "Discussion stays independent of the running agent.",
  });
  assert.equal(
    (await f.maintainer.snapshot<ExchangeState>(f.c.exchange)).discussion
      ?.length,
    2,
  );
});
