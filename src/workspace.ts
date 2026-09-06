import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
} from "@microsoft/agent-host-protocol";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import { AxpClient } from "./client.js";
import { channels, ROOT } from "./protocol/types.js";
import type { ExchangeState, ExecutorRegistry } from "./protocol/types.js";
import { id, sha, digest, methods } from "./protocol/schema.js";
import { Codes, requireThat, ProtocolError } from "./protocol/errors.js";
import { hashObject, signObject } from "./hash.js";
import { reviewManifest } from "./review.js";
import type {
  Contribution,
  ContributionDetail,
  WorkspaceView,
} from "./workspace-contract.js";

const commandSchema = z.strictObject({
  operationId: id,
  startedAt: z.iso.datetime(),
  session: id,
  action: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("create"),
      title: z.string().trim().min(1).max(256),
      task: z.string().trim().min(1).max(512),
    }),
    z.strictObject({
      kind: z.literal("prompt"),
      text: z.string().trim().min(1).max(24_000),
      mode: z.enum(["start", "queue", "steer"]),
    }),
    z.strictObject({ kind: z.literal("cancel"), turnId: id }),
    z.strictObject({
      kind: z.literal("permission"),
      turnId: id,
      toolId: z.string().min(1).max(512),
      optionId: z.string().min(1).max(512),
    }),
    methods["_axp/comment"]
      .pick({ body: true, checkpoint: true, path: true })
      .extend({ kind: z.literal("comment") }),
    z.strictObject({
      kind: z.literal("accept"),
      checkpoint: sha,
      manifestDigest: digest,
    }),
    z.strictObject({
      kind: z.literal("submit"),
      checkpoint: sha,
      model: z.string().trim().min(1).max(256),
    }),
  ]),
});

export interface WorkspaceOptions {
  url: string;
  token: string;
  port?: number;
  /** Optional existing maintainer signing key; it never leaves this process. */
  signingKey?: string;
  assets?: string;
}

