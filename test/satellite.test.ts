import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ActionType,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
  PendingMessageKind,
  MessageKind,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { Satellite } from "../src/satellite.js";
import type { AgentLaunch } from "../src/acp.js";
import { Worktree } from "../src/git.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { setup, prompt, eventually, dock } from "./helpers.js";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { hashObject, signObject } from "../src/hash.js";

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
          resolve("node_modules/tsx/dist/loader.mjs"),
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
async function repository() {
  const path = await mkdtemp(join(tmpdir(), "axp-project-"));
  await exec("git", ["init", "-b", "main", path]);
  await writeFile(join(path, "package.json"), '{"type":"module"}');
  await writeFile(join(path, ".gitignore"), ".axp/\n");
  await writeFile(
    join(path, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(path, "sum.test.js"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('adds two numbers', () => assert.equal(sum(2, 3), 5));\n",
  );
  await exec("git", ["add", "."], { cwd: path });
  await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Failing addition",
    ],
    { cwd: path },
  );
  return path;
}

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
    assert.deepEqual(faults, []);
    assert.ok(done.checkpoint);
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
    const replacement = await Worktree.restore(
      repo,
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
    satellite.on("fault", (e) => faults.push(e));
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
    assert.deepEqual(faults, []);
  },
);
