import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { AxpClient } from "./client.js";
import { AcpDriver } from "./acp.js";
import type { AgentLaunch } from "./acp.js";
import { Worktree } from "./git.js";
import type {
  Allowance,
  ExchangeState,
  Grant,
  Lease,
} from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";

export interface SatelliteOptions {
  url: string;
  token: string;
  session: string;
  repository: string;
  agent: AgentLaunch;
  allowance: Allowance;
  perTurn: Allowance;
  enforcement?: Grant["enforcement"];
  leaseMs?: number;
  /** Retain a caller-provided worktree across supervised reconnections. */
  worktree?: Worktree;
}

/** The same satellite runs on a contributor laptop or on project infrastructure. */
export class Satellite extends EventEmitter<{
  status: [string];
  fault: [Error];
  turn: [string];
}> {
  readonly executorId = randomUUID();
  client!: AxpClient;
  worktree!: Worktree;
  lease!: Lease;
  private driver: AcpDriver | null = null;
  private contextRevision = -1;
  private controller: AbortController | null = null;
  private turnId: string | null = null;
  private activeWork: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private dirty = false;
  private checking = false;
  private session: ExchangeState | null = null;
  private finished!: () => void;
  readonly closed = new Promise<void>((resolve) => {
    this.finished = resolve;
  });
  constructor(readonly options: SatelliteOptions) {
    super();
  }

  async start(): Promise<void> {
    try {
      this.client = await AxpClient.connect(
        this.options.url,
        this.options.token,
      );
      await this.client.call("_axp/register", {
        channel: "ahp-root://",
        executorId: this.executorId,
        name: this.options.agent.command,
        placement: "satellite",
        capabilities: [
          "acp/v1",
          "git/bundle",
          `isolation/${this.options.agent.isolation}`,
        ],
        ttlMs: this.options.leaseMs ?? 30_000,
      });
      const state = await this.client.snapshot<ExchangeState>(
        this.options.session,
      );
      this.session = state;
      await this.client.snapshot<ChatState>(state.chat);
      const grantId = this.executorId;
      await this.client.call("_axp/grant", {
        channel: state.resource,
        grantId,
        limit: this.options.allowance,
        enforcement: this.options.enforcement ?? "accounting",
      });
      this.lease = await this.client.call("_axp/claim", {
        channel: state.resource,
        grantId,
        executorId: this.executorId,
        leaseMs: this.options.leaseMs ?? 30_000,
      });
      // Start renewal before checkout/restore so slow disks do not expire a
      // correctly connected executor. Agent output is not a heartbeat.
      this.heartbeat = setInterval(() => {
        void this.renew();
      }, this.lease.heartbeatMs);
      const worktreeId = `session-${this.executorId}`;
      if (this.options.worktree) this.worktree = this.options.worktree;
      else if (state.checkpoint) {
        const blob = await this.client.call("_axp/blobGet", {
          channel: state.resource,
          digest: state.checkpoint.bundle.sha256,
        });
        this.worktree = await Worktree.restore(
          this.options.repository,
          worktreeId,
          state.checkpoint,
          Buffer.from(blob.data, "base64"),
        );
      } else
        this.worktree = await Worktree.create(
          this.options.repository,
          worktreeId,
        );
      this.client.on("action", (event) => {
        if (event.channel === state.resource || event.channel === state.chat)
          this.wake();
      });
      this.client.on("close", () => {
        if (!this.stopped) {
          this.controller?.abort();
          void this.stop(false);
        }
      });
      this.emit(
        "status",
        `Parked at ${state.session} in ${this.worktree.path}`,
      );
      this.wake();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  private async renew(): Promise<void> {
    if (this.stopped || !this.session) return;
    try {
      this.lease = await this.client.call("_axp/renew", {
        channel: this.session.resource,
        epoch: this.lease.epoch,
      });
    } catch (error) {
      this.emit("fault", asError(error));
      this.controller?.abort();
      await this.stop(false);
    }
  }
  private wake(): void {
    this.dirty = true;
    if (this.checking || this.stopped) return;
    this.checking = true;
    void this.check()
      .catch((error) => {
        this.emit("fault", asError(error));
      })
      .finally(() => {
        this.checking = false;
        if (this.dirty && !this.stopped) this.wake();
      });
  }
  private async check(): Promise<void> {
    while (this.dirty && !this.stopped && this.session) {
      this.dirty = false;
      const state = await this.client.snapshot<ExchangeState>(
        this.session.resource,
      );
      const chat = await this.client.snapshot<ChatState>(state.chat);
      if (
        state.lease?.epoch !== this.lease.epoch ||
        state.lease.owner !== this.client.principalId ||
        state.grants[this.lease.grantId]?.revoked
      ) {
        this.controller?.abort();
        await this.stop(false);
        return;
      }
      if (this.turnId && chat.activeTurn?.id !== this.turnId)
        this.controller?.abort();
      if (!this.activeWork && chat.activeTurn) {
        const turnId = chat.activeTurn.id;
        this.activeWork = this.runTurn(state, chat)
          .catch((error) => this.emit("fault", asError(error)))
          .then(() => {})
          .finally(() => {
            this.activeWork = null;
            this.emit("turn", turnId);
            this.wake();
          });
      }
    }
  }
  private async runTurn(state: ExchangeState, chat: ChatState): Promise<void> {
    const turn = chat.activeTurn;
    requireThat(turn, Codes.conflict, "No active turn");
    const controller = new AbortController();
    this.controller = controller;
    this.turnId = turn.id;
    let reserved = false;
    try {
      await this.client.call("_axp/reserve", {
        channel: state.resource,
        epoch: this.lease.epoch,
        turnId: turn.id,
        ceiling: this.options.perTurn,
      });
      reserved = true;
      let prompt = turn.message.text;
      if (!this.driver || this.contextRevision !== state.context.revision) {
        await this.driver?.close();
        const context = await this.client.call("_axp/context", {
          channel: state.resource,
          maxChars: 128_000,
        });
        prompt = `${context.text}\n\nCurrent task:\n${prompt}`;
        this.driver = new AcpDriver(this.options.agent, this.worktree.path, {
          emit: (actions) =>
            this.client
              .call("_axp/emit", {
                channel: state.resource,
                epoch: this.lease.epoch,
                actions,
              })
              .then(() => {}),
          blob: (data, mediaType) =>
            this.client.call("_axp/blobPut", {
              channel: state.resource,
              data: Buffer.from(data).toString("base64"),
              mediaType,
            }),
          permission: (tool, signal) =>
            this.permission(state.chat, this.turnId!, tool, signal),
        });
        await this.driver.start();
        this.contextRevision = state.context.revision;
      }
      const result = await this.driver.prompt(
        turn.id,
        prompt,
        controller.signal,
      );
      if (controller.signal.aborted) {
        await this.driver.close();
        this.driver = null;
        return;
      }
      // Missing USD reporting is never interpreted as a free provider turn.
      const usage = result.usage
        ? {
            ...result.usage,
            costSource: result.costKnown
              ? ("reported" as const)
              : ("reservation" as const),
            costMicros: result.costKnown
              ? result.usage.costMicros
              : this.options.perTurn.costMicros,
          }
        : null;
      if (result.outcome === "complete") {
        await this.worktree.checkpoint(
          this.client,
          state.resource,
          this.lease.epoch,
        );
      }
      await this.client.call("_axp/settle", {
        channel: state.resource,
        epoch: this.lease.epoch,
        turnId: turn.id,
        usage,
        outcome: result.outcome,
      });
      await this.exportHistory();
    } catch (error) {
      await this.driver?.close();
      this.driver = null;
      if (reserved && !controller.signal.aborted) {
        await this.client
          .call("_axp/settle", {
            channel: state.resource,
            epoch: this.lease.epoch,
            turnId: turn.id,
            usage: null,
            outcome: "error",
            error: asError(error).message.slice(0, 4096),
          })
          .catch(() => {});
      }
      if (!controller.signal.aborted) {
        this.emit("fault", asError(error));
        // Budget/context failures must not spin on the same active turn.
        this.controller = null;
        void this.stop();
      }
    } finally {
      this.controller = null;
      this.turnId = null;
    }
  }
  private async permission(
    channel: string,
    turnId: string,
    toolId: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    while (!signal.aborted && !this.stopped) {
      const chat = await this.client.snapshot<ChatState>(channel);
      if (chat.activeTurn?.id !== turnId) return null;
      const part = chat.activeTurn.responseParts.find(
        (p) => p.kind === "toolCall" && p.toolCall.toolCallId === toolId,
      );
      if (
        part?.kind === "toolCall" &&
        "selectedOption" in part.toolCall &&
        part.toolCall.selectedOption
      )
        return part.toolCall.selectedOption.id;
      if (part?.kind === "toolCall" && part.toolCall.status === "cancelled")
        return null;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.client.off("action", done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 1000);
        this.client.once("action", done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    return null;
  }
  async exportHistory(): Promise<string> {
    requireThat(this.session, Codes.conflict, "Satellite has not started");
    const archive = await this.client.call("_axp/export", {
      channel: this.session.resource,
    });
    const path = join(this.options.repository, ".axp", "history");
    await mkdir(path, { recursive: true, mode: 0o700 });
    const file = join(
      path,
      `${this.session.resource.slice("axp-session:/".length)}.json`,
    );
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(archive, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, file);
    return file;
  }
  async stop(release = true): Promise<void> {
    if (this.stopped) return this.closed;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.controller?.abort();
    await this.driver?.close();
    this.driver = null;
    if (release && this.lease && this.session) {
      await this.client
        .call("_axp/release", {
          channel: this.session.resource,
          epoch: this.lease.epoch,
        })
        .catch(() => {});
      await this.exportHistory().catch(() => {});
    }
    await this.client?.close();
    this.finished();
    this.emit("status", "Undocked; Git worktree and local history retained");
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