/** Personal loopback gateway. Each browser acts as one existing host-issued principal. */
export class WorkspaceServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  private client: AxpClient | null = null;
  private connecting: Promise<AxpClient> | null = null;
  private readonly streams = new Set<ServerResponse>();
  private readonly secret = randomBytes(32).toString("hex");
  private readonly subscriptions = new Set<string>();
  private readonly snapshots = new Map<string, Promise<unknown>>();
  private catalog: Promise<{ items: { resource: string }[] }> | null = null;
  private readonly abort = new AbortController();
  private origin = "";
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: WorkspaceOptions) {
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.server.maxConnections = 64;
  }
  async listen(): Promise<string> {
    await this.connection();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port ?? 0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing workspace address");
    this.origin = `http://127.0.0.1:${address.port}`;
    this.heartbeat = setInterval(() => this.broadcast("heartbeat"), 10_000);
    this.heartbeat.unref();
    return `${this.origin}/#access=${this.secret}`;
  }
  private connection(): Promise<AxpClient> {
    this.abort.signal.throwIfAborted();
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= AxpClient.connect(
      this.options.url,
      this.options.token,
      undefined,
      { signal: this.abort.signal, requestTimeoutMs: 10_000 },
    )
      .then((client) => {
        this.client = client;
        this.subscriptions.clear();
        this.snapshots.clear();
        this.catalog = null;
        client.on("action", (event) => {
          this.snapshots.delete(event.channel);
          if (event.channel.startsWith("axp-session:/")) this.catalog = null;
          this.broadcast("changed");
        });
        client.on("notification", () => {
          this.catalog = null;
          this.broadcast("changed");
        });
        client.once("close", () => {
          if (this.client === client) {
            this.client = null;
            this.broadcast("offline");
          }
        });
        return client;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }
  private broadcast(event: string): void {
    for (const stream of this.streams) {
      if (!stream.write(`event: ${event}\ndata: {}\n\n`)) {
        stream.destroy();
        this.streams.delete(stream);
      }
    }
  }
  private async snapshot<T>(client: AxpClient, resource: string): Promise<T> {
    const cached = this.snapshots.get(resource);
    if (cached) return cached as Promise<T>;
    // Keep recent views live while bounding host subscriptions during long browser sessions.
    if (!this.subscriptions.has(resource) && this.subscriptions.size >= 180) {
      const oldest = this.subscriptions.values().next().value!;
      await client.ahp.unsubscribe(oldest);
      this.subscriptions.delete(oldest);
      this.snapshots.delete(oldest);
    }
    const result = client.snapshot<T>(resource);
    this.snapshots.set(resource, result);
    void result.catch(() => {
      if (this.snapshots.get(resource) === result)
        this.snapshots.delete(resource);
    });
    this.subscriptions.delete(resource);
    this.subscriptions.add(resource);
    return result;
  }
  private async contribution(
    client: AxpClient,
    session: string,
  ): Promise<ContributionDetail> {
    const c = channels(session);
    const [state, exchange, chat] = await Promise.all([
      this.snapshot<SessionState>(client, c.session),
      this.snapshot<ExchangeState>(client, c.exchange),
      this.snapshot<ChatState>(client, c.chat),
    ]);
    const permission = chat.activeTurn?.responseParts.some(
      (p) =>
        p.kind === "toolCall" && p.toolCall.status === "pending-confirmation",
    );
    const contribution: Contribution = {
      id: session,
      title: state.title || exchange.task || session,
      exchange,
      activity:
        exchange.status === "closed"
          ? "archived"
          : permission
            ? "permission"
            : chat.activeTurn
              ? "working"
              : exchange.review && !exchange.review.maintainer
                ? "review"
                : exchange.checkpoint
                  ? "ready"
                  : "waiting",
      preview: (
        chat.activeTurn?.message.text ??
        chat.turns.at(-1)?.message.text ??
        exchange.context.summary
      ).slice(0, 280),
      turnCount: chat.turns.length + Number(!!chat.activeTurn),
    };
    return {
      contribution,
      chat: { ...chat, turns: chat.turns.slice(-40) },
      totalTurns: chat.turns.length,
    };
  }
  private async workspace(client: AxpClient): Promise<WorkspaceView> {
    // A successful local HTTP request alone cannot establish contact with the host.
    try {
      await client.ahp.request("ping", { channel: ROOT });
    } catch (error) {
      await client.close();
      throw error;
    }
    this.catalog ??= client.ahp.request("listSessions", { channel: ROOT });
    const { items } = await this.catalog;
    // Fetch sequentially to bound work and subscription churn on a large host.
    const contributions: Contribution[] = [];
    for (const item of items.slice(0, 40)) {
      const session = id.parse(item.resource.slice("ahp-session:/".length));
      contributions.push(
        (await this.contribution(client, session)).contribution,
      );
    }
    const registry = await this.snapshot<ExecutorRegistry>(
      client,
      "axp-executors://",
    );
    return {
      principal: { id: client.principalId, role: client.principalRole },
      repository:
        client.repository ||
        contributions[0]?.exchange.repository ||
        "Your repository",
      contributions,
      total: items.length,
      executors: Object.values(registry.entries),
      canSign:
        !!this.options.signingKey &&
        (client.principalRole === "maintainer" ||
          client.principalRole === "contributor"),
      receivedAt: Date.now(),
    };
  }
  private async command(client: AxpClient, raw: unknown): Promise<unknown> {
    const input = commandSchema.parse(raw);
    const { action, operationId } = input;
    const c = channels(input.session);
    if (action.kind === "create") {
      // The browser assigns a stable random session ID before the first attempt.
      const list = await client.ahp.request("listSessions", { channel: ROOT });
      if (!list.items.some((item) => item.resource === c.session))
        await client.ahp.request("createSession", {
          channel: c.session,
          provider: "axp",
          config: { title: action.title, task: action.task },
        });
      return { session: input.session };
    }
    if (action.kind === "comment")
      return client.call("_axp/comment", {
        channel: c.exchange,
        operationId,
        body: action.body,
        checkpoint: action.checkpoint,
        path: action.path,
      });
    if (action.kind === "submit") {
      requireThat(
        this.options.signingKey,
        Codes.invalid,
        "Start axp ui with --key to submit an artifact",
      );
      const state = await this.snapshot<ExchangeState>(client, c.exchange);
      requireThat(
        state.checkpoint?.headCommit === action.checkpoint,
        Codes.conflict,
        "Checkpoint changed; inspect the current changes before submitting",
      );
      const manifest = await reviewManifest(client, state, action.model);
      return client.call("_axp/review", {
        channel: c.exchange,
        operationId,
        manifest,
        contributor: signObject(manifest, this.options.signingKey),
      });
    }
    if (action.kind === "accept") {
      requireThat(
        this.options.signingKey,
        Codes.invalid,
        "Start axp ui with --key to approve an artifact",
      );
      const state = await this.snapshot<ExchangeState>(client, c.exchange);
      requireThat(
        state.review &&
          state.checkpoint?.headCommit === action.checkpoint &&
          hashObject(state.review.manifest) === action.manifestDigest,
        Codes.conflict,
        "Artifact changed; inspect the current review before approving",
      );
      return client.call("_axp/approveReview", {
        channel: c.exchange,
        operationId,
        signature: signObject(state.review.manifest, this.options.signingKey),
      });
    }
    if (action.kind === "prompt") {
      const message = { text: action.text, origin: { kind: MessageKind.User } };
      await client.dispatch(
        c.chat,
        action.mode === "start"
          ? {
              type: ActionType.ChatTurnStarted,
              turnId: operationId,
              startedAt: input.startedAt,
              message,
            }
          : {
              type: ActionType.ChatPendingMessageSet,
              kind:
                action.mode === "steer"
                  ? PendingMessageKind.Steering
                  : PendingMessageKind.Queued,
              id: operationId,
              message,
            },
        operationId,
      );
    } else if (action.kind === "cancel") {
      await client.dispatch(
        c.chat,
        {
          type: ActionType.ChatTurnCancelled,
          turnId: action.turnId,
          duration: 0,
        },
        operationId,
      );
    } else {
      const chat = await this.snapshot<ChatState>(client, c.chat);
      const part = chat.activeTurn?.responseParts.find(
        (p) => p.kind === "toolCall" && p.toolCall.toolCallId === action.toolId,
      );
      requireThat(
        chat.activeTurn?.id === action.turnId &&
          part?.kind === "toolCall" &&
          part.toolCall.status === "pending-confirmation",
        Codes.conflict,
        "This permission is no longer pending",
      );
      const choice = part.toolCall.options?.find(
        (o) => o.id === action.optionId,
      );
      requireThat(choice, Codes.invalid, "Choose an offered permission option");
      const base = {
        type: ActionType.ChatToolCallConfirmed,
        turnId: action.turnId,
        toolCallId: action.toolId,
        selectedOptionId: action.optionId,
      } as const;
      await client.dispatch(
        c.chat,
        choice.kind === "approve"
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
        operationId,
      );
    }
    return null;
  }
  private async body(request: IncomingMessage): Promise<unknown> {
    requireThat(
      request.headers["content-type"]?.split(";")[0] === "application/json",
      Codes.invalid,
      "Expected JSON",
    );
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > 64_000)
        throw new ProtocolError(Codes.limit, "Request exceeds 64 KB");
      chunks.push(data);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  private authenticated(request: IncomingMessage): boolean {
    return equal(request.headers.authorization ?? "", `Bearer ${this.secret}`);
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      requireThat(
        request.headers.host === new URL(this.origin).host,
        Codes.forbidden,
        "Unexpected workspace host",
      );
      requireThat(
        !request.headers.origin || request.headers.origin === this.origin,
        Codes.forbidden,
        "Cross-origin request rejected",
      );
      requireThat(
        request.headers["sec-fetch-site"] !== "cross-site",
        Codes.forbidden,
        "Cross-site request rejected",
      );
      const url = new URL(request.url ?? "/", this.origin);
      if (request.method === "POST")
        requireThat(
          request.headers.origin === this.origin,
          Codes.forbidden,
          "Same-origin request required",
        );
      if (url.pathname.startsWith("/api/")) {
        requireThat(
          this.authenticated(request),
          Codes.forbidden,
          "Open the private link printed by axp ui",
        );
        if (url.pathname === "/api/events" && request.method === "GET") {
          requireThat(
            this.streams.size < 16,
            Codes.limit,
            "Too many workspace streams",
          );
          response.writeHead(200, {
            "content-type": "text/event-stream",
            connection: "keep-alive",
          });
          response.write("event: connected\ndata: {}\n\n");
          this.streams.add(response);
          response.on("close", () => this.streams.delete(response));
          return;
        }
        const client = await this.connection();
        if (url.pathname === "/api/workspace" && request.method === "GET") {
          json(200, await this.workspace(client));
          return;
        }
        if (url.pathname === "/api/contribution" && request.method === "GET") {
          json(
            200,
            await this.contribution(
              client,
              id.parse(url.searchParams.get("session")),
            ),
          );
          return;
        }
        if (url.pathname === "/api/patch" && request.method === "GET") {
          const session = id.parse(url.searchParams.get("session"));
          const checkpoint = sha.parse(url.searchParams.get("checkpoint"));
          const state = await this.snapshot<ExchangeState>(
            client,
            channels(session).exchange,
          );
          requireThat(
            state.checkpoint?.headCommit === checkpoint,
            Codes.conflict,
            "Checkpoint changed; refresh the contribution",
          );
          requireThat(
            state.checkpoint.patch.size <= 2_000_000,
            Codes.limit,
            "Patch exceeds the 2 MB browser preview limit; export it with the CLI",
          );
          const blob = await client.call("_axp/blobGet", {
            channel: state.resource,
            digest: state.checkpoint.patch.sha256,
          });
          json(200, {
            patch: Buffer.from(blob.data, "base64").toString("utf8"),
            checkpoint,
            manifestDigest: state.review
              ? hashObject(state.review.manifest)
              : null,
          });
          return;
        }
        if (url.pathname === "/api/command" && request.method === "POST") {
          json(200, await this.command(client, await this.body(request)));
          return;
        }
        json(404, { error: "Unknown workspace operation" });
        return;
      }
      requireThat(
        request.method === "GET" || request.method === "HEAD",
        Codes.invalid,
        "Unsupported method",
      );
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      requireThat(
        /^(?:index\.html|assets\/[a-zA-Z0-9_.-]+|licenses\/[a-zA-Z0-9_.-]+)$/.test(
          file,
        ),
        Codes.missing,
        "Not found",
      );
      const root =
        this.options.assets ?? fileURLToPath(new URL("./ui/", import.meta.url));
      const content = await readFile(join(root, file));
      const mime: Record<string, string> = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".woff2": "font/woff2",
        ".txt": "text/plain",
      };
      response.writeHead(200, {
        "content-type": mime[extname(file)] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const code =
        error && typeof error === "object" && "code" in error
          ? Number(error.code)
          : 0;
      const status =
        code === Codes.forbidden
          ? 403
          : code === Codes.missing
            ? 404
            : code === Codes.conflict || code === Codes.busy
              ? 409
              : error instanceof z.ZodError ||
                  error instanceof SyntaxError ||
                  code === Codes.invalid
                ? 400
                : code === Codes.limit
                  ? 413
                  : 503;
      const message =
        error instanceof z.ZodError
          ? "Invalid workspace request"
          : error instanceof Error
            ? error.message
            : "Workspace unavailable";
      json(status, { error: message });
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.abort.abort();
      clearInterval(this.heartbeat);
      for (const stream of this.streams) stream.end();
      this.streams.clear();
      await this.connecting?.catch(() => {});
      await this.client?.close();
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve());
        this.server.closeAllConnections();
      });
    })();
    return this.closing;
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
