import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type {
  AhpTransport,
  JsonRpcMessage,
  TransportFrame,
} from "@microsoft/agent-host-protocol/client";
import { TransportError } from "@microsoft/agent-host-protocol/client";

export class UpgradeError extends Error {
  constructor(readonly status: number) {
    super(`Host rejected the WebSocket connection (HTTP ${status})`);
    this.name = "UpgradeError";
  }
}

/** Bounded, lossless receive queue. Overflow closes the connection so replay
 * can repair it; no oldest-event dropping and no unbounded socket buffers. */
export class SocketTransport implements AhpTransport {
  private readonly queue: { frame: TransportFrame; bytes: number }[] = [];
  private bytes = 0;
  private waiter: {
    resolve: (frame: TransportFrame | null) => void;
    reject: (error: Error) => void;
  } | null = null;
  private ended = false;
  private error: Error | null = null;
  onMessage: ((value: unknown) => void) | null = null;
  onClose: (() => void) | null = null;
  get failure(): Error | null {
    return this.error;
  }
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data, binary) => {
      if (this.ended) return;
      if (binary) {
        this.fail(new TransportError("protocol", "Expected a JSON text frame"));
        return;
      }
      const text = data.toString();
      try {
        this.onMessage?.(JSON.parse(text) as unknown);
      } catch {
        this.fail(new TransportError("protocol", "Invalid server message"));
        return;
      }
      const frame: TransportFrame = { kind: "text", text };
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter.resolve(frame);
      } else {
        this.queue.push({ frame, bytes: Buffer.byteLength(text) });
        this.bytes += Buffer.byteLength(text);
        if (this.queue.length > 4096 || this.bytes > 32_000_000)
          this.fail(
            new TransportError(
              "io",
              "Receive buffer overflow; reconnect required",
            ),
          );
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.finish());
  }
  static async connect(
    url: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<SocketTransport> {
    signal?.throwIfAborted();
    const target = new URL(url);
    if (
      !["wss:", "ws:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search
    )
      throw new Error(
        "Use a ws/wss URL without credentials or query parameters",
      );
    if (
      target.protocol === "ws:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    )
      throw new Error("Remote connections require wss://");
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 10_000,
      maxPayload: 32_000_000,
      perMessageDeflate: false,
    });
    const transport = new SocketTransport(socket);
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        socket.off("open", opened);
        socket.off("error", failed);
        socket.off("unexpected-response", rejected);
        signal?.removeEventListener("abort", aborted);
      };
      const opened = () => {
        clean();
        resolve();
      };
      const failed = (error: Error) => {
        clean();
        reject(error);
      };
      const aborted = () => {
        failed(signal!.reason as Error);
        socket.terminate();
      };
      const rejected = (_request: unknown, response: IncomingMessage) => {
        failed(new UpgradeError(response.statusCode ?? 0));
        response.destroy();
        socket.terminate();
      };
      socket.once("open", opened);
      socket.once("error", failed);
      socket.once("unexpected-response", rejected);
      signal?.addEventListener("abort", aborted, { once: true });
    });
    return transport;
  }
  private fail(error: Error): void {
    if (this.ended) return;
    this.error = error;
    this.waiter?.reject(error);
    this.waiter = null;
    this.socket.terminate();
  }
  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.waiter?.resolve(null);
    this.waiter = null;
    this.onClose?.();
  }
  send(message: JsonRpcMessage | string): Promise<void> {
    if (this.ended || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new TransportError("closed", "Socket closed"));
    if (this.socket.bufferedAmount > 32_000_000) {
      this.fail(new TransportError("io", "Send buffer overflow"));
      return Promise.reject(this.error);
    }
    return new Promise<void>((resolve, reject) =>
      this.socket.send(
        typeof message === "string" ? message : JSON.stringify(message),
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }
  async recv(): Promise<TransportFrame | null> {
    if (this.error) throw this.error;
    const next = this.queue.shift();
    if (next) {
      this.bytes -= next.bytes;
      return next.frame;
    }
    if (this.ended) return null;
    if (this.waiter) throw new Error("Only one receiver is allowed");
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  close(): void {
    if (this.ended) return;
    this.finish();
    this.queue.length = 0;
    this.bytes = 0;
    this.socket.close();
    // A dead peer cannot acknowledge a close frame. End the local receive
    // loop immediately and bound the remaining socket handshake separately.
    const timer = setTimeout(() => this.socket.terminate(), 1000);
    timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
  }
}
