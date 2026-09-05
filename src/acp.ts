import { spawn, execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import {
  ActionType,
  ResponsePartKind,
  ToolCallConfirmationReason,
  ConfirmationOptionKind,
  ToolResultContentType,
} from "@microsoft/agent-host-protocol";
import type {
  StateAction,
  ToolResultContent,
} from "@microsoft/agent-host-protocol";
import type { BlobRef, Usage } from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";

export interface AgentLaunch {
  command: string;
  args?: string[];
  /** Native tools run with the contributor's user permissions. Must be explicit. */
  isolation: "native" | "container";
  image?: string;
  /** Values are contributor-local, never supplied by the repo hub. */
  env?: Record<string, string>;
}
export interface AgentCallbacks {
  emit(actions: StateAction[]): Promise<void>;
  blob(data: Uint8Array, mediaType: string): Promise<BlobRef>;
  permission(toolCallId: string, signal: AbortSignal): Promise<string | null>;
}
const containers = new WeakMap<ChildProcessWithoutNullStreams, string>();

export function launchAgent(
  config: AgentLaunch,
  cwd: string,
): ChildProcessWithoutNullStreams {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, config.env);
  requireThat(
    !Object.keys(env).some((k) => k.startsWith("AXP_")),
    Codes.forbidden,
    "AXP control credentials must not enter the agent environment",
  );
  if (config.isolation === "container") {
    requireThat(
      config.image && /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]+$/.test(config.image),
      Codes.invalid,
      "A container image is required",
    );
    const name = `axp-${randomUUID()}`;
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "-i",
        "--init",
        "--cap-drop=ALL",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--env",
        "HOME=/tmp",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:rw,nosuid,size=256m",
        "--mount",
        `type=bind,source=${cwd},target=/workspace`,
        "--workdir=/workspace",
        ...Object.keys(config.env ?? {}).flatMap((key) => ["--env", key]),
        config.image,
        config.command,
        ...(config.args ?? []),
      ],
      { cwd, env, stdio: "pipe" },
    );
    containers.set(child, name);
    return child;
  }
  return spawn(config.command, config.args ?? [], {
    cwd,
    env,
    stdio: "pipe",
    detached: process.platform !== "win32",
  });
}

export class AcpDriver {
  private connection: acp.ClientConnection | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private sessionId = "";
  private active: { turnId: string; signal: AbortSignal } | null = null;
  private updates = Promise.resolve();
  private updateError: unknown;
  private readonly tools = new Map<
    string,
    { title: string; ready: boolean; denied: boolean }
  >();
  private part = 0;
  private textPart: string | null = null;
  private thoughtPart: string | null = null;
  private stderr = "";
  private costMicros: number | null = null;
  private costUpdates = 0;
  private closing: Promise<void> | null = null;
  model = "acp-agent";
  constructor(
    readonly launch: AgentLaunch,
    readonly cwd: string,
    readonly callbacks: AgentCallbacks,
  ) {}

