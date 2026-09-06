import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import { request } from "node:http";
import { setup, prompt, dock, eventually } from "./helpers.js";
import { WorkspaceServer } from "../src/workspace.js";
import type {
  WorkspaceView,
  ContributionDetail,
  WorkspaceCommand,
} from "../src/workspace-contract.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { faultProxy } from "./fault-proxy.js";
import { workspaceFixture } from "./workspace-fixture.js";
import { ActionType } from "@microsoft/agent-host-protocol";

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

test("streaming updates converge in the gateway without downloading another full snapshot", async (t) => {
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
  const session = f.c.exchange.slice("axp-session:/".length);
  const read = async () =>
    (
      await fetch(`${link.origin}/api/contribution?session=${session}`, {
        headers,
      })
    ).json() as Promise<ContributionDetail>;
  await read();
  const before = proxy.requests.filter((m) => m === "subscribe").length;
  const lease = await dock(f.contributor, f.c.exchange);
  const turn = prompt();
  await f.maintainer.dispatch(f.c.chat, turn);
  await f.contributor.call("_axp/reserve", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    turnId: turn.turnId,
    ceiling: { tokens: 1000, costMicros: 0, turns: 1 },
  });
  await f.contributor.call("_axp/emit", {
    channel: f.c.exchange,
    epoch: lease.epoch,
    actions: [
      {
        type: ActionType.ChatResponsePart,
        turnId: turn.turnId,
        part: { kind: "markdown", id: "text", content: "" },
      },
    ],
  });
  for (let i = 0; i < 100; i++)
    await f.contributor.call("_axp/emit", {
      channel: f.c.exchange,
      epoch: lease.epoch,
      actions: [
        {
          type: ActionType.ChatDelta,
          turnId: turn.turnId,
          partId: "text",
          content: "x",
        },
      ],
    });
  const view = await eventually(
    read,
    (view) =>
      view.chat.activeTurn?.responseParts.some(
        (p) => p.kind === "markdown" && p.content === "x".repeat(100),
      ) ?? false,
  );
  assert.deepEqual(view.chat, await f.maintainer.snapshot(f.c.chat));
  assert.equal(proxy.requests.filter((m) => m === "subscribe").length, before);
});

test("workspace retries retain an approved permission and signed manifest after lost host replies", async (t) => {
  const f = await workspaceFixture();
  t.after(f.close);
  const proxy = await faultProxy(f.url);
  t.after(proxy.close);
  const open = async (role: "maintainer" | "contributor") => {
    const key = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const server = new WorkspaceServer({
      url: proxy.url,
      token: f.credentials.find((c) => c.principal.role === role)!.token,
      signingKey: key,
    });
    const link = new URL(await server.listen());
    t.after(() => server.close());
    return (command: WorkspaceCommand) =>
      fetch(`${link.origin}/api/command`, {
        method: "POST",
        headers: {
          origin: link.origin,
          authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("access")!}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
      });
  };
  const maintain = await open("maintainer");
  const permission: WorkspaceCommand = {
    operationId: randomUUID(),
    startedAt: new Date().toISOString(),
    session: "first-run",
    action: {
      kind: "permission",
      turnId: "demo-1",
      toolId: "edit-welcome",
      optionId: "allow-once",
    },
  };
  proxy.dropReplyTo("_axp/dispatch");
  assert.equal((await maintain(permission)).status, 503);
  await f.maintainer.dispatch("ahp-chat:/first-run", {
    type: ActionType.ChatTurnCancelled,
    turnId: "demo-1",
    duration: 0,
  });
  const retried = await maintain(permission);
  assert.equal(retried.status, 200, await retried.text());
  assert.equal(
    (
      await maintain({
        ...permission,
        action: {
          kind: "permission",
          turnId: "demo-1",
          toolId: "edit-welcome",
          optionId: "deny",
        },
      })
    ).status,
    409,
  );
  const contribute = await open("contributor");
  const submit: WorkspaceCommand = {
    operationId: randomUUID(),
    startedAt: new Date().toISOString(),
    session: "parser-errors",
    action: { kind: "submit", checkpoint: "b".repeat(40), model: "fixture" },
  };
  proxy.dropReplyTo("_axp/review");
  assert.equal((await contribute(submit)).status, 503);
  const before = await f.contributor.snapshot<ExchangeState>(
    "axp-session:/parser-errors",
  );
  await f.maintainer.call("_axp/comment", {
    channel: "axp-session:/parser-errors",
    body: "History advanced after the signed submission.",
    checkpoint: null,
    path: null,
  });
  assert.equal((await contribute(submit)).status, 200);
  assert.deepEqual(
    (await f.contributor.snapshot<ExchangeState>("axp-session:/parser-errors"))
      .review,
    before.review,
  );
});

test("stored browser content is bounded, downloaded as an attachment, and scoped to its session", async (t) => {
  const f = await setup();
  t.after(f.close);
  const server = new WorkspaceServer({
    url: f.url,
    token: f.credentials[2]!.token,
  });
  const link = new URL(await server.listen());
  t.after(() => server.close());
  const headers = {
    authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("access")!}`,
  };
  const content = "<script>not executed</script>" + "x".repeat(70000);
  const blob = await f.contributor.call("_axp/blobPut", {
    channel: f.c.exchange,
    data: Buffer.from(content).toString("base64"),
    mediaType: "text/plain",
  });
  const query = `session=${f.c.exchange.slice("axp-session:/".length)}&digest=${blob.sha256}`;
  const preview = (await (
    await fetch(`${link.origin}/api/content?${query}`, { headers })
  ).json()) as { text: string; truncated: boolean };
  assert.equal(preview.text.length, 64000);
  assert.equal(preview.truncated, true);
  const download = await fetch(`${link.origin}/api/download?${query}`, {
    headers,
  });
  assert.match(download.headers.get("content-disposition")!, /^attachment/);
  assert.equal(
    download.headers.get("content-type"),
    "application/octet-stream",
  );
  assert.equal(await download.text(), content);
  await f.maintainer.ahp.request("createSession", {
    channel: "ahp-session:/empty",
  });
  assert.equal(
    (
      await fetch(
        `${link.origin}/api/content?session=empty&digest=${blob.sha256}`,
        { headers },
      )
    ).status,
    404,
  );
});
