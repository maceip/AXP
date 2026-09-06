import { createTransport } from "nodemailer";
import type { Transporter } from "nodemailer";
import { z } from "zod";
import { aampReplyHeaders, mailboxAddress } from "./wire.js";
import type { AampMail, AampReply } from "./wire.js";

export interface AampMailbox {
  readonly email: string;
  /** Cursor is committed only after every returned message is durably journaled. */
  read(
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<{ messages: AampMail[]; cursor: string }>;
  send(reply: AampReply): Promise<void>;
  close(): void;
}

export interface JmapSmtpOptions {
  email: string;
  password: string;
  baseUrl: string;
  smtpHost: string;
  smtpPort?: number;
  /** Implicit TLS, normally port 465. Other remote SMTP connections require STARTTLS. */
  smtpSecure?: boolean;
}

const MAIL = "urn:ietf:params:jmap:mail";
const CORE = "urn:ietf:params:jmap:core";
const sessionSchema = z.object({
  apiUrl: z.string(),
  primaryAccounts: z.record(z.string(), z.string()),
});
const cursorSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("changes"),
    account: z.string(),
    state: z.string(),
  }),
  z.object({
    mode: z.literal("scan"),
    account: z.string(),
    state: z.string(),
    position: z.number().int().min(0),
    queryState: z.string().nullable(),
  }),
]);
const emailSchema = z.object({
  id: z.string(),
  from: z.array(z.object({ email: z.string() })).default([]),
  to: z.array(z.object({ email: z.string() })).default([]),
  messageId: z.array(z.string()).nullable().optional(),
  subject: z.string().default(""),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  textBody: z.array(z.object({ partId: z.string() })).default([]),
  bodyValues: z
    .record(
      z.string(),
      z.object({ value: z.string(), isTruncated: z.boolean().optional() }),
    )
    .default({}),
  attachments: z
    .array(z.object({ name: z.string().nullable(), size: z.number() }))
    .default([]),
});

/** SMTP plus paginated JMAP. Polling uses durable state instead of an in-memory push cursor. */
export class JmapSmtpMailbox implements AampMailbox {
  readonly email: string;
  private readonly origin: URL;
  private readonly authorization: string;
  private readonly smtp: Transporter;
  private session: { api: URL; account: string } | null = null;

