#!/usr/bin/env node
import { parseArgs, stripVTControlCharacters } from "node:util";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
} from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { Hub } from "./hub.js";
import { AxpClient } from "./client.js";
import { Satellite } from "./satellite.js";
import { channels, ROOT } from "./protocol/types.js";
import type { ExchangeState, Review } from "./protocol/types.js";
import { id, allowance, methods } from "./protocol/schema.js";
import type { Method } from "./protocol/schema.js";
import { requireThat, Codes } from "./protocol/errors.js";
import { hashObject, signObject } from "./hash.js";
import { verifyCheckpoint } from "./verification.js";
import { excludeLocalState, Worktree } from "./git.js";

const HELP = `AXP — park an agent, share the session.

  axp init --repo owner/project             Create local access profiles
  axp serve                                Start the repository host
  axp create --task issue-42 --title "Fix"   Open a session; prints its ID
  axp sessions                             List sessions
  axp park SESSION --native -- COMMAND ...  Run a local ACP agent
  axp park SESSION --image IMAGE -- CMD ... Run an offline container agent
  axp prompt SESSION "Fix the parser"       Start a turn
  axp steer SESSION "Keep the API stable"   Cancel and continue with guidance
  axp queue SESSION "Then add an example"   Queue the next turn
  axp watch SESSION                        Follow the shared action stream
  axp inspect SESSION                      Print synchronized session state
  axp approve SESSION --tool ID --option ID Answer a pending permission
  axp cancel SESSION                       Cancel the active turn
  axp close SESSION                        Close the task and retain its history
  axp export SESSION --out history.json     Retain the complete audit record
  axp keygen --out signing-key.pem          Create an Ed25519 signing key
  axp submit SESSION --key KEY --model NAME Sign a checkpoint manifest
  axp accept SESSION --key KEY              Countersign a reviewed artifact
  axp publish SESSION --remote FORK         Restore and push the reviewed commit
  axp verify SESSION --native -- COMMAND    Test an exact checkpoint as verifier
  axp executors                            Show parked executor capabilities
  axp memory "query"                       Retrieve approved repository lessons
  axp rpc METHOD --params request.json      Call a typed AXP extension

Connection: --profile .axp/maintainer.json (default), or AXP_URL + AXP_TOKEN.
Parking: --profile .axp/contributor.json --directory /path/to/repo
Limits: --tokens 100000 --cost-micros 1000000 --turns 10
        --turn-tokens 10000 --turn-cost-micros 100000
Native execution uses your user permissions; select it explicitly.
Container execution requires Docker and an image with its tools/dependencies.
Pass provider environment explicitly: --agent-env ANTHROPIC_API_KEY,FOO.
Select an advertised ACP login only when needed: --auth-method METHOD.
Parking reconnects automatically with the same donation; --no-reconnect disables it.
Remote connections require wss://; access tokens stay in headers.
`;

