import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  ActionType,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
  PendingMessageKind,
  MessageKind,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { Satellite } from "../src/satellite.js";
import { Hub } from "../src/hub.js";
import { AxpClient } from "../src/client.js";
import type { AgentLaunch } from "../src/acp.js";
import { Worktree } from "../src/git.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { setup, prompt, eventually, dock } from "./helpers.js";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { hashObject, signObject } from "../src/hash.js";
import { faultProxy } from "./fault-proxy.js";
import { setTimeout as delay } from "node:timers/promises";

import { repository } from "./project-fixture.js";

const exec = promisify(execFile);
function agent(delayMs = 0): AgentLaunch {
  const image = process.env.AXP_TEST_CONTAINER;
  return image
    ? {
        command: "node",
        args: [
          "--import",
          "/agent/node_modules/tsx/dist/loader.mjs",
          "/agent/examples/fixture-agent.ts",
          `--delay-ms=${delayMs}`,
        ],
        isolation: "container",
        image,
      }
    : {
        command: process.execPath,
        args: [
          "--import",
          pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
          resolve("examples/fixture-agent.ts"),
          `--delay-ms=${delayMs}`,
        ],
        isolation: "native",
      };
}

test("a planning-only checkpoint restores the exact base and local state is excluded without a tracked ignore rule", async (t) => {
  const f = await setup();
  const repo = await repository();
  t.after(async () => {
    await f.close();
    await rm(repo, { recursive: true, force: true });
  });
  await rm(join(repo, ".gitignore"));
  const lease = await dock(f.contributor, f.c.exchange);
  const tree = await Worktree.create(repo, "planning");
  const cp = await tree.checkpoint(f.contributor, f.c.exchange, lease.epoch);
  assert.equal(cp.baseCommit, cp.headCommit);
  const blob = await f.contributor.call("_axp/blobGet", {
    channel: f.c.exchange,
    digest: cp.bundle.sha256,
  });
  const restored = await Worktree.restore(
    repo,
    "planning-restored",
    cp,
    Buffer.from(blob.data, "base64"),
  );
  assert.equal(
    (
      await exec("git", ["rev-parse", "HEAD"], { cwd: restored.path })
    ).stdout.trim(),
    cp.headCommit,
  );
  const status = await exec("git", ["status", "--porcelain"], { cwd: repo });
  assert.match(status.stdout, / D .gitignore/);
  assert.doesNotMatch(status.stdout, /\.axp/);
});

