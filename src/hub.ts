import { createServer } from "node:http";
import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
import type { SessionState } from "@microsoft/agent-host-protocol";
import { Store } from "./store.js";
import type { Transaction } from "./store.js";
import { Sessions } from "./sessions.js";
import { Knowledge } from "./knowledge.js";
import { Artifacts } from "./artifacts.js";
import { Codes, ProtocolError, requireThat } from "./protocol/errors.js";
import { methods, id, channel, count } from "./protocol/schema.js";
import {
  ROOT,
  CAPABILITY,
  AXP_VERSION,
  MEMORY,
  EXECUTORS,
} from "./protocol/types.js";
import type { ExecutorRegistry } from "./protocol/types.js";
import type { Principal, Envelope, ExchangeState } from "./protocol/types.js";
import { hash, hashObject } from "./hash.js";

export interface Credential {
  token: string;
  principal: Principal;
}
export interface HubOptions {
  repository: string;
  database?: string;
  credentials: Credential[];
  host?: string;
  port?: number;
  now?: () => number;
  replayLimit?: number;
  maxBufferedBytes?: number;
  maxBlobBytes?: number;
  maxStorageBytes?: number;
  allowedOrigins?: string[];
}
interface Peer {
  ws: WebSocket;
  actor: Principal;
  clientId: string | null;
  subscriptions: Set<string>;
}
const request = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().max(128),
  params: z.record(z.string(), z.unknown()).default({}),
});
const initialize = z.object({
  channel: z.literal(ROOT),
  clientId: id,
  protocolVersions: z.array(z.string()).max(32),
  initialSubscriptions: z.array(channel).max(256).default([]),
});
const reconnect = z.object({
  channel: z.literal(ROOT),
  clientId: id,
  lastSeenServerSeq: count,
  subscriptions: z.array(channel).max(256),
});

/** One repository per host. Model keys never pass through this server. */
export class Hub {
  readonly store: Store;
  readonly sessions: Sessions;
  readonly knowledge: Knowledge;
  readonly artifacts: Artifacts;
  private readonly peers = new Set<Peer>();
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tokens: { digest: Buffer; principal: Principal }[];
  private listening = false;

