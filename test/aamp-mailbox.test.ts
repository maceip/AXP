import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSmtpServer } from "node:net";
import type { Socket } from "node:net";
import { buildDispatchHeaders, parseAampHeaders } from "aamp-sdk";
import { JmapSmtpMailbox } from "../src/aamp.js";

/** Real HTTP and SMTP sockets; the fixture implements only the protocol operations under test. */
async function mailService() {
  const email = "axp@example.com";
  const password = "fixture-password";
  const received: string[] = [];
  const methods: { name: string; args: Record<string, unknown> }[] = [];
  const messages: { id: string; receivedAt: number }[] = [];
  let expireCursor = false;
  let advertisedApi: string | null = null;
  const http = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`
    ) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/jmap") {
      res.end(
        JSON.stringify({
          apiUrl: advertisedApi ?? "/jmap/",
          primaryAccounts: { "urn:ietf:params:jmap:mail": "mail-account" },
        }),
      );
      return;
    }
    if (req.url !== "/jmap/") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body) as {
      methodCalls: [string, Record<string, unknown>, string][];
    };
    const [name, args, tag] = input.methodCalls[0]!;
    methods.push({ name, args });
    let response: object;
    let type = name;
    if (name === "Email/query") {
      response = {
        ids: messages
          .slice(
            Number(args.position),
            Number(args.position) + Number(args.limit),
          )
          .map((m) => m.id),
        queryState: `q${messages.length}`,
        total: messages.length,
      };
    } else if (name === "Email/changes") {
      if (expireCursor) {
        expireCursor = false;
        type = "error";
        response = { type: "cannotCalculateChanges" };
      } else {
        const changed = messages.slice(
          Number(String(args.sinceState).slice(1)),
          Number(String(args.sinceState).slice(1)) + Number(args.maxChanges),
        );
        response = {
          created: changed.map((m) => m.id),
          updated: [],
          destroyed: [],
          newState: `s${changed.at(-1)?.receivedAt ?? messages.length}`,
        };
      }
    } else if (name === "Email/get") {
      response = {
        state: `s${messages.length}`,
        list: messages
          .filter((m) => (args.ids as string[]).includes(m.id))
          .map((m) => ({
            id: m.id,
            from: [{ email: "maintainer@example.com" }],
            to: [{ email }],
            messageId: [`${m.id}@example.com`],
            subject: "Task",
            headers: Object.entries(buildDispatchHeaders({ taskId: m.id })).map(
              ([name, value]) => ({ name, value }),
            ),
            textBody: [{ partId: "text" }],
            bodyValues: { text: { value: "Review the parser." } },
            attachments: [],
          })),
      };
    } else {
      type = "error";
      response = { type: "unknownMethod" };
    }
    res.end(JSON.stringify({ methodResponses: [[type, response, tag]] }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const sockets = new Set<Socket>();
  const smtp = createSmtpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    socket.write("220 localhost fixture\r\n");
    let buffer = "";
    let message: string[] | null = null;
    socket.on("data", (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (message) {
          if (line === ".") {
            received.push(message.join("\r\n"));
            message = null;
            socket.write("250 queued\r\n");
          } else message.push(line.replace(/^\.\./, "."));
        } else if (line.startsWith("EHLO"))
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH")) socket.write("235 authenticated\r\n");
        else if (line === "DATA") {
          message = [];
          socket.write("354 send mail\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  const httpAddress = http.address();
  const smtpAddress = smtp.address();
  assert.ok(httpAddress && typeof httpAddress === "object");
  assert.ok(smtpAddress && typeof smtpAddress === "object");
  return {
    options: {
      email,
      password,
      baseUrl: `http://127.0.0.1:${httpAddress.port}`,
      smtpHost: "127.0.0.1",
      smtpPort: smtpAddress.port,
    },
    received,
    methods,
    add(count = 1) {
      for (let n = 0; n < count; n++)
        messages.push({
          id: `mail-${messages.length + 1}`,
          receivedAt: messages.length + 1,
        });
    },
    expire() {
      expireCursor = true;
    },
    api(url: string) {
      advertisedApi = url;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => smtp.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    },
  };
}

