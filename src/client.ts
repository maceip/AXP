import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AhpClient } from "@microsoft/agent-host-protocol/client";
import { PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
import type { StateAction } from "@microsoft/agent-host-protocol";
import { SocketTransport } from "./transport.js";
import { methods } from "./protocol/schema.js";
import type { Method, InputParams } from "./protocol/schema.js";
import type {
  BlobRef,
  ChannelSnapshot,
  CompactionProposal,
  Context,
  Envelope,
  Grant,
  Lease,
  Memory,
  Review,
  ExecutorInfo,
  DiscussionComment,
  Principal,
} from "./protocol/types.js";
import { CAPABILITY, AXP_VERSION, ROOT } from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";

export interface ConnectOptions {
  /** Cancels socket establishment and initialize; not subsequent requests. */
  signal?: AbortSignal;
  /** Passed to the upstream AHP client; defaults to 30000 ms. */
  requestTimeoutMs?: number;
}

export interface CommandResults {
  "_axp/comment": DiscussionComment;
  "_axp/dispatch": null;
  "_axp/register": ExecutorInfo;
  "_axp/grant": Grant;
  "_axp/revoke": null;
  "_axp/claim": Lease;
  "_axp/renew": Lease;
  "_axp/release": null;
  "_axp/close": null;
  "_axp/reserve": null;
  "_axp/settle": null;
  "_axp/emit": null;
  "_axp/checkpoint": null;
  "_axp/compact": CompactionProposal;
  "_axp/acceptCompaction": Context;
  "_axp/memoryPropose": Memory;
  "_axp/memoryReview": Memory;
  "_axp/memorySearch": { items: Memory[]; total: number };
  "_axp/review": Review;
  "_axp/approveReview": Review;
  "_axp/verify": null;
  "_axp/export": {
    version: string;
    repository: string;
    serverSeq: number;
    seeds: ChannelSnapshot[];
    actions: Envelope[];
    snapshots: ChannelSnapshot[];
  };
  "_axp/context": {
    text: string;
    prefixHash: string;
    revision: number;
    throughTurn: number;
    memoryTotal: number;
    memoryIncluded: number;
  };
  "_axp/blobPut": BlobRef;
  "_axp/blobGet": { data: string; mediaType: string };
}

export class AxpClient extends EventEmitter<{
  action: [Envelope];
  close: [];
  notification: [unknown];
}> {
  readonly ahp: AhpClient;
  lastSeenServerSeq = 0;
  private clientSeq = 0;
  principalId = "";
  repository = "";
  principalRole: Principal["role"] = "observer";
  private constructor(
    readonly transport: SocketTransport,
    readonly clientId: string,
    options: ConnectOptions,
  ) {
    super();
    this.ahp = new AhpClient(transport, options);
    transport.onClose = () => this.emit("close");
    transport.onMessage = (value) => {
      if (!value || typeof value !== "object") return;
      const message = value as { method?: string; params?: unknown };
      if (message.method === "action") {
        const envelope = message.params as Envelope;
        this.lastSeenServerSeq = Math.max(
          this.lastSeenServerSeq,
          envelope.serverSeq,
        );
        this.emit("action", envelope);
      } else if (message.method) this.emit("notification", value);
    };
    this.ahp.connect();
  }
  static async connect(
    url: string,
    token: string,
    clientId: string = randomUUID(),
    options: ConnectOptions = {},
  ): Promise<AxpClient> {
    const client = new AxpClient(
      await SocketTransport.connect(url, token, options.signal),
      clientId,
      options,
    );
    const abort = () => client.transport.socket.terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      const result = await client.ahp.initialize({
        clientId,
        protocolVersions: [PROTOCOL_VERSION],
        initialSubscriptions: [ROOT],
      });
      const capability = result._meta?.[CAPABILITY] as
        | {
            version?: string;
            principal?: string;
            role?: Principal["role"];
            repository?: string;
            lastClientSeq?: number;
          }
        | undefined;
      requireThat(
        capability?.version === AXP_VERSION,
        Codes.version,
        "Host does not support this AXP version",
      );
      client.principalId = capability.principal ?? "";
      client.repository = capability.repository ?? "";
      client.principalRole = capability.role ?? "observer";
      client.clientSeq = capability.lastClientSeq ?? 0;
      client.lastSeenServerSeq = result.serverSeq;
      return client;
    } catch (error) {
      await client.close();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }
  /** Durable operationId is supplied by applications when retries must survive
   * a caller restart. The same ID with different parameters is rejected. */
  async call<M extends Method>(
    method: M,
    input: Omit<InputParams<M>, "operationId"> & { operationId?: string },
  ): Promise<CommandResults[M]> {
    const shape = methods[method].shape;
    const params = methods[method].parse(
      "operationId" in shape
        ? { ...input, operationId: input.operationId ?? randomUUID() }
        : input,
    );
    // Upstream deliberately restricts its public method map to AHP. This one
    // boundary adds negotiated extension methods without forking its client.
    const request = this.ahp.request.bind(this.ahp) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    return (await request(method, params)) as CommandResults[M];
  }
  async snapshot<T>(channel: string): Promise<T> {
    const { snapshot } = await this.ahp.request("subscribe", { channel });
    requireThat(snapshot, Codes.missing, "Host returned no snapshot");
    this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, snapshot.fromSeq);
    return snapshot.state as T;
  }
  /** Use a request for actionable rejection errors; unmodified AHP notification
   * dispatch remains supported and receives the standard rejection echo. */
  async dispatch(
    channel: string,
    action: StateAction,
    operationId?: string,
  ): Promise<void> {
    if (operationId) {
      await this.call("_axp/dispatch", { channel, action, operationId });
      return;
    }
    const request = this.ahp.request.bind(this.ahp) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    await request("dispatchAction", {
      channel,
      action,
      clientSeq: ++this.clientSeq,
    });
  }
  async close(): Promise<void> {
    await this.ahp.shutdown();
  }
}