  constructor(options: JmapSmtpOptions) {
    this.email = mailboxAddress.parse(options.email);
    this.origin = new URL(options.baseUrl);
    const local = (host: string) =>
      ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
    if (
      this.origin.username ||
      this.origin.password ||
      this.origin.search ||
      this.origin.hash ||
      (this.origin.protocol !== "https:" &&
        !(this.origin.protocol === "http:" && local(this.origin.hostname)))
    )
      throw new Error(
        "AAMP requires HTTPS outside loopback, without URL credentials",
      );
    this.authorization = `Basic ${Buffer.from(`${this.email}:${options.password}`).toString("base64")}`;
    const secure = options.smtpSecure ?? false;
    this.smtp = createTransport({
      host: options.smtpHost,
      port: options.smtpPort ?? (secure ? 465 : 587),
      secure,
      requireTLS: !secure && !local(options.smtpHost),
      auth: { user: this.email, pass: options.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  private async json(
    url: URL,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<unknown> {
    // A discovered endpoint cannot redirect mailbox credentials to another origin.
    if (url.origin !== this.origin.origin || url.username || url.password)
      throw new Error("Cross-origin JMAP endpoint rejected");
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: this.authorization,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`JMAP HTTP ${response.status}`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body!) {
      bytes += chunk.byteLength;
      if (bytes > 8_000_000) throw new Error("JMAP response exceeds 8 MB");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async connect(
    signal?: AbortSignal,
  ): Promise<{ api: URL; account: string }> {
    if (this.session) return this.session;
    const session = sessionSchema.parse(
      await this.json(new URL("/.well-known/jmap", this.origin), signal),
    );
    const account = session.primaryAccounts[MAIL];
    if (!account) throw new Error("JMAP session has no primary mail account");
    this.session = { api: new URL(session.apiUrl, this.origin), account };
    return this.session;
  }

  private async call(
    method: string,
    args: object,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const session = await this.connect(signal);
    const response = z
      .object({
        methodResponses: z.array(
          z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
        ),
      })
      .parse(
        await this.json(session.api, signal, {
          using: [CORE, MAIL],
          methodCalls: [
            [method, { accountId: session.account, ...args }, "axp"],
          ],
        }),
      );
    const result = response.methodResponses.find((r) => r[2] === "axp");
    if (!result) throw new Error("Missing JMAP method response");
    if (result[0] === "error")
      throw new JmapMethodError(String(result[1].type));
    if (result[0] !== method) throw new Error("Mismatched JMAP response");
    return result[1];
  }

  async read(
    saved: string | null,
    signal?: AbortSignal,
  ): Promise<{ messages: AampMail[]; cursor: string }> {
    const { account } = await this.connect(signal);
    let cursor = saved ? cursorSchema.parse(JSON.parse(saved)) : null;
    if (cursor && cursor.account !== account)
      throw new Error("AAMP journal belongs to a different JMAP account");
    const beginScan = async () => {
      const { state } = z
        .object({ state: z.string() })
        .parse(await this.call("Email/get", { ids: [] }, signal));
      return {
        mode: "scan" as const,
        account,
        state,
        position: 0,
        queryState: null,
      };
    };
    cursor ??= await beginScan();
    let ids: string[];
    if (cursor.mode === "changes") {
      try {
        const changes = z
          .object({
            newState: z.string(),
            created: z.array(z.string()).max(128),
          })
          .parse(
            await this.call(
              "Email/changes",
              { sinceState: cursor.state, maxChanges: 128 },
              signal,
            ),
          );
        ids = changes.created;
        cursor = { ...cursor, state: changes.newState };
      } catch (error) {
        if (
          !(error instanceof JmapMethodError) ||
          error.type !== "cannotCalculateChanges"
        )
          throw error;
        // An expired cursor starts a complete paginated rescan; the journal deduplicates it.
        return { messages: [], cursor: JSON.stringify(await beginScan()) };
      }
    } else {
      const page = z
        .object({
          ids: z.array(z.string()).max(128),
          queryState: z.string(),
          total: z.number().int().min(0),
        })
        .parse(
          await this.call(
            "Email/query",
            {
              sort: [{ property: "receivedAt", isAscending: true }],
              position: cursor.position,
              limit: 128,
              calculateTotal: true,
            },
            signal,
          ),
        );
      if (cursor.queryState !== null && cursor.queryState !== page.queryState)
        return {
          messages: [],
          cursor: JSON.stringify({ ...cursor, position: 0, queryState: null }),
        };
      ids = page.ids;
      const position = cursor.position + ids.length;
      if (!ids.length && position < page.total)
        throw new Error("JMAP scan made no progress");
      cursor =
        position >= page.total
          ? { mode: "changes", account, state: cursor.state }
          : { ...cursor, position, queryState: page.queryState };
    }
    const emails = ids.length
      ? z.object({ list: z.array(emailSchema).max(128) }).parse(
          await this.call(
            "Email/get",
            {
              ids,
              properties: [
                "id",
                "from",
                "to",
                "messageId",
                "subject",
                "headers",
                "textBody",
                "bodyValues",
                "attachments",
              ],
              fetchTextBodyValues: true,
              maxBodyValueBytes: 48_000,
            },
            signal,
          ),
        ).list
      : [];
    return {
      cursor: JSON.stringify(cursor),
      messages: emails.map((email) => ({
        id: email.id,
        from: email.from.length === 1 ? email.from[0]!.email : "",
        to: email.to.map((to) => to.email),
        // JMAP MessageIds omit angle brackets; RFC mail threading needs them restored.
        messageId:
          email.messageId?.length === 1
            ? `<${email.messageId[0]!.replace(/^<|>$/g, "")}>`
            : "",
        subject: email.subject,
        headers: email.headers,
        text: email.textBody
          .map((part) => email.bodyValues[part.partId]?.value ?? "")
          .join("\n"),
        truncated: email.textBody.some(
          (part) =>
            !email.bodyValues[part.partId] ||
            email.bodyValues[part.partId]?.isTruncated,
        ),
        attachments: email.attachments.map((a) => ({
          name: a.name ?? "attachment",
          size: a.size,
        })),
      })),
    };
  }

  async send(reply: AampReply): Promise<void> {
    await this.smtp.sendMail({
      from: this.email,
      to: mailboxAddress.parse(reply.to),
      messageId: reply.messageId,
      inReplyTo: reply.inReplyTo,
      references: reply.inReplyTo,
      subject: `[AAMP ${reply.intent}] ${reply.taskId}`,
      text: reply.text,
      headers: aampReplyHeaders(reply),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  close(): void {
    this.smtp.close();
  }
}

class JmapMethodError extends Error {
  constructor(readonly type: string) {
    super(`JMAP: ${type}`);
  }
}
