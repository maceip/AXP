import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { TransportError } from "@microsoft/agent-host-protocol/client";
import { writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { AxpClient } from "./client.js";
import { AcpDriver } from "./acp.js";
import type { SatelliteOptions } from "./satellite.js";
import type { Worktree } from "./git.js";
import type { Envelope, ExchangeState, Lease } from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";

/** One connected lease. The supervisor never reuses a runner or its ACP process. */
export class LeaseRunner extends EventEmitter<{
  turn: [string];
}> {
  worktree!: Worktree;
  private driver: AcpDriver | null = null;
  private contextRevision = -1;
  private controller: AbortController | null = null;
  private turnId: string | null = null;
  private activeWork: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  private checking: Promise<void> | null = null;
  private stopped = false;
  private prepared = false;
  private dirty = false;
  private readonly ended = Promise.withResolvers<Error | null>();
  readonly closed = this.ended.promise;
  private stopping: Promise<void> | null = null;
  private readonly disconnected = () =>
    this.end(
      this.client.transport.failure ??
        new TransportError("closed", "Contributor connection lost"),
    );
  private readonly changed = (event: Envelope) => {
    // Output is already committed by this runner. Only control transitions can
    // change which turn it should run; rereading full history per token is quadratic.
    if (
      (event.channel === this.session.resource &&
        [
          "_axp/leaseChanged",
          "_axp/grantChanged",
          "_axp/contextChanged",
        ].includes(event.action.type)) ||
      (event.channel === this.session.chat &&
        [
          ActionType.ChatTurnStarted,
          ActionType.ChatTurnCancelled,
          ActionType.ChatTurnComplete,
          ActionType.ChatError,
        ].some((type) => type === event.action.type))
    )
      this.wake();
  };
  get isStopped(): boolean {
    return this.stopped;
  }

  constructor(
    readonly options: SatelliteOptions,
    readonly client: AxpClient,
    readonly session: ExchangeState,
    public lease: Lease,
  ) {
    super();
    client.on("close", this.disconnected);
    client.on("action", this.changed);
  }

  async start(prepare: () => Promise<Worktree>): Promise<void> {
    // Heartbeats also cover a slow initial checkout or bundle restore.
    this.heartbeat = setInterval(() => {
      if (!this.renewing && !this.stopped) {
        this.renewing = this.renew().finally(() => {
          this.renewing = null;
        });
      }
    }, this.lease.heartbeatMs);
    this.worktree = await prepare();
    this.prepared = true;
    if (!this.stopped) this.wake();
  }

  end(error: Error | null = null): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller?.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ended.resolve(error);
  }
  private async renew(): Promise<void> {
    if (this.stopped || !this.session) return;
    try {
      this.lease = await this.client.call("_axp/renew", {
        channel: this.session.resource,
        epoch: this.lease.epoch,
      });
    } catch (error) {
      this.end(asError(error));
    }
  }
  private wake(): void {
    this.dirty = true;
    if (this.checking || this.stopped || !this.prepared) return;
    this.checking = this.check()
      .catch((error) => {
        this.end(asError(error));
      })
      .finally(() => {
        this.checking = null;
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
      if (this.stopped) return;
      if (
        state.lease?.epoch !== this.lease.epoch ||
        state.lease.owner !== this.client.principalId ||
        state.grants[this.lease.grantId]?.revoked
      ) {
        requireThat(
          false,
          Codes.stale,
          "Session ownership changed or donation revoked",
        );
      }
      if (this.turnId && chat.activeTurn?.id !== this.turnId)
        this.controller?.abort();
      if (!this.activeWork && chat.activeTurn) {
        const turnId = chat.activeTurn.id;
        this.activeWork = this.runTurn(state, chat)
          .catch((error: unknown) => this.end(asError(error)))
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
      controller.signal.throwIfAborted();
      let prompt = turn.message.text;
      if (!this.driver || this.contextRevision !== state.context.revision) {
        await this.driver?.close();
        const context = await this.client.call("_axp/context", {
          channel: state.resource,
          maxChars: 128_000,
        });
        controller.signal.throwIfAborted();
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
        controller.signal.throwIfAborted();
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
        // Budget/context failures must not spin on the same active turn.
        this.end(asError(error));
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
      if (signal.aborted || this.stopped) return null;
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
  stop(release = true): Promise<void> {
    this.end();
    this.stopping ??= this.cleanup(release);
    return this.stopping;
  }
  private async cleanup(release: boolean): Promise<void> {
    this.client.off("close", this.disconnected);
    this.client.off("action", this.changed);
    const driverClosed = this.driver?.close();
    if (release) {
      await this.client
        .call("_axp/release", {
          channel: this.session.resource,
          epoch: this.lease.epoch,
        })
        .catch(() => {});
      await this.exportHistory().catch(() => {});
    }
    await this.client.close();
    await driverClosed;
    // No callback from an old epoch may reach a replacement connection/tree.
    await Promise.all([this.activeWork, this.checking, this.renewing]);
    this.driver = null;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