test(
  "a real ACP process edits an isolated worktree, asks the maintainer, tests and exports a portable Git checkpoint",
  { timeout: 30_000 },
  async (t) => {
    const f = await setup();
    const repo = await repository();
    const faults: Error[] = [];
    const satellite = new Satellite({
      url: f.url,
      token: f.credentials[1]!.token,
      session: f.c.exchange,
      repository: repo,
      agent: agent(),
      allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
    });
    satellite.on("fault", (error) => {
      faults.push(error);
      t.diagnostic(error.message);
    });
    t.after(async () => {
      await satellite.stop();
      await f.close();
      await rm(repo, { recursive: true, force: true });
    });
    await satellite.start();
    const action = prompt("Fix addition.");
    await f.maintainer.dispatch(f.c.chat, action);
    const waiting = await eventually(
      () => f.maintainer.snapshot<ChatState>(f.c.chat),
      (s) =>
        s.activeTurn?.responseParts.some(
          (p) =>
            p.kind === "toolCall" &&
            p.toolCall.status === "pending-confirmation",
        ) ?? false,
      10_000,
    );
    const tool = waiting.activeTurn!.responseParts.find(
      (p) => p.kind === "toolCall",
    );
    assert.ok(tool?.kind === "toolCall");
    await f.maintainer.close();
    const detached = await f.observer.snapshot<ChatState>(f.c.chat);
    assert.equal(detached.activeTurn?.id, action.turnId);
    assert.equal(
      (await readFile(join(satellite.worktree.path, "sum.js"), "utf8")).trim(),
      "export const sum = (a, b) => a - b;",
      "detaching the maintainer must not approve a pending tool",
    );
    f.maintainer = await AxpClient.connect(f.url, f.credentials[0]!.token);
    f.clients.push(f.maintainer);
    await f.maintainer.dispatch(f.c.chat, {
      type: ActionType.ChatToolCallConfirmed,
      turnId: action.turnId,
      toolCallId: tool.toolCall.toolCallId,
      approved: true,
      confirmed: ToolCallConfirmationReason.UserAction,
      selectedOptionId: "allow-once",
    });
    const done = await eventually(
      () => f.maintainer.snapshot<ExchangeState>(f.c.exchange),
      (s) => !!s.checkpoint && !s.reservation,
      10_000,
    );
    assert.equal(faults.length, 0);
    assert.ok(done.checkpoint);
    assert.equal(
      Object.values(done.grants)[0]?.spent.tokens,
      130,
      "normalize ACP cache-exclusive input without losing or double-counting tokens",
    );
    assert.equal(
      (await readFile(join(repo, "sum.js"), "utf8")).trim(),
      "export const sum = (a, b) => a - b;",
    );
    assert.equal(
      (await readFile(join(satellite.worktree.path, "sum.js"), "utf8")).trim(),
      "export const sum = (a, b) => a + b;",
    );
    const blob = await f.contributor.call("_axp/blobGet", {
      channel: f.c.exchange,
      digest: done.checkpoint.bundle.sha256,
    });
    const independent = join(repo, ".axp", "independent-clone");
    await exec("git", [
      "clone",
      "--no-local",
      "--single-branch",
      "--branch",
      "main",
      repo,
      independent,
    ]);
    await assert.rejects(
      exec("git", ["cat-file", "-e", done.checkpoint.headCommit], {
        cwd: independent,
      }),
      "the receiver must not already possess the contributed commit",
    );
    const replacement = await Worktree.restore(
      independent,
      "restored",
      done.checkpoint,
      Buffer.from(blob.data, "base64"),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const tested = await exec(process.execPath, ["--test"], {
      cwd: replacement.path,
      env,
    });
    assert.match(tested.stdout, /pass 1/);
    await satellite.exportHistory();
    const exportFile = join(
      repo,
      ".axp",
      "history",
      `${f.c.exchange.slice("axp-session:/".length)}.json`,
    );
    const archive = JSON.parse(await readFile(exportFile, "utf8")) as {
      actions: unknown[];
    };
    assert.ok(archive.actions.length > 10);
    const evidence = await f.contributor.call("_axp/export", {
      channel: f.c.exchange,
    });
    const manifest = {
      version: 1 as const,
      repository: done.repository,
      session: done.session,
      baseCommit: done.checkpoint.baseCommit,
      headCommit: done.checkpoint.headCommit,
      model: "fixture",
      promptHash: hashObject(action.message),
      traceHash: hashObject(
        evidence.actions.filter((e) => e.channel !== f.c.changeset),
      ),
      traceThroughSeq: evidence.serverSeq,
      checkpointDigest: hashObject(done.checkpoint),
    };
    const key = () =>
      generateKeyPairSync("ed25519")
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
    const review = await f.contributor.call("_axp/review", {
      channel: f.c.exchange,
      manifest,
      contributor: signObject(manifest, key()),
    });
    const fork = join(repo, ".axp", "fork.git");
    await exec("git", ["init", "--bare", fork]);
    await exec("git", ["remote", "add", "contributor-fork", fork], {
      cwd: repo,
    });
    await assert.rejects(
      satellite.worktree.publish("contributor-fork", review),
      /Both contributor and maintainer/,
    );
    const accepted = await f.maintainer.call("_axp/approveReview", {
      channel: f.c.exchange,
      signature: signObject(manifest, key()),
    });
    await satellite.worktree.publish("contributor-fork", accepted);
    const refs = await exec("git", ["--git-dir", fork, "show-ref"]);
    assert.equal(
      refs.stdout.trim(),
      `${done.checkpoint.headCommit} refs/heads/${satellite.worktree.branch}`,
    );
  },
);

test(
  "heartbeat survives a long tool; denial and steering cancel ACP and preserve subsequent permission routing",
  { timeout: 35_000 },
  async (t) => {
    const f = await setup();
    const repo = await repository();
    const faults: Error[] = [];
    const satellite = new Satellite({
      url: f.url,
      token: f.credentials[1]!.token,
      session: f.c.exchange,
      repository: repo,
      agent: agent(4000),
      leaseMs: 3000,
      allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
    });
    satellite.on("fault", (e) => {
      faults.push(e);
      t.diagnostic(e.message);
    });
    t.after(async () => {
      await satellite.stop();
      await f.close();
      await rm(repo, { recursive: true, force: true });
    });
    await satellite.start();
    const waiting = () =>
      eventually(
        () => f.maintainer.snapshot<ChatState>(f.c.chat),
        (s) =>
          s.activeTurn?.responseParts.some(
            (p) =>
              p.kind === "toolCall" &&
              p.toolCall.status === "pending-confirmation",
          ) ?? false,
        10_000,
      );
    const decide = async (approve: boolean) => {
      const s = await waiting();
      const part = s.activeTurn!.responseParts.find(
        (p) => p.kind === "toolCall",
      );
      assert.ok(part?.kind === "toolCall");
      const base = {
        type: ActionType.ChatToolCallConfirmed,
        turnId: s.activeTurn!.id,
        toolCallId: part.toolCall.toolCallId,
      } as const;
      await f.maintainer.dispatch(
        f.c.chat,
        approve
          ? {
              ...base,
              approved: true,
              confirmed: ToolCallConfirmationReason.UserAction,
              selectedOptionId: "allow-once",
            }
          : {
              ...base,
              approved: false,
              reason: ToolCallCancellationReason.Denied,
              selectedOptionId: "deny-once",
            },
      );
    };
    await f.maintainer.dispatch(f.c.chat, prompt("First, denied"));
    await decide(false);
    await eventually(
      () => f.maintainer.snapshot<ChatState>(f.c.chat),
      (s) => s.turns.length === 1 && !s.activeTurn,
    );
    assert.equal(
      (await f.maintainer.snapshot<ExchangeState>(f.c.exchange)).checkpoint,
      null,
    );
    await f.maintainer.dispatch(
      f.c.chat,
      prompt("This task will be superseded"),
    );
    await waiting();
    await f.maintainer.dispatch(f.c.chat, {
      type: ActionType.ChatPendingMessageSet,
      kind: PendingMessageKind.Steering,
      id: randomUUID(),
      message: { text: "Fix addition now", origin: { kind: MessageKind.User } },
    });
    await decide(true);
    const done = await eventually(
      () => f.maintainer.snapshot<ChatState>(f.c.chat),
      (s) => s.turns.length === 3 && !s.activeTurn,
      15_000,
    );
    assert.equal(done.turns.at(-1)?.message.text, "Fix addition now");
    const state = await f.maintainer.snapshot<ExchangeState>(f.c.exchange);
    assert.equal(
      state.epoch,
      1,
      "the four-second tool must outlive the original three-second lease through renewal",
    );
    assert.equal(state.usage.length, 3);
    assert.ok(state.checkpoint);
    assert.equal(faults.length, 0);
  },
);

test(
  "lost grant and claim replies recover one donation, retain local edits and never replay an interrupted permission",
  { timeout: 30_000 },
  async (t) => {
    const f = await setup();
    const repo = await repository();
    const proxy = await faultProxy(f.url);
    const faults: Error[] = [];
    const satellite = new Satellite({
      url: proxy.url,
      token: f.credentials[1]!.token,
      session: f.c.exchange,
      repository: repo,
      agent: agent(),
      leaseMs: 3000,
      allowance: { tokens: 2000, costMicros: 20_000, turns: 2 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
      reconnect: { initialDelayMs: 30, maxDelayMs: 100 },
    });
    satellite.on("fault", (error) => faults.push(error));
    t.after(async () => {
      await satellite.stop();
      await proxy.close();
      await f.close();
      await rm(repo, { recursive: true, force: true });
    });
    proxy.dropReplyTo("_axp/grant");
    const parking = satellite.start();
    await eventually(
      () => f.maintainer.snapshot<ExchangeState>(f.c.exchange),
      (s) => !!s.lease,
    );
    const first = prompt("Ask before editing.");
    await f.maintainer.dispatch(f.c.chat, first);
    await parking;
    const tree = satellite.worktree;
    await permissionPending(f.maintainer, f.c.chat);
    await writeFile(join(tree.path, "retained.txt"), "Unuploaded local work\n");
    proxy.dropReplyTo("_axp/claim");
    proxy.cut();
    const recovered = await eventually(
      () => f.maintainer.snapshot<ExchangeState>(f.c.exchange),
      (s) => s.epoch === 3 && satellite.state === "parked",
      10_000,
    );
    assert.equal(satellite.worktree, tree);
    assert.equal(
      await readFile(join(tree.path, "retained.txt"), "utf8"),
      "Unuploaded local work\n",
    );
    assert.equal(Object.keys(recovered.grants).length, 1);
    assert.deepEqual(recovered.grants[satellite.executorId]?.spent, {
      tokens: 1000,
      costMicros: 10_000,
      turns: 1,
    });
    assert.equal(recovered.usage.length, 1);
    assert.equal(recovered.usage[0]?.usage.source, "reservation");
    const interrupted = await f.maintainer.snapshot<ChatState>(f.c.chat);
    assert.equal(interrupted.activeTurn, undefined);
    assert.equal(interrupted.turns.length, 1);
    assert.equal(interrupted.turns[0]?.id, first.turnId);
    assert.equal(
      proxy.requests.filter((method) => method === "_axp/reserve").length,
      1,
    );
    assert.equal(faults.length, 0);

    await f.maintainer.dispatch(
      f.c.chat,
      prompt("Continue with the retained files and fix addition."),
    );
    const pending = await permissionPending(f.maintainer, f.c.chat);
    await allow(f.maintainer, f.c.chat, pending);
    const done = await eventually(
      () => f.maintainer.snapshot<ExchangeState>(f.c.exchange),
      (s) => !!s.checkpoint && s.usage.length === 2 && !s.reservation,
      10_000,
    );
    assert.equal(done.grants[satellite.executorId]?.spent.tokens, 1130);
    assert.deepEqual(
      done.grants[satellite.executorId]?.limit,
      satellite.options.allowance,
    );
    assert.equal(faults.length, 0);
    proxy.cut();
    await satellite.closed;
    assert.match(faults[0]?.message ?? "", /Donation limit reached/);
    const exhausted = await f.maintainer.snapshot<ExchangeState>(f.c.exchange);
    assert.equal(Object.keys(exhausted.grants).length, 1);
    assert.equal(exhausted.usage.length, 2);
    assert.equal(exhausted.lease, null);
    assert.deepEqual(
      exhausted.grants[satellite.executorId],
      done.grants[satellite.executorId],
    );
  },
);

test(
  "a half-open proxy cancels an approved ACP tool before reconnecting",
  { timeout: 25_000 },
  async (t) => {
    const f = await setup();
    const repo = await repository();
    const proxy = await faultProxy(f.url);
    const satellite = new Satellite({
      url: proxy.url,
      token: f.credentials[1]!.token,
      session: f.c.exchange,
      repository: repo,
      agent: agent(5000),
      leaseMs: 3000,
      allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
      reconnect: { initialDelayMs: 30, maxDelayMs: 100 },
    });
    const faults: Error[] = [];
    satellite.on("fault", (error) => faults.push(error));
    t.after(async () => {
      await satellite.stop();
      await proxy.close();
      await f.close();
      await rm(repo, { recursive: true, force: true });
    });
    await satellite.start();
    await f.maintainer.dispatch(
      f.c.chat,
      prompt("Fix addition after a long compile."),
    );
    await allow(
      f.maintainer,
      f.c.chat,
      await permissionPending(f.maintainer, f.c.chat),
    );
    await eventually(
      () => f.maintainer.snapshot<ChatState>(f.c.chat),
      (s) =>
        s.activeTurn?.responseParts.some(
          (p) => p.kind === "toolCall" && p.toolCall.status === "running",
        ) ?? false,
    );
    proxy.pause(true);
    await eventually(
      () => satellite.state,
      (s) => s === "reconnecting",
      4000,
    );
    proxy.pause(false);
    await eventually(
      () => satellite.state,
      (s) => s === "parked",
      5000,
    );
    // The old process would write sum.js after five seconds if cancellation or
    // process cleanup failed. It must not mutate the reused worktree later.
    await delay(5200);
    assert.match(
      await readFile(join(satellite.worktree.path, "sum.js"), "utf8"),
      /a - b/,
    );
    const state = await f.maintainer.snapshot<ExchangeState>(f.c.exchange);
    assert.equal(state.usage.length, 1);
    assert.equal(state.grants[satellite.executorId]?.spent.turns, 1);
    assert.equal(state.checkpoint, null);
    assert.equal(
      proxy.requests.filter((method) => method === "_axp/reserve").length,
      1,
    );
    assert.equal(faults.length, 0);
  },
);

test(
  "reconnection stops after donation revocation or an intervening owner, even after that owner releases",
  { timeout: 20_000 },
  async (t) => {
    for (const reason of ["revocation", "ownership"] as const)
      await t.test(reason, async (t) => {
        const f = await setup();
        const repo = await repository();
        const proxy = await faultProxy(f.url);
        const satellite = new Satellite({
          url: proxy.url,
          token: f.credentials[1]!.token,
          session: f.c.exchange,
          repository: repo,
          agent: agent(),
          leaseMs: 3000,
          allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
          perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
          reconnect: { initialDelayMs: 30, maxDelayMs: 100 },
        });
        const faults: Error[] = [];
        satellite.on("fault", (error) => faults.push(error));
        t.after(async () => {
          await satellite.stop();
          await proxy.close();
          await f.close();
          await rm(repo, { recursive: true, force: true });
        });
        await satellite.start();
        const tree = satellite.worktree;
        await writeFile(
          join(tree.path, "retained.txt"),
          "Keep this local work\n",
        );
        proxy.setAvailable(false);
        proxy.cut();
        await eventually(
          () => satellite.state,
          (s) => s === "reconnecting",
        );
        if (reason === "revocation")
          await f.contributor.call("_axp/revoke", {
            channel: f.c.exchange,
            grantId: satellite.executorId,
          });
        else {
          await f.contributor.call("_axp/release", {
            channel: f.c.exchange,
            epoch: satellite.lease.epoch,
          });
          const replacement = await dock(f.contributor, f.c.exchange);
          await f.contributor.call("_axp/release", {
            channel: f.c.exchange,
            epoch: replacement.epoch,
          });
        }
        const before = await f.maintainer.snapshot<ExchangeState>(f.c.exchange);
        proxy.setAvailable(true);
        await satellite.closed;
        assert.equal(faults.length, 1);
        assert.match(
          faults[0]!.message,
          reason === "revocation" ? /active donation/ : /ownership changed/,
        );
        assert.equal(
          await readFile(join(tree.path, "retained.txt"), "utf8"),
          "Keep this local work\n",
        );
        assert.deepEqual(
          await f.maintainer.snapshot<ExchangeState>(f.c.exchange),
          before,
        );
      });
  },
);

async function permissionPending(client: AxpClient, channel: string) {
  return eventually(
    () => client.snapshot<ChatState>(channel),
    (s) =>
      s.activeTurn?.responseParts.some(
        (p) =>
          p.kind === "toolCall" && p.toolCall.status === "pending-confirmation",
      ) ?? false,
    10_000,
  );
}
async function allow(client: AxpClient, channel: string, state: ChatState) {
  const part = state.activeTurn?.responseParts.find(
    (p) =>
      p.kind === "toolCall" && p.toolCall.status === "pending-confirmation",
  );
  assert.ok(state.activeTurn && part?.kind === "toolCall");
  await client.dispatch(channel, {
    type: ActionType.ChatToolCallConfirmed,
    turnId: state.activeTurn.id,
    toolCallId: part.toolCall.toolCallId,
    approved: true,
    confirmed: ToolCallConfirmationReason.UserAction,
    selectedOptionId: "allow-once",
  });
}

test(
  "a parked contributor reconnects after a durable host restart with its existing donation and worktree",
  { timeout: 20_000 },
  async (t) => {
    const repo = await repository();
    const directory = await mkdtemp(join(tmpdir(), "axp-park-restart-"));
    const database = join(directory, "hub.db");
    const f = await setup({ database });
    let cleanup = f.close;
    const satellite = new Satellite({
      url: f.url,
      token: f.credentials[1]!.token,
      session: f.c.exchange,
      repository: repo,
      agent: agent(),
      leaseMs: 3000,
      allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
      reconnect: { initialDelayMs: 30, maxDelayMs: 100 },
    });
    const faults: Error[] = [];
    satellite.on("fault", (error) => faults.push(error));
    t.after(async () => {
      await satellite.stop();
      await cleanup();
      await rm(repo, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    });
    await satellite.start();
    await f.maintainer.dispatch(f.c.chat, prompt("Wait for review."));
    await permissionPending(f.maintainer, f.c.chat);
    const path = satellite.worktree.path;
    await f.close();
    cleanup = async () => {};
    await eventually(
      () => satellite.state,
      (s) => s === "reconnecting",
    );
    const hub = new Hub({
      database,
      repository: f.hub.options.repository,
      credentials: f.credentials,
      port: Number(new URL(f.url).port),
    });
    cleanup = () => hub.close();
    assert.equal(await hub.listen(), f.url);
    await eventually(
      () => satellite.state,
      (s) => s === "parked",
      5000,
    );
    const state = await satellite.client.snapshot<ExchangeState>(f.c.exchange);
    assert.equal(state.epoch, 2);
    assert.equal(satellite.worktree.path, path);
    assert.equal(Object.keys(state.grants).length, 1);
    assert.equal(state.grants[satellite.executorId]?.spent.turns, 1);
    assert.equal(state.usage.length, 1);
    assert.equal(
      (await satellite.client.snapshot<ChatState>(f.c.chat)).activeTurn,
      undefined,
    );
    assert.equal(faults.length, 0);
  },
);

test(
  "authentication failures stop parking, while stopping during retry cancels the pending start",
  { timeout: 10_000 },
  async (t) => {
    const f = await setup();
    const proxy = await faultProxy(f.url);
    const options = {
      url: proxy.url,
      token: "invalid-credential-token-xxxxxxxx",
      session: f.c.exchange,
      repository: ".",
      agent: agent(),
      allowance: { tokens: 10_000, costMicros: 100_000, turns: 10 },
      perTurn: { tokens: 1000, costMicros: 10_000, turns: 1 },
    };
    const rejected = new Satellite({ ...options, url: f.url });
    const waiting = new Satellite({
      ...options,
      token: f.credentials[1]!.token,
    });
    t.after(async () => {
      await rejected.stop();
      await waiting.stop();
      await proxy.close();
      await f.close();
    });
    await assert.rejects(rejected.start(), /HTTP 401/);
    await rejected.closed;
    assert.equal(rejected.state, "stopped");
    proxy.setAvailable(false);
    const pending = assert.rejects(waiting.start(), /stopped before parking/);
    await eventually(
      () => waiting.state,
      (s) => s === "reconnecting",
    );
    await waiting.stop();
    await pending;
    assert.equal(waiting.state, "stopped");
    assert.deepEqual(
      (await f.maintainer.snapshot<ExchangeState>(f.c.exchange)).grants,
      {},
    );
  },
);