test("JMAP backlog pagination and expired-cursor recovery retain every message across client restarts", async (t) => {
  const service = await mailService();
  t.after(service.close);
  let mailbox = new JmapSmtpMailbox(service.options);
  t.after(() => mailbox.close());
  service.add(300);
  const first = await mailbox.read(null);
  assert.equal(first.messages.length, 128);
  mailbox.close();
  mailbox = new JmapSmtpMailbox(service.options);
  const second = await mailbox.read(first.cursor);
  const third = await mailbox.read(second.cursor);
  assert.equal(
    new Set(
      [...first.messages, ...second.messages, ...third.messages].map(
        (m) => m.id,
      ),
    ).size,
    300,
  );
  const reconciled = await mailbox.read(third.cursor);
  assert.equal(reconciled.messages.length, 0);
  service.add();
  const added = await mailbox.read(reconciled.cursor);
  assert.deepEqual(
    added.messages.map((m) => m.id),
    ["mail-301"],
  );
  service.expire();
  const reset = await mailbox.read(added.cursor);
  assert.equal(JSON.parse(reset.cursor).mode, "scan");
  assert.equal((await mailbox.read(reset.cursor)).messages[0]?.id, "mail-1");
  const get = service.methods.find(
    (m) => m.name === "Email/get" && (m.args.ids as string[]).length > 0,
  )!;
  assert.equal(get.args.fetchTextBodyValues, true);
  assert.equal(get.args.maxBodyValueBytes, 48_000);
});

test("JMAP scan restarts on mailbox mutation instead of skipping offset-shifted mail", async (t) => {
  const service = await mailService();
  t.after(service.close);
  const mailbox = new JmapSmtpMailbox(service.options);
  t.after(() => mailbox.close());
  service.add(200);
  const first = await mailbox.read(null);
  service.add();
  const changed = await mailbox.read(first.cursor);
  assert.equal(JSON.parse(changed.cursor).position, 0);
  assert.equal(changed.messages.length, 0);
  const retry = await mailbox.read(changed.cursor);
  const next = await mailbox.read(retry.cursor);
  assert.equal(
    new Set([...retry.messages, ...next.messages].map((m) => m.id)).size,
    201,
  );
});

test("SMTP delivers stable threaded AAMP results that the reference SDK can parse", async (t) => {
  const service = await mailService();
  t.after(service.close);
  const mailbox = new JmapSmtpMailbox(service.options);
  t.after(() => mailbox.close());
  const reply = {
    messageId: "<stable-result@example.com>",
    to: "maintainer@example.com",
    taskId: "wire-task",
    inReplyTo: "<dispatch@example.com>",
    intent: "task.result" as const,
    status: "completed" as const,
    text: "Fixed the parser.",
    structuredResult: [
      {
        fieldKey: "axp.session",
        fieldTypeKey: "text" as const,
        value: "ahp-session:/example",
      },
    ],
  };
  await mailbox.send(reply);
  await mailbox.send(reply);
  assert.equal(service.received.length, 2);
  for (const raw of service.received) {
    const [headerBlock, text] = raw.split("\r\n\r\n");
    const headers = Object.fromEntries(
      headerBlock!
        .replace(/\r\n[ \t]+/g, " ")
        .split("\r\n")
        .map((line) => {
          const colon = line.indexOf(":");
          return [
            line.slice(0, colon).toLowerCase(),
            line.slice(colon + 1).trim(),
          ];
        }),
    );
    assert.equal(headers["message-id"], reply.messageId);
    assert.equal(headers["in-reply-to"], reply.inReplyTo);
    assert.equal(headers.references, reply.inReplyTo);
    const parsed = parseAampHeaders({
      from: service.options.email,
      to: reply.to,
      messageId: headers["message-id"]!,
      subject: headers.subject!,
      headers,
      bodyText: text!,
    });
    assert.ok(parsed && "intent" in parsed && parsed.intent === "task.result");
    assert.equal(parsed.output, reply.text);
    assert.deepEqual(parsed.structuredResult, reply.structuredResult);
  }
});

test("mailbox credentials cannot follow a cross-origin JMAP endpoint", async (t) => {
  const service = await mailService();
  t.after(service.close);
  service.api("https://attacker.invalid/jmap/");
  const mailbox = new JmapSmtpMailbox(service.options);
  t.after(() => mailbox.close());
  await assert.rejects(mailbox.read(null), /Cross-origin/);
  assert.equal(service.methods.length, 0);
  assert.throws(
    () =>
      new JmapSmtpMailbox({
        ...service.options,
        baseUrl: "http://mail.example.com",
      }),
    /HTTPS/,
  );
});
