import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  ActionType,
  MessageKind,
  ToolCallConfirmationReason,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import {
  Hub,
  AxpClient,
  Satellite,
  channels,
  verifyCheckpoint,
  hashObject,
} from "../src/index.js";
import type { ExchangeState } from "../src/index.js";

const exec = promisify(execFile);
const liveAgent = process.env.AXP_DEMO_AGENT;
const directory = await mkdtemp(join(tmpdir(), "axp-demo-"));
const credentials = (["maintainer", "contributor", "verifier"] as const).map(
  (role) => ({
    token: randomBytes(32).toString("hex"),
    principal: { id: role, role, sessions: "*" as const },
  }),
);
const hub = new Hub({ repository: "demo/addition", credentials });
const url = await hub.listen();
const maintainer = await AxpClient.connect(url, credentials[0]!.token);
const verifier = await AxpClient.connect(url, credentials[2]!.token);
let satellite: Satellite | null = null;
try {
  await exec("git", ["init", "-b", "main", directory]);
  await writeFile(join(directory, ".gitignore"), ".axp/\n");
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(directory, "sum.test.js"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('adds numbers', () => assert.equal(sum(2, 3), 5));\n",
  );
  await exec("git", ["add", "."], { cwd: directory });
  await exec(
    "git",
    [
      "-c",
      "user.name=AXP Demo",
      "-c",
      "user.email=demo@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Reproduce addition bug",
    ],
    { cwd: directory },
  );
  await assert.rejects(exec(process.execPath, ["--test"], { cwd: directory }));
  console.log("1. Reproduced a failing repository test.");
  const c = channels(randomUUID());
  await maintainer.ahp.request("createSession", {
    channel: c.session,
    provider: "axp",
    config: { title: "Fix addition", task: "addition-bug" },
  });
  satellite = new Satellite({
    url,
    token: credentials[1]!.token,
    session: c.exchange,
    repository: directory,
    agent: {
      command: process.execPath,
      args: liveAgent
        ? [resolve(liveAgent)]
        : [
            "--import",
            pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
            resolve("examples/fixture-agent.ts"),
          ],
      isolation: "native",
      ...(process.env.AXP_DEMO_AUTH_METHOD
        ? { authMethod: process.env.AXP_DEMO_AUTH_METHOD }
        : {}),
      env: Object.fromEntries(
        (process.env.AXP_DEMO_AGENT_ENV ?? "")
          .split(",")
          .filter(Boolean)
          .map((key) => {
            assert.ok(process.env[key] !== undefined, `${key} is not set`);
            return [key, process.env[key]!];
          }),
      ),
    },
    allowance: {
      tokens: 100_000,
      costMicros: liveAgent ? 5_000_000 : 0,
      turns: 5,
    },
    perTurn: {
      tokens: liveAgent ? 100_000 : 2000,
      costMicros: liveAgent ? 5_000_000 : 0,
      turns: 1,
    },
  });
  const faults: Error[] = [];
  satellite.on("fault", (error) => {
    faults.push(error);
    console.error(error.message);
  });
  await satellite.start();
  console.log("2. Contributor's agent connected over an outbound WebSocket.");
  const turnId = randomUUID();
  await maintainer.dispatch(c.chat, {
    type: ActionType.ChatTurnStarted,
    turnId,
    startedAt: new Date().toISOString(),
    message: {
      text: "Fix the addition bug in sum.js and test it with node --test. This is a tiny isolated fixture; read only files in the working directory, do not inspect parent or home directories, do not access any external service, and do not change the test. Make only the necessary one-line fix, run node --test and finish.",
      origin: { kind: MessageKind.User },
    },
  });
  const deadline = Date.now() + (liveAgent ? 180_000 : 20_000);
  const approved = new Set<string>();
  let done: ExchangeState | null = null;
  while (Date.now() < deadline) {
    const chat = await maintainer.snapshot<ChatState>(c.chat);
    const tool = chat.activeTurn?.responseParts.find(
      (p) =>
        p.kind === "toolCall" && p.toolCall.status === "pending-confirmation",
    );
    if (
      tool?.kind === "toolCall" &&
      tool.toolCall.status === "pending-confirmation" &&
      !approved.has(tool.toolCall.toolCallId)
    ) {
      const selected = tool.toolCall.options?.find(
        (o) => o.kind === "approve" && !/always|session/i.test(o.label),
      );
      assert.ok(selected, "No one-time approval option");
      await maintainer.dispatch(c.chat, {
        type: ActionType.ChatToolCallConfirmed,
        turnId,
        toolCallId: tool.toolCall.toolCallId,
        approved: true,
        confirmed: ToolCallConfirmationReason.UserAction,
        selectedOptionId: selected.id,
      });
      approved.add(tool.toolCall.toolCallId);
      console.log("3. Maintainer approved the tool call.");
    }
    const state = await maintainer.snapshot<ExchangeState>(c.exchange);
    if (!chat.activeTurn && chat.turns.length && !state.checkpoint)
      throw new Error(
        `Agent ended without a checkpoint: ${JSON.stringify(chat.turns.at(-1)?.responseParts)}`,
      );
    if (state.checkpoint && !state.reservation) {
      done = state;
      break;
    }
    await delay(20);
  }
  assert.ok(done?.checkpoint, "Agent did not produce a checkpoint");
  assert.deepEqual(
    faults,
    [],
    "The contribution must finish without protocol or accounting faults",
  );
  assert.match(await readFile(join(directory, "sum.js"), "utf8"), /a - b/);
  console.log(
    "4. Agent fixed the isolated worktree; the contributor checkout is unchanged.",
  );
  const verified = await verifyCheckpoint(verifier, c.exchange, directory, [
    process.execPath,
    "--test",
  ]);
  assert.equal(verified.exitCode, 0);
  console.log(
    `5. Independent verifier restored the Git bundle and passed tests at ${verified.headCommit.slice(0, 12)}.`,
  );
  await satellite.exportHistory();
  const archive = await maintainer.call("_axp/export", { channel: c.exchange });
  if (process.env.AXP_DEMO_RECEIPT)
    await writeFile(
      resolve(process.env.AXP_DEMO_RECEIPT),
      JSON.stringify(
        {
          format: "axp.demo.v1",
          observedAt: new Date().toISOString(),
          adapter: process.env.AXP_DEMO_LABEL ?? "fixture",
          node: process.versions.node,
          baseCommit: done.checkpoint.baseCommit,
          headCommit: verified.headCommit,
          verifierExitCode: verified.exitCode,
          verifierOutputSha256: verified.output.sha256,
          eventCount: archive.actions.length,
          historyHash: hashObject(archive),
          toolApprovals: approved.size,
          originalCheckoutUnchanged: true,
          faults: faults.length,
          usage: done.usage,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  console.log(
    `6. Contributor's copy of the session has all ${archive.actions.length} events. Tool approvals: ${approved.size}.`,
  );
  console.log(
    liveAgent
      ? "Live-agent integration passed using the configured ACP adapter."
      : "Demo passed. A scripted agent made the edit and ran Git operations and tests without using model or API credits.",
  );
} finally {
  await satellite?.stop();
  await maintainer.close();
  await verifier.close();
  await hub.close();
  await rm(directory, { recursive: true, force: true });
}