const stringOptions = [
  "repo",
  "config",
  "profile",
  "directory",
  "task",
  "title",
  "id",
  "out",
  "tool",
  "option",
  "key",
  "model",
  "params",
  "image",
  "tokens",
  "cost-micros",
  "turns",
  "turn-tokens",
  "turn-cost-micros",
  "port",
  "host",
  "agent-env",
  "auth-method",
  "remote",
];
const profileSchema = z.strictObject({
  url: z.string().url(),
  token: z.string().min(24),
});
const hubSchema = z.object({
  repository: z.string().min(1),
  database: z.string(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(7331),
  credentials: z
    .array(
      z.strictObject({
        token: z.string().min(24),
        principal: z.strictObject({
          id,
          role: z.enum(["maintainer", "contributor", "observer", "verifier"]),
          sessions: z.union([z.literal("*"), z.array(z.string())]),
        }),
      }),
    )
    .min(1),
  allowedOrigins: z.array(z.string()).optional(),
});
async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}
async function save(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(resolve(path), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
function print(value: unknown): void {
  process.stdout.write(
    typeof value === "string"
      ? `${stripVTControlCharacters(value)}\n`
      : `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const divider = argv.indexOf("--");
  const commandArgs = divider < 0 ? [] : argv.slice(divider + 1);
  const parsed = parseArgs({
    args: divider < 0 ? argv : argv.slice(0, divider),
    allowPositionals: true,
    options: {
      ...Object.fromEntries(
        stringOptions.map((k) => [k, { type: "string" as const }]),
      ),
      native: { type: "boolean" },
      "no-reconnect": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const values: Record<string, string | boolean | undefined> = parsed.values;
  const option = (key: string, fallback?: string): string => {
    const value = values[key];
    requireThat(
      typeof value === "string" || fallback !== undefined,
      Codes.invalid,
      `Missing --${key}`,
    );
    return typeof value === "string" ? value : fallback!;
  };
  const [command, sessionId, ...rest] = parsed.positionals;
  if (!command || values.help) {
    print(HELP);
    return;
  }
  const directory = resolve(option("directory", process.cwd()));
  const configFile = resolve(option("config", ".axp/hub.json"));
  if (command === "init") {
    await excludeLocalState(directory);
    const repository = option("repo");
    const path = resolve(directory, ".axp");
    const port = Number(option("port", "7331"));
    const credentials = [
      "maintainer",
      "contributor",
      "observer",
      "verifier",
    ].map((role) => ({
      token: randomBytes(32).toString("hex"),
      principal: { id: role, role, sessions: "*" },
    }));
    const config = hubSchema.parse({
      repository,
      database: resolve(path, "hub.db"),
      host: option("host", "127.0.0.1"),
      port,
      credentials,
    });
    await save(resolve(path, "hub.json"), config);
    for (const credential of credentials)
      await save(resolve(path, `${credential.principal.role}.json`), {
        url: `ws://127.0.0.1:${port}/axp`,
        token: credential.token,
      });
    print(
      `Created private profiles in ${path}. Run axp serve. Share only the intended contributor profile.`,
    );
    return;
  }
  if (command === "serve") {
    const parsedConfig = hubSchema.parse(await jsonFile(configFile));
    const hub = new Hub({
      ...parsedConfig,
      ...(parsedConfig.allowedOrigins
        ? { allowedOrigins: parsedConfig.allowedOrigins }
        : {}),
    } as ConstructorParameters<typeof Hub>[0]);
    const url = await hub.listen();
    print(`AXP host listening at ${url}`);
    await waitForStop(() => hub.close());
    return;
  }
  if (command === "keygen") {
    const key = generateKeyPairSync("ed25519")
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const file = resolve(option("out"));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, key, { mode: 0o600, flag: "wx" });
    print(file);
    return;
  }
  const profile =
    process.env.AXP_URL && process.env.AXP_TOKEN
      ? profileSchema.parse({
          url: process.env.AXP_URL,
          token: process.env.AXP_TOKEN,
        })
      : profileSchema.parse(
          await jsonFile(option("profile", ".axp/maintainer.json")),
        );
  if (command === "park") {
    requireThat(
      sessionId && commandArgs[0],
      Codes.invalid,
      "Usage: axp park SESSION --native -- ACP_COMMAND [ARGS]",
    );
    requireThat(
      !!values.native !== !!values.image,
      Codes.invalid,
      "Select exactly one of --native or --image",
    );
    const limits = allowance.parse({
      tokens: Number(option("tokens", "100000")),
      costMicros: Number(option("cost-micros", "1000000")),
      turns: Number(option("turns", "10")),
    });
    const perTurn = allowance.parse({
      tokens: Number(option("turn-tokens", "10000")),
      costMicros: Number(option("turn-cost-micros", "100000")),
      turns: 1,
    });
    const satellite = new Satellite({
      ...profile,
      repository: directory,
      session: channels(id.parse(sessionId)).exchange,
      agent: {
        command: commandArgs[0],
        args: commandArgs.slice(1),
        isolation: values.native ? "native" : "container",
        ...(values["auth-method"] ? { authMethod: option("auth-method") } : {}),
        ...(values.image ? { image: option("image") } : {}),
        env: Object.fromEntries(
          option("agent-env", "")
            .split(",")
            .filter(Boolean)
            .map((key) => {
              requireThat(
                /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
                  process.env[key] !== undefined,
                Codes.invalid,
                `Agent environment variable ${key} is not set`,
              );
              return [key, process.env[key]!];
            }),
        ),
      },
      allowance: limits,
      perTurn,
      ...(values["no-reconnect"] ? { reconnect: false as const } : {}),
    });
    satellite.on("status", print);
    satellite.on("fault", (error) => {
      process.stderr.write(`${stripVTControlCharacters(error.message)}\n`);
      process.exitCode = 1;
    });
    await waitForStop(
      () => satellite.stop(),
      satellite.closed,
      () => satellite.start(),
    );
    return;
  }
  const client = await AxpClient.connect(profile.url, profile.token);
  try {
    if (command === "create") {
      const key = id.parse(option("id", randomUUID()));
      const c = channels(key);
      await client.ahp.request("createSession", {
        channel: c.session,
        provider: "axp",
        config: {
          title: option("title", option("task", key)),
          task: option("task", key),
        },
      });
      print(key);
      return;
    }
    if (command === "sessions") {
      print(await client.ahp.request("listSessions", { channel: ROOT }));
      return;
    }
    if (command === "executors") {
      print(await client.snapshot("axp-executors://"));
      return;
    }
    if (command === "memory") {
      print(
        await client.call("_axp/memorySearch", {
          channel: ROOT,
          query: [sessionId, ...rest].filter(Boolean).join(" "),
          limit: 5,
        }),
      );
      return;
    }
    if (command === "rpc") {
      requireThat(
        sessionId && Object.hasOwn(methods, sessionId),
        Codes.method,
        "Unknown AXP method",
      );
      const params = z
        .record(z.string(), z.unknown())
        .parse(await jsonFile(option("params")));
      const method = sessionId as Method;
      const checked = methods[method].parse({
        ...params,
        ...("operationId" in methods[method].shape
          ? { operationId: params.operationId ?? randomUUID() }
          : {}),
      });
      print(await client.call(method, checked));
      return;
    }
    requireThat(sessionId, Codes.invalid, "A session ID is required");
    const c = channels(id.parse(sessionId));
    if (command === "close") {
      await client.call("_axp/close", { channel: c.exchange });
      return;
    }
    if (command === "publish") {
      const state = await client.snapshot<ExchangeState>(c.exchange);
      requireThat(
        state.review?.maintainer &&
          state.checkpoint?.headCommit === state.review.manifest.headCommit,
        Codes.conflict,
        "A current countersigned review is required",
      );
      const blob = await client.call("_axp/blobGet", {
        channel: c.exchange,
        digest: state.checkpoint.bundle.sha256,
      });
      const worktree = await Worktree.restore(
        directory,
        `publish-${randomUUID()}`,
        state.checkpoint,
        Buffer.from(blob.data, "base64"),
      );
      await worktree.publish(option("remote"), state.review);
      print(
        `Published ${state.checkpoint.headCommit} to ${option("remote")}:${worktree.branch}. Retained ${worktree.path}`,
      );
      return;
    }
    if (command === "verify") {
      requireThat(
        values.native,
        Codes.invalid,
        "Verification runs repository code; select --native on an isolated verifier host",
      );
      print(await verifyCheckpoint(client, c.exchange, directory, commandArgs));
      return;
    }
    if (command === "inspect") {
      print({
        exchange: await client.snapshot(c.exchange),
        chat: await client.snapshot(c.chat),
      });
      return;
    }
    if (command === "export") {
      await save(
        option("out"),
        await client.call("_axp/export", { channel: c.exchange }),
      );
      print(resolve(option("out")));
      return;
    }
    if (command === "watch") {
      print(await client.snapshot(c.chat));
      await client.snapshot(c.exchange);
      client.on("action", (event) => print(event));
      await waitForStop(() => client.close());
      return;
    }
    if (["prompt", "steer", "queue"].includes(command)) {
      const text = rest.join(" ");
      requireThat(text.trim(), Codes.invalid, "Provide a message");
      const message = { text, origin: { kind: MessageKind.User } };
      if (command === "prompt")
        await client.dispatch(c.chat, {
          type: ActionType.ChatTurnStarted,
          turnId: randomUUID(),
          startedAt: new Date().toISOString(),
          message,
        });
      else
        await client.dispatch(c.chat, {
          type: ActionType.ChatPendingMessageSet,
          kind:
            command === "steer"
              ? PendingMessageKind.Steering
              : PendingMessageKind.Queued,
          id: randomUUID(),
          message,
        });
      return;
    }
    if (command === "approve" || command === "cancel") {
      const chat = await client.snapshot<ChatState>(c.chat);
      requireThat(chat.activeTurn, Codes.conflict, "No active turn");
      if (command === "cancel") {
        await client.dispatch(c.chat, {
          type: ActionType.ChatTurnCancelled,
          turnId: chat.activeTurn.id,
          duration: 0,
        });
        return;
      }
      const toolId = option("tool");
      const optionId = option("option");
      const part = chat.activeTurn.responseParts.find(
        (p) => p.kind === "toolCall" && p.toolCall.toolCallId === toolId,
      );
      requireThat(
        part?.kind === "toolCall" &&
          part.toolCall.status === "pending-confirmation",
        Codes.conflict,
        "Tool is not waiting",
      );
      const selected = part.toolCall.options?.find((o) => o.id === optionId);
      requireThat(
        selected,
        Codes.invalid,
        "Select an offered option ID from axp inspect",
      );
      const base = {
        type: ActionType.ChatToolCallConfirmed,
        turnId: chat.activeTurn.id,
        toolCallId: toolId,
        selectedOptionId: optionId,
      } as const;
      await client.dispatch(
        c.chat,
        selected.kind === "approve"
          ? {
              ...base,
              approved: true,
              confirmed: ToolCallConfirmationReason.UserAction,
            }
          : {
              ...base,
              approved: false,
              reason: ToolCallCancellationReason.Denied,
            },
      );
      return;
    }
    if (command === "submit" || command === "accept") {
      const state = await client.snapshot<ExchangeState>(c.exchange);
      const key = await readFile(resolve(option("key")), "utf8");
      if (command === "accept") {
        requireThat(state.review, Codes.conflict, "No artifact submitted");
        print(
          await client.call("_axp/approveReview", {
            channel: c.exchange,
            signature: signObject(state.review.manifest, key),
          }),
        );
        return;
      }
      requireThat(state.checkpoint, Codes.conflict, "No checkpoint to submit");
      const archive = await client.call("_axp/export", { channel: c.exchange });
      const context = await client.call("_axp/context", {
        channel: c.exchange,
        maxChars: 200_000,
      });
      const manifest: Review["manifest"] = {
        version: 1,
        repository: state.repository,
        session: c.session,
        baseCommit: state.checkpoint.baseCommit,
        headCommit: state.checkpoint.headCommit,
        model: option("model"),
        promptHash: hashObject(context.text),
        traceHash: hashObject(
          archive.actions.filter((e) => e.channel !== c.changeset),
        ),
        traceThroughSeq: archive.serverSeq,
        checkpointDigest: hashObject(state.checkpoint),
      };
      print(
        await client.call("_axp/review", {
          channel: c.exchange,
          manifest,
          contributor: signObject(manifest, key),
        }),
      );
      return;
    }
    requireThat(
      false,
      Codes.method,
      `Unknown command ${command}. Run axp --help.`,
    );
  } finally {
    await client.close();
  }
}

async function waitForStop(
  stop: () => Promise<void>,
  closed?: Promise<void>,
  start: () => Promise<void> = async () => {},
): Promise<void> {
  const stopped = Promise.withResolvers<void>();
  let signalled = false;
  const remove = () => {
    process.off("SIGINT", done);
    process.off("SIGTERM", done);
  };
  const done = () => {
    signalled = true;
    remove();
    void stop().then(stopped.resolve, stopped.reject);
  };
  process.once("SIGINT", done);
  process.once("SIGTERM", done);
  try {
    await Promise.race([
      start().then(() => closed ?? stopped.promise),
      stopped.promise,
    ]);
  } catch (error) {
    if (!signalled) throw error;
  } finally {
    remove();
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `${stripVTControlCharacters(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  });
}
