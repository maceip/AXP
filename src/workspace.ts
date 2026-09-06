import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join } from "node:path";
import { z } from "zod";
import type {
  ChatState,
  SessionState,
  ListSessionsResult,
} from "@microsoft/agent-host-protocol";
import type { ChannelSnapshot } from "./protocol/types.js";
import { reduceChannel } from "./channel-state.js";
import { AxpClient } from "./client.js";
import { channels, ROOT } from "./protocol/types.js";
import type { ExchangeState, ExecutorRegistry } from "./protocol/types.js";
import { id, sha, digest } from "./protocol/schema.js";
import { Codes, requireThat, ProtocolError } from "./protocol/errors.js";
import { hashObject } from "./hash.js";
import { WorkspaceCommands } from "./workspace-commands.js";

import type {
  Contribution,
  ContributionDetail,
  FamilyPhoto,
  Portrait,
  WorkspaceView,
} from "./workspace-contract.js";
const PORTRAIT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const PORTRAIT_MAX_BYTES = 1_500_000;
/** Spots in the photo. The layout scales to this; sharding sessions raises it. */
const FAMILY_CAPACITY = 1000;

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
  private readonly commands: WorkspaceCommands;
  private readonly snapshots = new Map<
    string,
    { promise: Promise<ChannelSnapshot> }
  >();
  private catalog: Promise<ListSessionsResult> | null = null;
  private catalogDirty = false;
  private catalogAt = 0;
  private changedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly abort = new AbortController();
  private origin = "";
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: WorkspaceOptions) {
    this.commands = new WorkspaceCommands(options.signingKey);
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
          const entry = this.snapshots.get(event.channel);
          if (entry) {
            entry.promise = entry.promise.then((snapshot) =>
              event.serverSeq <= snapshot.fromSeq
                ? snapshot
                : {
                    resource: snapshot.resource,
                    fromSeq: event.serverSeq,
                    state: reduceChannel(
                      event.channel,
                      snapshot.state,
                      event.action,
                    ),
                  },
            );
            void entry.promise.catch(() =>
              this.snapshots.delete(event.channel),
            );
          }
          if (
            event.channel.startsWith("axp-session:/") &&
            event.action.type !== "_axp/leaseChanged"
          )
            this.catalogDirty = true;
          this.changed();
        });
        client.on("notification", (notification) => {
          const method = (notification as { method?: string }).method;
          if (method === "root/sessionAdded") this.catalog = null;
          else this.catalogDirty = true;
          this.changed();
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
  private changed(): void {
    this.changedTimer ??= setTimeout(() => {
      this.changedTimer = undefined;
      this.broadcast("changed");
    }, 100);
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
    if (cached) return (await cached.promise).state as T;
    // Keep recent views live while bounding host subscriptions during long browser sessions.
    if (!this.subscriptions.has(resource) && this.subscriptions.size >= 128) {
      const oldest = this.subscriptions.values().next().value!;
      this.subscriptions.delete(oldest);
      this.snapshots.delete(oldest);
      // Remove bookkeeping before yielding, so concurrent reads evict distinct entries.
      void client.ahp.unsubscribe(oldest).catch(() => {});
    }
    const result = client.ahp
      .request("subscribe", { channel: resource })
      .then(({ snapshot }) => {
        requireThat(snapshot, Codes.missing, "Host returned no snapshot");
        return snapshot;
      });
    const entry = { promise: result };
    this.snapshots.set(resource, entry);
    void result.catch(() => {
      if (this.snapshots.get(resource) === entry) {
        this.snapshots.delete(resource);
        this.subscriptions.delete(resource);
      }
    });
    this.subscriptions.delete(resource);
    this.subscriptions.add(resource);
    return (await result).state as T;
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
              ? exchange.lease
                ? "working"
                : "waiting"
              : chat.turns.at(-1)?.state === "error"
                ? "failed"
                : exchange.review && !exchange.review.maintainer
                  ? "review"
                  : exchange.checkpoint
                    ? "ready"
                    : exchange.lease
                      ? "parked"
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
  /** The family photo: every portrait posted to the project's family sessions.
   *
   * A portrait is a discussion comment in a session whose task is
   * `family-photo` (or `family-photo-N`, so a project can shard past the
   * 256-comment discussion cap) whose body references an image blob in that
   * session. Order is join order, which is what decides your spot. */
  private async family(client: AxpClient): Promise<FamilyPhoto> {
    const { items } = await client.ahp.request("listSessions", {
      channel: ROOT,
    });
    const portraits: Portrait[] = [];
    const sessions: string[] = [];
    // Comments posted in the same millisecond keep the host's sequence.
    const order = new Map<string, number>();
    for (const item of items) {
      const session = id.parse(item.resource.slice("ahp-session:/".length));
      const state = await this.snapshot<ExchangeState>(
        client,
        channels(session).exchange,
      );
      if (!/^family-photo(-\d+)?$/.test(state.task)) continue;
      sessions.push(session);
      const prefix = `axp-blob:/${encodeURIComponent(state.resource)}/`;
      for (const [index, comment] of (state.discussion ?? []).entries()) {
        const match = comment.body.match(
          new RegExp(
            `${prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([a-f0-9]{64})`,
          ),
        );
        if (!match) continue;
        order.set(comment.id, index);
        portraits.push({
          id: comment.id,
          author: comment.author,
          session,
          digest: match[1]!,
          createdAt: comment.createdAt,
          caption: comment.body
            .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
            .replace(/axp-blob:\/\S+/g, "")
            .trim()
            .slice(0, 140),
        });
      }
    }
    portraits.sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    return { sessions, portraits, capacity: FAMILY_CAPACITY };
  }
  private async workspace(
    client: AxpClient,
    offset: number,
    query: string,
  ): Promise<WorkspaceView> {
    // A successful local HTTP request alone cannot establish contact with the host.
    try {
      await client.ahp.request("ping", { channel: ROOT });
    } catch (error) {
      await client.close();
      throw error;
    }
    if (this.catalogDirty && Date.now() - this.catalogAt >= 1000)
      this.catalog = null;
    if (!this.catalog) {
      this.catalogDirty = false;
      this.catalogAt = Date.now();
      const catalog = client.ahp.request("listSessions", { channel: ROOT });
      this.catalog = catalog;
      void catalog.catch(() => {
        if (this.catalog === catalog) this.catalog = null;
      });
    }
    const { items } = await this.catalog;
    const matched = query
      ? items.filter((item) =>
          `${item.title} ${item.resource}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
      : items;
    const page = matched.slice(offset, offset + 40);
    // Four sessions at a time bound cold-load work while avoiding 40 serial network round trips.
    const contributions: Contribution[] = [];
    for (let index = 0; index < page.length; index += 4) {
      contributions.push(
        ...(await Promise.all(
          page.slice(index, index + 4).map(async (item) => {
            const session = id.parse(
              item.resource.slice("ahp-session:/".length),
            );
            return (await this.contribution(client, session)).contribution;
          }),
        )),
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
      matched: matched.length,
      offset,
      executors: Object.values(registry.entries),
      canSign:
        !!this.options.signingKey &&
        (client.principalRole === "maintainer" ||
          client.principalRole === "contributor"),
      receivedAt: Date.now(),
    };
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
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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
          const offset = z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .parse(url.searchParams.get("offset") ?? 0);
          const query = z
            .string()
            .trim()
            .max(256)
            .parse(url.searchParams.get("query") ?? "");
          json(200, await this.workspace(client, offset, query));
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
        if (
          ["/api/content", "/api/download"].includes(url.pathname) &&
          request.method === "GET"
        ) {
          const session = id.parse(url.searchParams.get("session"));
          const sha256 = digest.parse(url.searchParams.get("digest"));
          const blob = await client.call("_axp/blobGet", {
            channel: channels(session).exchange,
            digest: sha256,
          });
          const bytes = Buffer.from(blob.data, "base64");
          if (url.pathname === "/api/download") {
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="axp-${sha256}.bin"`,
              "content-length": bytes.length,
            });
            response.end(bytes);
          } else {
            const isText =
              blob.mediaType.startsWith("text/") ||
              ["application/json", "application/xml"].includes(blob.mediaType);
            json(200, {
              text: isText ? bytes.subarray(0, 64_000).toString("utf8") : null,
              bytes: bytes.length,
              truncated: isText && bytes.length > 64_000,
            });
          }
          return;
        }
        if (url.pathname === "/api/family" && request.method === "GET") {
          json(200, await this.family(client));
          return;
        }
        if (url.pathname === "/api/portrait" && request.method === "GET") {
          // Portraits are the only blobs the gateway serves as images. Content
          // addressing makes them immutable, so they cache for a year; nosniff
          // and an inline disposition keep an <img> the only consumer.
          const session = id.parse(url.searchParams.get("session"));
          const sha256 = digest.parse(url.searchParams.get("digest"));
          const blob = await client.call("_axp/blobGet", {
            channel: channels(session).exchange,
            digest: sha256,
          });
          requireThat(
            PORTRAIT_TYPES.has(blob.mediaType),
            Codes.invalid,
            "Portraits must be PNG, JPEG, WebP, GIF or SVG",
          );
          const bytes = Buffer.from(blob.data, "base64");
          requireThat(
            bytes.length <= PORTRAIT_MAX_BYTES,
            Codes.limit,
            "Portraits are limited to 1.5 MB",
          );
          response.writeHead(200, {
            "content-type": blob.mediaType,
            "content-length": bytes.length,
            "content-disposition": "inline",
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy":
              "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          });
          response.end(bytes);
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
          json(
            200,
            await this.commands.execute(client, await this.body(request)),
          );
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
      if (file.startsWith("assets/"))
        response.setHeader(
          "cache-control",
          "private, max-age=31536000, immutable",
        );
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
      const missingFile =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT";
      const message = missingFile
        ? "Not found"
        : error instanceof z.ZodError
          ? "Invalid workspace request"
          : error instanceof Error
            ? error.message
            : "Workspace unavailable";
      json(missingFile ? 404 : status, { error: message });
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.abort.abort();
      clearInterval(this.heartbeat);
      clearTimeout(this.changedTimer);
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
