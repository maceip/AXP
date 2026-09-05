import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { SocketTransport } from "../src/transport.js";

test(
  "an unread socket disconnects on overflow instead of dropping ordered events",
  { timeout: 5000 },
  async (t) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    t.after(
      () =>
        new Promise<void>((resolve) => {
          for (const peer of server.clients) peer.terminate();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    assert.ok(typeof address === "object" && address);
    const peerReady = once(server, "connection");
    const transport = await SocketTransport.connect(
      `ws://127.0.0.1:${address.port}`,
      "test",
    );
    const [peer] = await peerReady;
    const closed = once(transport.socket, "close");
    for (let i = 0; i < 4100; i++)
      peer.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "action",
          params: { serverSeq: i },
        }),
      );
    await closed;
    await assert.rejects(transport.recv(), /overflow; reconnect required/);
  },
);
