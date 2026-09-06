import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClientClosedError,
  RpcTimeoutError,
  TransportError,
} from "@microsoft/agent-host-protocol/client";
import { AxpClient } from "./client.js";
import type { AgentLaunch } from "./acp.js";
import { Worktree } from "./git.js";
import { LeaseRunner } from "./satellite-runner.js";
import { UpgradeError } from "./transport.js";
import { reserve } from "./budget.js";
import type {
  Allowance,
  ExchangeState,
  Grant,
  Lease,
} from "./protocol/types.js";
import type { InputParams } from "./protocol/schema.js";
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
  /** An explicitly supplied local worktree for the initial connection. */
  worktree?: Worktree;
  /** Transient failures retry by default, with jittered exponential backoff. */
  reconnect?: false | { initialDelayMs?: number; maxDelayMs?: number };
}
export type SatelliteState =
  "connecting" | "parked" | "reconnecting" | "stopped";

/** One donation and local worktree across connection failures. A new epoch gets
 * a new ACP process; an interrupted prompt is never automatically replayed. */
export class Satellite extends EventEmitter<{
  status: [string];
  state: [SatelliteState];
  fault: [Error];
  turn: [string];
}> {
  readonly executorId = randomUUID();
  client!: AxpClient;
  worktree!: Worktree;
  private previousLease!: Lease;
  private runner: LeaseRunner | null = null;
  private readonly controller = new AbortController();
  private readonly ready = Promise.withResolvers<void>();
  private readonly finished = Promise.withResolvers<void>();
  readonly closed = this.finished.promise;
  private running: Promise<void> | null = null;
  private readonly grantOperation = randomUUID();
  private grantEstablished = false;
  private pendingClaim: InputParams<"_axp/claim"> | null = null;
  private currentState: SatelliteState = "connecting";
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(readonly options: SatelliteOptions) {
    super();
    const retry = options.reconnect || {};
    this.initialDelayMs = retry.initialDelayMs ?? 500;
    this.maxDelayMs = retry.maxDelayMs ?? 30_000;
    requireThat(
      Number.isSafeInteger(this.initialDelayMs) &&
        this.initialDelayMs >= 10 &&
        Number.isSafeInteger(this.maxDelayMs) &&
        this.maxDelayMs >= this.initialDelayMs &&
        this.maxDelayMs <= 300_000,
      Codes.invalid,
      "Reconnect delays must be integers between 10 and 300000 ms, with maximum >= initial",
    );
  }
  get state(): SatelliteState {
    return this.currentState;
  }
  get lease(): Lease {
    return this.runner?.lease ?? this.previousLease;
  }
  private transition(state: SatelliteState, message: string): void {
    this.currentState = state;
    this.emit("state", state);
    this.emit("status", message);
  }
  async start(): Promise<void> {
    requireThat(
      !this.running && !this.controller.signal.aborted,
      Codes.conflict,
      "A satellite can only be started once",
    );
    this.transition("connecting", "Connecting parked agent");
    this.running = this.supervise()
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) this.emit("fault", asError(error));
        this.ready.reject(error);
      })
      .finally(() => {
        this.ready.reject(new Error("Satellite stopped before parking"));
        this.transition(
          "stopped",
          "Undocked; Git worktree and local history retained",
        );
        this.finished.resolve();
      });
    return this.ready.promise;
  }
  private async supervise(): Promise<void> {
    let backoff = this.initialDelayMs;
    const signal = this.controller.signal;
    while (!signal.aborted) {
      const since = Date.now();
      let retry: Error | null = null;
      try {
        this.client = await AxpClient.connect(
          this.options.url,
          this.options.token,
          randomUUID(),
          {
            signal,
            // Detect a silent half-open socket on the heartbeat timescale,
            // instead of waiting for the upstream default of 30 seconds.
            requestTimeoutMs: Math.floor((this.options.leaseMs ?? 30_000) / 3),
          },
        );
        signal.throwIfAborted();
        const state = await this.claim();
        signal.throwIfAborted();
        this.runner = new LeaseRunner(
          this.options,
          this.client,
          state,
          this.lease,
        );
        this.runner.on("turn", (id) => this.emit("turn", id));
        await this.runner.start(async () => {
          if (!this.worktree) {
            if (this.options.worktree) this.worktree = this.options.worktree;
            else if (state.checkpoint) {
              const blob = await this.client.call("_axp/blobGet", {
                channel: state.resource,
                digest: state.checkpoint.bundle.sha256,
              });
              this.worktree = await Worktree.restore(
                this.options.repository,
                `session-${this.executorId}`,
                state.checkpoint,
                Buffer.from(blob.data, "base64"),
              );
            } else
              this.worktree = await Worktree.create(
                this.options.repository,
                `session-${this.executorId}`,
              );
          }
          return this.worktree;
        });
        if (signal.aborted) this.runner.end();
        else if (!this.runner.isStopped) {
          this.transition(
            "parked",
            `Parked at ${state.session} in ${this.worktree.path} (epoch ${this.lease.epoch})`,
          );
          this.ready.resolve();
        }
        const error = await this.runner.closed;
        if (error) throw error;
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (this.options.reconnect === false || !retryable(error)) throw error;
        retry = asError(error);
      } finally {
        if (this.runner) await this.runner.stop(!retry);
        else {
          if (!retry && this.lease && this.client)
            await this.client
              .call("_axp/release", {
                channel: this.options.session,
                epoch: this.lease.epoch,
              })
              .catch(() => {});
          await this.client?.close();
        }
        this.runner = null;
      }
      if (Date.now() - since >= 60_000) backoff = this.initialDelayMs;
      const wait = Math.floor(backoff * (0.5 + Math.random() * 0.5));
      this.transition(
        "reconnecting",
        `${retry!.message}; reconnecting in ${wait} ms with the original donation`,
      );
      await delay(wait, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, this.maxDelayMs);
    }
  }
  private async claim(): Promise<ExchangeState> {
    const channel = this.options.session;
    await this.client.call("_axp/register", {
      channel: "ahp-root://",
      executorId: this.executorId,
      name: basename(this.options.agent.command).slice(0, 128),
      placement: "satellite",
      capabilities: [
        "acp/v1",
        "git/bundle",
        `isolation/${this.options.agent.isolation}`,
      ],
      ttlMs: this.options.leaseMs ?? 30_000,
    });
    let state = await this.client.snapshot<ExchangeState>(channel);
    requireThat(state.status !== "closed", Codes.conflict, "Session is closed");
    // Shared state or the original receipt resolves an uncertain grant. Never
    // reset spending, widen a changed limit, or undo donor revocation.
    if (!state.grants[this.executorId]) {
      requireThat(
        !this.grantEstablished,
        Codes.missing,
        "The original donation is missing; automatic recovery stopped",
      );
      await this.client.call("_axp/grant", {
        channel,
        operationId: this.grantOperation,
        grantId: this.executorId,
        limit: this.options.allowance,
        enforcement: this.options.enforcement ?? "accounting",
      });
    }
    this.grantEstablished = true;
    // A claim can commit just before its response is lost. Resolve that exact
    // receipt before attempting recovery; never guess whether it executed.
    if (this.pendingClaim) {
      this.previousLease = await this.client.call(
        "_axp/claim",
        this.pendingClaim,
      );
      this.pendingClaim = null;
    }
    this.pendingClaim = {
      channel,
      operationId: randomUUID(),
      executorId: this.executorId,
      grantId: this.executorId,
      leaseMs: this.options.leaseMs ?? 30_000,
      ...(this.lease ? { resumeEpoch: this.lease.epoch } : {}),
    };
    this.previousLease = await this.client.call(
      "_axp/claim",
      this.pendingClaim,
    );
    this.pendingClaim = null;
    state = await this.client.snapshot<ExchangeState>(channel);
    requireThat(
      state.lease?.epoch === this.lease.epoch &&
        state.lease.executorId === this.executorId,
      Codes.stale,
      "Session ownership changed while parking",
    );
    const grant = state.grants[this.executorId];
    requireThat(grant, Codes.budget, "Donation is missing");
    reserve(grant, this.options.perTurn);
    return state;
  }
  async exportHistory(): Promise<string> {
    requireThat(
      this.runner && this.state === "parked",
      Codes.conflict,
      "Satellite is not connected",
    );
    return this.runner.exportHistory();
  }
  async stop(): Promise<void> {
    this.controller.abort();
    this.runner?.end();
    if (!this.runner) this.client?.transport.socket.terminate();
    if (this.running) await this.running;
    else {
      this.transition("stopped", "Undocked");
      this.finished.resolve();
    }
  }
}
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
function retryable(error: unknown): boolean {
  if (error instanceof UpgradeError)
    return [408, 429, 502, 503, 504].includes(error.status);
  if (error instanceof TransportError) return error.kind !== "protocol";
  if (error instanceof RpcTimeoutError || error instanceof ClientClosedError)
    return true;
  if (error instanceof Error && "code" in error)
    return [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EPIPE",
    ].includes(String(error.code));
  return (
    error instanceof Error &&
    error.message === "Opening handshake has timed out"
  );
}