  constructor(readonly options: HubOptions) {
    requireThat(
      options.credentials.length > 0 &&
        options.credentials.every((c) => c.token.length >= 24),
      Codes.invalid,
      "Configure unique random access tokens of at least 24 characters",
    );
    requireThat(
      new Set(options.credentials.map((c) => c.token)).size ===
        options.credentials.length,
      Codes.invalid,
      "Access tokens must be unique",
    );
    this.tokens = options.credentials.map((c) => ({
      digest: Buffer.from(hash(c.token), "hex"),
      principal: structuredClone(c.principal),
    }));
    this.store = new Store(options.database);
    this.sessions = new Sessions(this.store, options.repository, options.now);
    this.knowledge = new Knowledge(this.sessions);
    this.artifacts = new Artifacts(this.sessions);
    // A new host process cannot vouch for any old in-flight execution. Fence
    // it immediately rather than waiting for an old wall-clock lease to end.
    this.store.transaction((tx) => {
      for (const executor of Object.values(
        this.store.get<ExecutorRegistry>(EXECUTORS).entries,
      ))
        if (executor.online)
          tx.emit(EXECUTORS, {
            type: "_axp/executorChanged",
            executor: { ...executor, online: false },
          });
      for (const resource of this.store.list("axp-session:/")) {
        const state = this.sessions.state(resource);
        if (state.lease)
          this.sessions.orphan(tx, state, "Host restarted; reclaim to resume");
      }
    });
    this.http = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", protocol: AXP_VERSION }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload:
        Math.ceil(((options.maxBlobBytes ?? 16_000_000) * 4) / 3) + 4096,
      perMessageDeflate: false,
    });
    this.http.on("upgrade", (req, socket, head) => {
      const auth = req.headers.authorization;
      const digest = Buffer.from(
        hash(auth?.startsWith("Bearer ") ? auth.slice(7) : ""),
        "hex",
      );
      const credential = this.tokens.find((c) =>
        timingSafeEqual(c.digest, digest),
      );
      const origin = req.headers.origin;
      if (
        req.url !== "/axp" ||
        !credential ||
        (origin && !options.allowedOrigins?.includes(origin)) ||
        this.peers.size >= 2048
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.accept(ws, credential.principal),
      );
    });
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(
        this.options.port ?? 0,
        this.options.host ?? "127.0.0.1",
        () => {
          this.http.off("error", reject);
          resolve();
        },
      );
    });
    this.listening = true;
    const address = this.http.address();
    requireThat(
      address && typeof address === "object",
      Codes.internal,
      "Server did not bind a TCP port",
    );
    return `ws://${this.options.host ?? "127.0.0.1"}:${address.port}/axp`;
  }
  tick(): void {
    this.broadcast(
      this.store.transaction((tx) => this.sessions.tick(tx)).events,
    );
  }
  private accept(ws: WebSocket, actor: Principal): void {
    const peer: Peer = { ws, actor, clientId: null, subscriptions: new Set() };
    this.peers.add(peer);
    const handshake = setTimeout(() => {
      if (!peer.clientId) ws.close(1008, "Initialize required");
    }, 10_000);
    handshake.unref();
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      clearTimeout(handshake);
      this.peers.delete(peer);
    });
    ws.on("message", (data, binary) => {
      if (binary) {
        ws.close(1003, "JSON text frames required");
        return;
      }
      this.receive(peer, data.toString());
    });
  }
  private send(peer: Peer, value: unknown): void {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > (this.options.maxBufferedBytes ?? 2_000_000)) {
      peer.ws.terminate();
      return;
    }
    peer.ws.send(JSON.stringify(value));
  }
  private broadcast(events: Envelope[]): void {
    for (const envelope of events) {
      for (const peer of this.peers)
        if (peer.subscriptions.has(envelope.channel))
          this.send(peer, {
            jsonrpc: "2.0",
            method: "action",
            params: envelope,
          });
      if (envelope.channel.startsWith("ahp-session:/")) {
        const state = this.store.get<SessionState>(envelope.channel);
        this.notifyRoot(
          "root/sessionSummaryChanged",
          {
            session: envelope.channel,
            changes: {
              title: state.title,
              status: state.chats[0]?.status ?? state.status,
            },
          },
          envelope.channel,
        );
      }
    }
  }
  private notifyRoot(method: string, params: object, session: string): void {
    for (const peer of this.peers)
      if (
        peer.subscriptions.has(ROOT) &&
        this.sessions.readable(peer.actor, session)
      )
        this.send(peer, {
          jsonrpc: "2.0",
          method,
          params: { channel: ROOT, ...params },
        });
  }
  private allowed(peer: Peer, resource: string): void {
    this.sessions.authorize(peer.actor, resource);
    if (resource === MEMORY) {
      this.sessions.maintain(peer.actor);
      requireThat(
        peer.actor.sessions === "*",
        Codes.forbidden,
        "Direct memory subscription requires repository-wide authority; use scoped search",
      );
    }
    requireThat(this.store.has(resource), Codes.missing, "Unknown channel");
  }
  private receive(peer: Peer, text: string): void {
    let message: z.infer<typeof request> | undefined;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new ProtocolError(-32700, "Invalid JSON");
      }
      const checked = request.safeParse(parsed);
      requireThat(checked.success, -32600, "Invalid JSON-RPC request");
      message = checked.data;
      requireThat(
        text.length <= 65_536 || message.method === "_axp/blobPut",
        Codes.limit,
        "Message too large; use a content reference",
      );
      const result = this.handle(peer, message.method, message.params);
      if (message.id !== undefined)
        this.send(peer, { jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      const failure =
        error instanceof ProtocolError
          ? error
          : error instanceof z.ZodError
            ? new ProtocolError(
                Codes.invalid,
                "Invalid parameters",
                error.issues.map((i) => ({ path: i.path, message: i.message })),
              )
            : new ProtocolError(Codes.internal, "Internal host error");
      if (message?.id !== undefined || !message)
        this.send(peer, {
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: {
            code: failure.code,
            message: failure.message,
            ...(failure.data ? { data: failure.data } : {}),
          },
        });
      else if (message.method === "dispatchAction")
        this.send(peer, {
          jsonrpc: "2.0",
          method: "action",
          params: {
            channel: message.params.channel,
            action: message.params.action,
            serverSeq: this.store.seq,
            origin: {
              clientId: peer.clientId,
              clientSeq: message.params.clientSeq,
            },
            rejectionReason: failure.message,
          },
        });
    }
  }
  private handle(
    peer: Peer,
    method: string,
    params: Record<string, unknown>,
  ): unknown {
    if (method === "ping") {
      z.object({ channel: z.literal(ROOT) }).parse(params);
      return null;
    }
    if (method === "initialize") {
      requireThat(
        !peer.clientId,
        Codes.conflict,
        "Connection already initialized",
      );
      const p = initialize.parse(params);
      if (!p.protocolVersions.includes(PROTOCOL_VERSION))
        throw new ProtocolError(Codes.version, "Unsupported AHP version", {
          supportedVersions: [PROTOCOL_VERSION],
        });
      for (const resource of p.initialSubscriptions)
        this.allowed(peer, resource);
      this.store.bindClient(p.clientId, peer.actor.id);
      peer.clientId = p.clientId;
      peer.subscriptions = new Set(p.initialSubscriptions);
      return {
        protocolVersion: PROTOCOL_VERSION,
        serverSeq: this.store.seq,
        serverInfo: { name: "axp", version: AXP_VERSION },
        _meta: {
          [CAPABILITY]: {
            version: AXP_VERSION,
            methods: Object.keys(methods),
            role: peer.actor.role,
            principal: peer.actor.id,
            memory: MEMORY,
          },
        },
        snapshots: p.initialSubscriptions.map((c) => this.store.snapshot(c)),
      };
    }
    if (method === "reconnect") {
      requireThat(
        !peer.clientId,
        Codes.conflict,
        "Reconnect requires a fresh connection",
      );
      const p = reconnect.parse(params);
      requireThat(
        p.lastSeenServerSeq <= this.store.seq,
        Codes.invalid,
        "Replay cursor is in the future",
      );
      this.store.bindClient(p.clientId, peer.actor.id);
      peer.clientId = p.clientId;
      const missing: string[] = [];
      for (const c of p.subscriptions) {
        try {
          this.allowed(peer, c);
          peer.subscriptions.add(c);
        } catch {
          missing.push(c);
        }
      }
      if (
        this.store.seq - p.lastSeenServerSeq >
        (this.options.replayLimit ?? 4096)
      )
        return {
          type: "snapshot",
          snapshots: [...peer.subscriptions].map((c) => this.store.snapshot(c)),
          missing,
        };
      return {
        type: "replay",
        actions: this.store.events(
          [...peer.subscriptions],
          p.lastSeenServerSeq,
        ),
        missing,
      };
    }
    requireThat(
      peer.clientId,
      Codes.forbidden,
      "Initialize before using sessions",
    );
    if (method === "subscribe") {
      const p = z.object({ channel }).parse(params);
      this.allowed(peer, p.channel);
      requireThat(
        peer.subscriptions.size < 256 || peer.subscriptions.has(p.channel),
        Codes.limit,
        "Subscription limit reached",
      );
      peer.subscriptions.add(p.channel);
      return { snapshot: this.store.snapshot(p.channel) };
    }
    if (method === "unsubscribe") {
      peer.subscriptions.delete(channel.parse(params.channel));
      return null;
    }
    if (method === "listSessions") {
      z.object({ channel: z.literal(ROOT) }).parse(params);
      const items = this.store
        .list("ahp-session:/")
        .filter((c) => this.sessions.readable(peer.actor, c))
        .map((c) => {
          const s = this.store.get<SessionState>(c);
          return {
            resource: c,
            provider: s.provider,
            title: s.title,
            status: s.chats[0]?.status ?? s.status,
          };
        });
      return { items };
    }
    if (method === "createSession") {
      const p = z
        .object({
          channel,
          provider: z.literal("axp").optional(),
          config: z
            .object({
              title: z.string().max(256).optional(),
              task: z.string().max(512).optional(),
            })
            .optional(),
        })
        .parse(params);
      const { result } = this.store.transaction((tx) =>
        this.sessions.create(
          tx,
          peer.actor,
          p.channel,
          p.config?.title ?? "Contribution session",
          p.config?.task ?? p.channel,
        ),
      );
      const s = this.store.get<SessionState>(result.session);
      this.notifyRoot(
        "root/sessionAdded",
        {
          summary: {
            resource: result.session,
            provider: "axp",
            title: s.title,
            status: s.status,
          },
        },
        result.session,
      );
      return null;
    }
    if (method === "dispatchAction") {
      const p = z
        .object({ channel, clientSeq: count, action: z.unknown() })
        .parse(params);
      this.allowed(peer, p.channel);
      return this.mutate(
        peer.actor.id,
        `dispatch:${peer.clientId}:${p.clientSeq}`,
        { method, params: p },
        (tx) => {
          this.sessions.dispatch(tx, peer.actor, p.channel, p.action, {
            clientId: peer.clientId!,
            clientSeq: p.clientSeq,
          });
          return null;
        },
      );
    }
    if (method === "resourceRead") {
      const p = z
        .object({ channel: z.literal(ROOT), uri: z.string() })
        .parse(params);
      const match = /^axp-blob:\/([^/]+)\/([a-f0-9]{64})$/.exec(p.uri);
      requireThat(
        match,
        Codes.forbidden,
        "Only AXP blob resources are readable",
      );
      const resource = decodeURIComponent(match[1]!);
      this.allowed(peer, resource);
      const blob = this.blobGet(resource, match[2]!);
      return {
        data: blob.data,
        contentType: blob.mediaType,
        encoding: "base64",
      };
    }
    requireThat(Object.hasOwn(methods, method), Codes.method, "Unknown method");
    const key = method as keyof typeof methods;
    const p = methods[key].parse(params);
    this.allowed(peer, p.channel);
    if (key === "_axp/blobGet") {
      const q = methods[key].parse(p);
      return this.blobGet(this.sessions.state(q.channel).resource, q.digest);
    }
    if (key === "_axp/export") {
      const s = this.sessions.state(p.channel);
      const resources = [
        s.resource,
        s.session,
        s.chat,
        s.session.replace("ahp-session:", "ahp-changeset:"),
      ];
      return {
        version: AXP_VERSION,
        repository: s.repository,
        serverSeq: this.store.seq,
        seeds: this.store.seeds(resources),
        actions: this.store.events(resources),
        snapshots: resources.map((c) => this.store.snapshot(c)),
      };
    }
    if (key === "_axp/context") {
      const q = methods[key].parse(p);
      return this.knowledge.context(
        peer.actor,
        this.sessions.state(q.channel),
        q.maxChars,
      );
    }
    if (key === "_axp/memorySearch") {
      const q = methods[key].parse(p);
      return this.knowledge.search(peer.actor, q.query, q.limit);
    }
    requireThat(
      "operationId" in p,
      Codes.invalid,
      "Mutation requires an operation ID",
    );
    return this.mutate(
      peer.actor.id,
      id.parse(p.operationId),
      { method, params: p },
      (tx) => this.extension(tx, peer.actor, key, p),
    );
  }
  private mutate(
    owner: string,
    key: string,
    input: unknown,
    work: (tx: Transaction) => unknown,
  ): unknown {
    const fingerprint = hashObject(input);
    const committed = this.store.transaction((tx) => {
      const prior = this.store.receipt(owner, key, fingerprint);
      if (prior) return prior.result;
      const result = work(tx);
      tx.receipt(owner, key, fingerprint, result);
      return result;
    });
    this.broadcast(committed.events);
    return committed.result;
  }
  private extension(
    tx: Transaction,
    actor: Principal,
    method: keyof typeof methods,
    raw: unknown,
  ): unknown {
    const p = methods[method].parse(raw);
    if (method === "_axp/register")
      return this.sessions.register(tx, actor, methods[method].parse(p));
    if (method === "_axp/memoryReview") {
      const q = methods[method].parse(p);
      return this.knowledge.review(tx, actor, q.memoryId, q.revision, q.status);
    }
    const s: ExchangeState = this.sessions.state(p.channel);
    switch (method) {
      case "_axp/close":
        this.sessions.close(tx, actor, s);
        break;
      case "_axp/grant": {
        const q = methods[method].parse(p);
        return this.sessions.grant(
          tx,
          actor,
          s,
          q.grantId,
          q.limit,
          q.enforcement,
        );
      }
      case "_axp/revoke": {
        const q = methods[method].parse(p);
        this.sessions.revoke(tx, actor, s, q.grantId);
        break;
      }
      case "_axp/claim": {
        const q = methods[method].parse(p);
        return this.sessions.claim(
          tx,
          actor,
          s,
          q.executorId,
          q.grantId,
          q.leaseMs,
        );
      }
      case "_axp/renew": {
        const q = methods[method].parse(p);
        return this.sessions.renew(tx, actor, s, q.epoch);
      }
      case "_axp/release": {
        const q = methods[method].parse(p);
        this.sessions.fenced(actor, s, q.epoch);
        this.sessions.orphan(tx, s, "Executor undocked");
        break;
      }
      case "_axp/reserve": {
        const q = methods[method].parse(p);
        this.sessions.reserve(tx, actor, s, q.epoch, q.turnId, q.ceiling);
        break;
      }
      case "_axp/settle": {
        const q = methods[method].parse(p);
        this.sessions.fenced(actor, s, q.epoch);
        requireThat(
          s.reservation?.turnId === q.turnId && s.reservation.epoch === q.epoch,
          Codes.stale,
          "Reservation no longer belongs to this turn",
        );
        this.sessions.finish(tx, s, q.usage, q.outcome, q.error);
        if (q.outcome === "complete")
          this.sessions.nextTurn(tx, this.sessions.state(s.resource));
        break;
      }
      case "_axp/emit": {
        const q = methods[method].parse(p);
        this.sessions.emit(tx, actor, s, q.epoch, q.actions);
        break;
      }
      case "_axp/checkpoint": {
        const q = methods[method].parse(p);
        this.artifacts.checkpoint(tx, actor, s, q);
        break;
      }
      case "_axp/compact":
        return this.knowledge.compact(tx, actor, s, methods[method].parse(p));
      case "_axp/acceptCompaction": {
        const q = methods[method].parse(p);
        return this.knowledge.accept(tx, actor, s, q.proposalId);
      }
      case "_axp/memoryPropose":
        return this.knowledge.propose(tx, actor, s, methods[method].parse(p));
      case "_axp/review":
        return this.artifacts.review(tx, actor, s, methods[method].parse(p));
      case "_axp/approveReview":
        return this.artifacts.approve(
          tx,
          actor,
          s,
          methods[method].parse(p).signature,
        );
      case "_axp/verify":
        this.artifacts.verify(tx, actor, s, methods[method].parse(p));
        break;
      case "_axp/blobPut": {
        requireThat(
          actor.role !== "observer",
          Codes.forbidden,
          "Observers cannot upload",
        );
        const q = methods[method].parse(p);
        const data = Buffer.from(q.data, "base64");
        requireThat(
          data.toString("base64") === q.data,
          Codes.invalid,
          "Invalid base64 blob",
        );
        requireThat(
          data.length <= (this.options.maxBlobBytes ?? 16_000_000),
          Codes.limit,
          "Blob size limit reached",
        );
        const stored = Number(
          this.store.db
            .prepare("SELECT COALESCE(SUM(length(data)),0) AS size FROM blobs")
            .get()?.size,
        );
        requireThat(
          stored + data.length <=
            (this.options.maxStorageBytes ?? 2_000_000_000),
          Codes.limit,
          "Blob storage quota reached",
        );
        return tx.putBlob(s.resource, data, q.mediaType);
      }
      default:
        requireThat(false, Codes.method, "Unsupported mutation");
    }
    return null;
  }
  private blobGet(resource: string, digest: string) {
    const row = this.store.db
      .prepare(
        "SELECT b.data,a.media_type FROM blobs b JOIN blob_access a ON a.digest=b.digest WHERE a.channel=? AND a.digest=?",
      )
      .get(resource, digest);
    requireThat(
      row && row.data instanceof Uint8Array,
      Codes.missing,
      "Blob not found in this session",
    );
    return {
      data: Buffer.from(row.data).toString("base64"),
      mediaType: String(row.media_type),
    };
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const peer of this.peers) peer.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.listening)
      await new Promise<void>((resolve, reject) =>
        this.http.close((error) => (error ? reject(error) : resolve())),
      );
    this.store.close();
  }
}
