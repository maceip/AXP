#!/usr/bin/env node
/** Deterministic ACP conformance agent. No model, network calls or API credits.
 * It makes one real code edit and executes the repository's real test command. */
import { Writable, Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map<
  string,
  { cwd: string; controller: AbortController }
>();
const execute = promisify(execFile);
const app = acp
  .agent({ name: "axp-fixture" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    if (
      params.clientCapabilities?.fs?.readTextFile ||
      params.clientCapabilities?.terminal
    )
      throw new Error(
        "Fixture expects native tools, not client file/terminal RPCs",
      );
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
      agentInfo: { name: "axp-fixture", version: "1.0.0" },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      cwd: params.cwd,
      controller: new AbortController(),
    });
    return { sessionId };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.controller.abort();
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error("Unknown session");
    session.controller = new AbortController();
    const sessionId = params.sessionId;
    const update = (update: acp.SessionUpdate) =>
      client.notify(acp.methods.client.session.update, { sessionId, update });
    await update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "I will fix addition and run the real tests.\n",
      },
    });
    const toolCallId = randomUUID();
    await update({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "Fix addition and run node --test",
      status: "pending",
      kind: "execute",
    });
    const permission = await client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId,
          title: "Write sum.js and execute node --test",
          status: "pending",
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny-once", name: "Deny", kind: "reject_once" },
        ],
      },
    );
    if (
      permission.outcome.outcome !== "selected" ||
      permission.outcome.optionId !== "allow-once" ||
      session.controller.signal.aborted
    )
      return { stopReason: "cancelled" as const };
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
    });
    const wait = Number(process.argv.find((arg) => arg.startsWith("--delay-ms="))?.split("=")[1] ?? 0);
    if (wait) {
      try { await delay(wait, undefined, { signal: session.controller.signal }); }
      catch { return { stopReason: "cancelled" as const }; }
    }
    await writeFile(
      join(session.cwd, "sum.js"),
      "export const sum = (a, b) => a + b;\n",
    );
    let output: string;
    try {
      const result = await execute(process.execPath, ["--test"], {
        cwd: session.cwd,
        signal: session.controller.signal,
      });
      output = result.stdout;
    } catch (error) {
      if (session.controller.signal.aborted)
        return { stopReason: "cancelled" as const };
      throw error;
    }
    await update({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: output } }],
    });
    await update({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Fixed addition. The repository tests passed.",
      },
    });
    return {
      stopReason: "end_turn" as const,
      usage: {
        totalTokens: 130,
        inputTokens: 100,
        outputTokens: 30,
        cachedReadTokens: 50,
      },
    };
  });
const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
