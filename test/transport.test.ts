import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { once } from "node:events";
import { SocketTransport } from "../src/transport.js";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { AxpClient } from "../src/client.js";
import { eventually } from "./helpers.js";

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

test(
  "connection cancellation interrupts both HTTP upgrade and AHP initialization",
  { timeout: 5000 },
  async (t) => {
    const server = createServer();
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("end", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    });
    const upgrades = new WebSocketServer({ noServer: true });
    let initialize = false;
    let arrived = Promise.withResolvers<void>();
    server.on("upgrade", (request, socket, head) => {
      if (initialize)
        upgrades.handleUpgrade(request, socket, head, (peer) => {
          peer.on("message", () => arrived.resolve());
        });
      else {
        socket.resume();
        arrived.resolve();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => upgrades.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `ws://127.0.0.1:${address.port}/axp`;
    for (initialize of [false, true]) {
      const controller = new AbortController();
      arrived = Promise.withResolvers<void>();
      const connected = AxpClient.connect(url, "local-test", undefined, {
        signal: controller.signal,
      });
      const rejected = assert.rejects(
        connected,
        initialize ? /transport closed/ : /operation was aborted/,
      );
      await arrived.promise;
      controller.abort();
      await rejected;
      await eventually(
        () => sockets.size,
        (n) => n === 0,
      );
    }
  },
);

test(
  "closing a connection does not wait indefinitely for an unresponsive peer",
  { timeout: 4000 },
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
    assert.ok(address && typeof address === "object");
    const arrived = once(server, "connection");
    const transport = await SocketTransport.connect(
      `ws://127.0.0.1:${address.port}`,
      "test",
    );
    const [peer] = await arrived;
    peer.pause();
    const pending = transport.recv();
    const closed = once(transport.socket, "close");
    transport.close();
    assert.equal(await pending, null);
    await closed;
  },
);