  async start(): Promise<void> {
    const child = launchAgent(this.launch, this.cwd);
    this.process = child;
    const failed = new Promise<never>((_, reject) =>
      child.once("error", reject),
    );
    child.stderr.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-8192);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(
        frameLimit(),
      ),
    );
    const client = acp
      .client({ name: "axp-satellite" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        this.updates = this.updates
          .then(() => this.update(params))
          .catch((error) => {
            this.updateError = error;
          });
        return this.updates;
      })
      .onRequest(
        acp.methods.client.session.requestPermission,
        async ({ params }) => {
          await this.updates;
          if (!this.active || this.active.signal.aborted || this.updateError)
            return { outcome: { outcome: "cancelled" } };
          requireThat(
            params.sessionId === this.sessionId,
            Codes.invalid,
            "Permission belongs to another ACP session",
          );
          const { turnId, signal } = this.active;
          const key = params.toolCall.toolCallId;
          if (!this.tools.has(key))
            await this.startTool(
              turnId,
              key,
              params.toolCall.title ?? "Agent tool",
            );
          const options = params.options.map((o) => ({
            id: o.optionId,
            label: o.name,
            kind: o.kind.startsWith("allow")
              ? ConfirmationOptionKind.Approve
              : ConfirmationOptionKind.Deny,
          }));
          const tool = this.tools.get(key)!;
          const rawInput = JSON.stringify(params.toolCall.rawInput ?? {});
          const inputRef =
            rawInput.length > 4096
              ? await this.callbacks.blob(
                  Buffer.from(rawInput),
                  "application/json",
                )
              : null;
          // Request input is display-only; ACP selected outcomes cannot replace it.
          await this.callbacks.emit([
            {
              type: ActionType.ChatToolCallReady,
              turnId,
              toolCallId: key,
              invocationMessage: params.toolCall.title ?? tool.title,
              options,
              editable: false,
              toolInput: inputRef
                ? {
                    uri: inputRef.uri,
                    contentType: inputRef.mediaType,
                    sizeHint: inputRef.size,
                  }
                : rawInput,
            },
          ]);
          tool.ready = true;
          const selected = await this.callbacks.permission(key, signal);
          if (!selected || signal.aborted)
            return { outcome: { outcome: "cancelled" } };
          const option = params.options.find((o) => o.optionId === selected);
          requireThat(option, Codes.invalid, "Unknown ACP permission option");
          tool.denied = option.kind.startsWith("reject");
          return { outcome: { outcome: "selected", optionId: selected } };
        },
      );
    this.connection = client.connect(stream);
    const deadline = setTimeout(() => {
      void this.close();
    }, 15_000);
    try {
      const initialized = await Promise.race([
        failed,
        this.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: "axp", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
      ]);
      requireThat(
        initialized.protocolVersion === acp.PROTOCOL_VERSION,
        Codes.version,
        "Unsupported ACP protocol version",
      );
      this.model = initialized.agentInfo?.name ?? "acp-agent";
      const session = await this.connection.agent.request(
        acp.methods.agent.session.new,
        {
          cwd: this.launch.isolation === "container" ? "/workspace" : this.cwd,
          mcpServers: [],
        },
      );
      this.sessionId = session.sessionId;
    } finally {
      clearTimeout(deadline);
    }
  }
  async prompt(
    turnId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<{
    usage: Usage | null;
    costKnown: boolean;
    outcome: "complete" | "cancelled";
  }> {
    requireThat(
      this.connection && !this.active,
      Codes.conflict,
      "ACP agent is not ready",
    );
    this.active = { turnId, signal };
    this.tools.clear();
    this.textPart = null;
    this.thoughtPart = null;
    this.updateError = undefined;
    const priorCost = this.costMicros ?? 0;
    const priorCostUpdates = this.costUpdates;
    const cancel = () => {
      void this.connection?.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId })
        .catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      timer = setTimeout(() => {
        void this.close();
      }, 2000);
      timer.unref();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      signal.throwIfAborted();
      const result = await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
      );
      await this.updates;
      if (this.updateError) throw this.updateError;
      const usage = result.usage;
      // ACP token reporting is optional, and has no standardized per-turn USD
      // amount. Monetary uncertainty consumes the reserved ceiling at settlement.
      return {
        usage: usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cachedReadTokens ?? 0,
              costMicros: Math.max(0, (this.costMicros ?? 0) - priorCost),
              source: "reported",
            }
          : null,
        costKnown:
          this.costUpdates > priorCostUpdates && this.costMicros! >= priorCost,
        outcome:
          result.stopReason === "cancelled" || signal.aborted
            ? "cancelled"
            : "complete",
      };
    } catch (error) {
      if (signal.aborted)
        return { usage: null, costKnown: false, outcome: "cancelled" };
      throw new Error(
        `ACP turn failed: ${error instanceof Error ? error.message : "Unknown agent error"}`,
        { cause: error },
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      signal.removeEventListener("abort", stop);
      if (timer) clearTimeout(timer);
      this.active = null;
    }
  }
  private async startTool(
    turnId: string,
    toolCallId: string,
    title: string,
  ): Promise<void> {
    this.textPart = null;
    this.thoughtPart = null;
    this.tools.set(toolCallId, { title, ready: false, denied: false });
    await this.callbacks.emit([
      {
        type: ActionType.ChatToolCallStart,
        turnId,
        toolCallId,
        toolName: "acp",
        displayName: title,
      },
    ]);
  }
  private async content(
    content: acp.ToolCallContent[] | null | undefined,
  ): Promise<ToolResultContent[]> {
    if (JSON.stringify(content ?? []).length > 24_000) {
      const ref = await this.callbacks.blob(
        Buffer.from(JSON.stringify(content)),
        "application/json",
      );
      return [
        {
          type: ToolResultContentType.Resource,
          uri: ref.uri,
          contentType: ref.mediaType,
          sizeHint: ref.size,
        },
      ];
    }
    const output: ToolResultContent[] = [];
    for (const item of content ?? []) {
      if (
        item.type === "content" &&
        item.content.type === "text" &&
        item.content.text.length <= 4096
      )
        output.push({
          type: ToolResultContentType.Text,
          text: item.content.text,
        });
      else {
        const ref = await this.callbacks.blob(
          Buffer.from(JSON.stringify(item)),
          "application/json",
        );
        output.push({
          type: ToolResultContentType.Resource,
          uri: ref.uri,
          contentType: ref.mediaType,
          sizeHint: ref.size,
        });
      }
    }
    return output;
  }
  private async update(params: acp.SessionNotification): Promise<void> {
    const active = this.active;
    if (!active || active.signal.aborted) return;
    requireThat(
      params.sessionId === this.sessionId,
      Codes.invalid,
      "Update belongs to another ACP session",
    );
    const { turnId } = active;
    const u = params.update;
    if (
      u.sessionUpdate === "usage_update" &&
      u.cost?.currency === "USD" &&
      Number.isFinite(u.cost.amount) &&
      u.cost.amount >= 0
    ) {
      this.costMicros = Math.round(u.cost.amount * 1_000_000);
      this.costUpdates++;
    }
    if (
      u.sessionUpdate === "agent_message_chunk" ||
      u.sessionUpdate === "agent_thought_chunk"
    ) {
      if (u.content.type !== "text") {
        const ref = await this.callbacks.blob(
          Buffer.from(JSON.stringify(u.content)),
          "application/json",
        );
        await this.callbacks.emit([
          {
            type: ActionType.ChatResponsePart,
            turnId,
            part: {
              kind: ResponsePartKind.ContentRef,
              uri: ref.uri,
              contentType: ref.mediaType,
              sizeHint: ref.size,
            },
          },
        ]);
        return;
      }
      const thought = u.sessionUpdate === "agent_thought_chunk";
      let partId = thought ? this.thoughtPart : this.textPart;
      if (!partId) {
        partId = `part-${++this.part}`;
        if (thought) this.thoughtPart = partId;
        else this.textPart = partId;
        await this.callbacks.emit([
          {
            type: ActionType.ChatResponsePart,
            turnId,
            part: {
              kind: thought
                ? ResponsePartKind.Reasoning
                : ResponsePartKind.Markdown,
              id: partId,
              content: "",
            },
          },
        ]);
      }
      for (let start = 0; start < u.content.text.length; start += 4096)
        await this.callbacks.emit([
          {
            type: thought ? ActionType.ChatReasoning : ActionType.ChatDelta,
            turnId,
            partId,
            content: u.content.text.slice(start, start + 4096),
          },
        ]);
    } else if (
      u.sessionUpdate === "tool_call" ||
      u.sessionUpdate === "tool_call_update"
    ) {
      const key = u.toolCallId;
      if (!this.tools.has(key))
        await this.startTool(turnId, key, u.title ?? "Agent tool");
      const tool = this.tools.get(key)!;
      if (tool.denied) return;
      if (!tool.ready && u.status && u.status !== "pending") {
        await this.callbacks.emit([
          {
            type: ActionType.ChatToolCallReady,
            turnId,
            toolCallId: key,
            invocationMessage: tool.title,
            confirmed: ToolCallConfirmationReason.NotNeeded,
          },
        ]);
        tool.ready = true;
      }
      const content = await this.content(u.content);
      if (u.status === "completed" || u.status === "failed")
        await this.callbacks.emit([
          {
            type: ActionType.ChatToolCallComplete,
            turnId,
            toolCallId: key,
            result: {
              success: u.status === "completed",
              pastTenseMessage: tool.title,
              content,
            },
          },
        ]);
      else if (tool.ready && content.length)
        await this.callbacks.emit([
          {
            type: ActionType.ChatToolCallContentChanged,
            turnId,
            toolCallId: key,
            content,
          },
        ]);
    } else {
      // Preserve plans, usage notices, mode changes and future variants without
      // pretending that provider metadata is model context or a known AHP tool.
      const ref = await this.callbacks.blob(
        Buffer.from(JSON.stringify(u)),
        "application/json",
      );
      await this.callbacks.emit([
        {
          type: ActionType.ChatResponsePart,
          turnId,
          part: {
            kind: ResponsePartKind.ContentRef,
            uri: ref.uri,
            contentType: ref.mediaType,
            sizeHint: ref.size,
          },
        },
      ]);
    }
  }
  async close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.connection?.close();
    this.connection = null;
    const child = this.process;
    this.process = null;
    if (!child) return;
    const container = containers.get(child);
    if (container) {
      await promisify(execFile)("docker", ["rm", "--force", container], {
        timeout: 5000,
      }).catch(() => {});
      containers.delete(child);
    }
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    const exited = once(child, "exit").catch(() => {});
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (
          this.launch.isolation === "native" &&
          process.platform !== "win32" &&
          child.pid
        )
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1500);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Bound an unterminated or oversized ACP frame before the SDK buffers it. */
function frameLimit(): TransformStream<Uint8Array, Uint8Array> {
  let size = 0;
  return new TransformStream({
    transform(chunk, controller) {
      for (const byte of chunk) {
        size = byte === 10 ? 0 : size + 1;
        if (size > 2_000_000) throw new Error("ACP frame exceeds 2 MB");
      }
      controller.enqueue(chunk);
    },
  });
}
