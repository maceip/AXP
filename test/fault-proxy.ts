import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** A real TCP/WebSocket boundary for dropping acknowledged responses, cutting
 * connections, and simulating a proxy that accepts TCP but stops forwarding. */
export async function faultProxy(target: string) {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WebSocket>();
  let available = true;
  let paused = false;
  let dropMethod: string | null = null;
  const requests: string[] = [];
  server.on("upgrade", (request, socket, head) => {
    if (!available) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    ws.handleUpgrade(request, socket, head, (downstream) => {
      const upstream = new WebSocket(target, {
        headers: { authorization: request.headers.authorization ?? "" },
      });
      upstreams.add(upstream);
      const pending: string[] = [];
      const methods = new Map<unknown, string>();
      const cut = () => {
        upstream.terminate();
        downstream.terminate();
      };
      downstream.on("error", cut);
      upstream.on("error", cut);
      downstream.on("close", () => {
        if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate();
      });
      upstream.on("close", () => {
        upstreams.delete(upstream);
        downstream.terminate();
      });
      downstream.on("message", (data) => {
        if (paused) return;
        const text = data.toString();
        const message = JSON.parse(text) as { id?: unknown; method: string };
        requests.push(message.method);
        methods.set(message.id, message.method);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else pending.push(text);
      });
      upstream.on("open", () => {
        for (const text of pending) upstream.send(text);
        pending.length = 0;
      });
      upstream.on("message", (data) => {
        if (paused) return;
        const text = data.toString();
        const message = JSON.parse(text) as { id?: unknown };
        const method = methods.get(message.id);
        if (message.id !== undefined) methods.delete(message.id);
        if (dropMethod && method === dropMethod) {
          dropMethod = null;
          cut();
        } else if (downstream.readyState === WebSocket.OPEN)
          downstream.send(text);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object")
    throw new Error("Proxy did not bind");
  return {
    url: `ws://127.0.0.1:${address.port}/axp`,
    requests,
    dropReplyTo(method: string) {
      dropMethod = method;
    },
    setAvailable(value: boolean) {
      available = value;
    },
    pause(value: boolean) {
      paused = value;
    },
    cut() {
      for (const socket of ws.clients) socket.terminate();
    },
    async close() {
      for (const socket of ws.clients) socket.terminate();
      for (const socket of upstreams) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
