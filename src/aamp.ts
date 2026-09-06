import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ActionType, MessageKind } from "@microsoft/agent-host-protocol";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { z } from "zod";
import { AxpClient } from "./client.js";
import { hashObject } from "./hash.js";
import { channels } from "./protocol/types.js";
import type { ExchangeState } from "./protocol/types.js";
import { id } from "./protocol/schema.js";
import { Codes } from "./protocol/errors.js";
import { AampJournal } from "./aamp/journal.js";
import type { MailTask } from "./aamp/journal.js";
import { mailboxAddress, parseAampMail } from "./aamp/wire.js";
import type { AampReply, AampRequest, AampMail } from "./aamp/wire.js";
import type { AampMailbox } from "./aamp/mailbox.js";

export { JmapSmtpMailbox } from "./aamp/mailbox.js";
export type { AampMailbox, JmapSmtpOptions } from "./aamp/mailbox.js";
export type { AampMail, AampReply } from "./aamp/wire.js";

export const aampRouteSchema = z.strictObject({
  from: mailboxAddress,
  session: id,
  sessionKey: z.string().min(1).max(998).optional(),
  context: z.record(z.string(), z.array(z.string()).min(1).max(32)).default({}),
});
export type AampRoute = z.input<typeof aampRouteSchema>;

export interface AampBridgeOptions {
  url: string;
  token: string;
  mailbox: AampMailbox;
  database: string;
  /** Explicit local admission rules. Mail cannot select an arbitrary AXP session. */
  routes: AampRoute[];
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
}

/** Mailbox ingress for existing AXP sessions. Execution and review remain AHP/AXP operations. */
export class AampBridge extends EventEmitter<{ warning: [Error] }> {
  private readonly journal: AampJournal;
  private readonly routes: z.output<typeof aampRouteSchema>[];
  private readonly now: () => number;
  private client: AxpClient | null = null;
  private syncing: Promise<void> | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly interval: number;
  private readonly requestTimeoutMs: number;

  constructor(readonly options: AampBridgeOptions) {
    super();
    this.routes = z.array(aampRouteSchema).min(1).max(64).parse(options.routes);
    this.interval = z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .parse(options.pollIntervalMs ?? 5000);
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = z
      .number()
      .int()
      .min(100)
      .max(120_000)
      .parse(options.requestTimeoutMs ?? 10_000);
    this.journal = new AampJournal(options.database);
    const identity = hashObject({
      email: mailboxAddress.parse(options.mailbox.email),
      url: options.url,
    });
    if (
      this.journal.setting("identity") &&
      this.journal.setting("identity") !== identity
    ) {
      this.journal.close();
      throw new Error(
        "AAMP journal belongs to a different mailbox or AXP host",
      );
    }
    this.journal.set("identity", identity);
  }

  /** Complete one bounded receive/admit/reconcile/send pass. Useful for supervised deployments. */
  sync(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("AAMP adapter is closed"));
    this.syncing ??= this.cycle(signal).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("AAMP adapter is closed");
    try {
      while (!signal.aborted && !this.closed) {
        try {
          await this.sync(signal);
        } catch (error) {
          if (!signal.aborted) this.emit("warning", asError(error));
        }
        await delay(this.interval, undefined, { signal }).catch(() => {});
      }
    } finally {
      await this.close();
    }
  }

  private route(
    request: AampRequest,
  ): z.output<typeof aampRouteSchema> | undefined {
    const matches = this.routes.filter(
      (route) =>
        route.from === request.from &&
        (route.sessionKey === undefined ||
          route.sessionKey === request.sessionKey) &&
        Object.entries(route.context).every(([key, values]) =>
          values.includes(request.context[key] ?? ""),
        ),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async cycle(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const batch = await this.options.mailbox.read(
      this.journal.setting("cursor"),
      signal,
    );
    signal?.throwIfAborted();
    this.journal.receive(batch.messages, batch.cursor);
    // Cancellation is admitted before dispatch when mail arrives in one batch out of order.
    const pending = this.journal
      .pending()
      .sort((a, b) => Number(isCancel(b)) - Number(isCancel(a)));
    for (const mail of pending) {
      let failure: Error | undefined;
      this.journal.transaction(() => {
        try {
          this.admit(mail);
          this.journal.processed(mail.id);
        } catch (error) {
          failure = asError(error);
          this.journal.processed(mail.id, failure.message);
        }
      });
      if (failure)
        this.emit(
          "warning",
          new Error(
            `AAMP message ${mail.id} was not admitted: ${failure.message}`,
          ),
        );
    }
    if (!this.client) {
      const client = await AxpClient.connect(
        this.options.url,
        this.options.token,
        undefined,
        {
          ...(signal ? { signal } : {}),
          requestTimeoutMs: this.requestTimeoutMs,
        },
      );
      client.once("close", () => {
        if (this.client === client) this.client = null;
      });
      this.client = client;
    }
    const client = this.client;
    for (const task of this.journal.active()) {
      signal?.throwIfAborted();
      try {
        await this.reconcile(task, client);
      } catch (error) {
        if (
          (
            [Codes.forbidden, Codes.invalid, Codes.missing] as number[]
          ).includes(errorCode(error))
        ) {
          this.finish(
            task,
            "rejected",
            `AXP could not admit this task: ${asError(error).message}`,
          );
        } else {
          // A timeout need not close TCP. Retire the client so the next pass
          // negotiates a fresh connection and reconciles its durable receipts.
          await client.close();
          throw error;
        }
      }
    }
    for (const entry of this.journal.outbox()) {
      signal?.throwIfAborted();
      const task = this.journal.task(entry.taskKey);
      const route = task && this.route(task.request);
      if (
        task &&
        (!route || channels(route.session).exchange !== task.channel) &&
        task.status !== "cancelled"
      ) {
        this.journal.suppress(entry.taskKey);
        continue;
      }
      await this.options.mailbox.send(entry.reply);
      this.journal.sent(entry.id);
    }
  }

  private admit(mail: AampMail): void {
    const request = parseAampMail(mail, this.options.mailbox.email);
    if (!request) return;
    const key = hashObject({
      mailbox: this.options.mailbox.email,
      from: request.from,
      taskId: request.taskId,
    });
    const prior = this.journal.task(key);
    const cancellationRoutes = this.routes.filter(
      (route) => route.from === request.from,
    );
    const route =
      request.intent === "task.cancel"
        ? prior
          ? (this.route(prior.request) ?? {
              session: prior.channel.slice("axp-session:/".length),
            })
          : cancellationRoutes.length === 1
            ? cancellationRoutes[0]
            : undefined
        : this.route(request);
    if (!route)
      throw new Error("No unique sender/session/context admission rule");
    if (
      !this.journal.admitMessage(
        hashObject({ from: request.from, messageId: request.messageId }),
        hashObject(request),
      )
    )
      return;
    const task: MailTask = prior ?? {
      key,
      request,
      channel: channels(route.session).exchange,
      status: "queued",
      turnId: `aamp-${key}`,
      startedAt: new Date(this.now()).toISOString(),
      cancelRequested: false,
    };
    if (request.intent === "card.query") {
      this.reply(task, "card", {
        intent: "card.response",
        text: "AXP accepts text tasks into an explicitly assigned repository session. ACP agents execute under donor budgets. Results identify the exact session and checkpoint; completion does not imply maintainer approval or merge. Tool permissions are reviewed in AXP. AAMP streaming and attachment execution are not advertised.",
      });
      return;
    }
    if (request.intent === "pair.request") {
      this.reply(task, "pair", {
        intent: "pair.respond",
        status: "rejected",
        error: "Local configuration required",
        text: "This adapter uses locally configured sender and session rules. Pair this mailbox through its AAMP service administrator.",
      });
      return;
    }
    if (request.intent === "task.cancel") {
      if (prior && !["queued", "running"].includes(prior.status)) return;
      task.cancelRequested = true;
      this.journal.suppress(key);
      this.journal.save(task);
      return;
    }
    if (prior) {
      // A task id names one turn. Redelivery with a new Message-ID still cannot run it twice.
      if (prior.request.text !== request.text && !prior.cancelRequested)
        throw new Error(
          "Task ID reused with different instructions; use a new task ID for the next turn",
        );
      return;
    }
    this.journal.save(task);
    const reject = mail.truncated
      ? "The task body was truncated by the mailbox service."
      : mail.attachments.length
        ? "Attachment tasks are not supported by this adapter; provide repository context in the text."
        : Buffer.byteLength(request.text) > 48_000
          ? "Task text exceeds 48 KB."
          : !request.text.trim()
            ? "Task text is empty."
            : request.expiresAt && Date.parse(request.expiresAt) <= this.now()
              ? "Task expired before admission."
              : this.journal.active().length > 256
                ? "The adapter task queue is full."
                : null;
    if (reject) this.finish(task, "rejected", reject);
    else
      this.reply(task, "ack", {
        intent: "task.ack",
        text: `Task admitted to AXP session ${route.session}.`,
      });
  }

  private async reconcile(task: MailTask, client: AxpClient): Promise<void> {
    const allowed = this.route(task.request);
    if (!allowed || channels(allowed.session).exchange !== task.channel)
      task.cancelRequested = true;
    const state = await client.snapshot<ExchangeState>(task.channel);
    const chat = await client.snapshot<ChatState>(state.chat);
    const turn = chat.turns.find((turn) => turn.id === task.turnId);
    if (turn && !task.cancelRequested) {
      const text = turn.responseParts
        .filter((part) => part.kind === "markdown")
        .map((part) => part.content)
        .join("\n\n");
      const archive = await client.call("_axp/export", {
        channel: task.channel,
      });
      const start =
        archive.actions.find(
          (e) =>
            e.action.type === ActionType.ChatTurnStarted &&
            e.action.turnId === task.turnId,
        )?.serverSeq ?? Infinity;
      const end =
        archive.actions.find(
          ({ action }) =>
            (action.type === ActionType.ChatTurnComplete ||
              action.type === ActionType.ChatTurnCancelled ||
              action.type === ActionType.ChatError) &&
            action.turnId === task.turnId,
        )?.serverSeq ?? -1;
      const checkpoint = archive.actions
        .filter(
          (e) =>
            e.serverSeq > start &&
            e.serverSeq < end &&
            e.action.type === "_axp/checkpointChanged",
        )
        .at(-1)?.action;
      this.finish(
        task,
        turn.state === "complete" ? "completed" : "rejected",
        text || `AXP turn ${turn.state}.`,
        [
          {
            fieldKey: "axp.session",
            fieldTypeKey: "text",
            value: state.session,
          },
          { fieldKey: "axp.turn", fieldTypeKey: "text", value: task.turnId },
          ...(checkpoint?.type === "_axp/checkpointChanged"
            ? [
                {
                  fieldKey: "axp.checkpoint",
                  fieldTypeKey: "text" as const,
                  value: checkpoint.checkpoint.headCommit,
                },
              ]
            : []),
        ],
      );
      return;
    }
    if (
      task.request.expiresAt &&
      Date.parse(task.request.expiresAt) <= this.now()
    )
      task.cancelRequested = true;
    if (task.cancelRequested) {
      // Persist the intent before touching the host, including when the reply is lost.
      this.journal.save(task);
      if (chat.activeTurn?.id === task.turnId)
        await client.dispatch(
          state.chat,
          {
            type: ActionType.ChatTurnCancelled,
            turnId: task.turnId,
            duration: 0,
          },
          `aamp-cancel-${task.key}`,
        );
      this.finish(
        task,
        "cancelled",
        "Task cancelled, expired, or its local admission rule was removed.",
      );
      return;
    }
    if (state.status === "closed") {
      this.finish(task, "rejected", "The assigned AXP session is closed.");
      return;
    }
    if (chat.activeTurn?.id === task.turnId) {
      task.status = "running";
      this.journal.save(task);
      for (const part of chat.activeTurn.responseParts) {
        if (
          part.kind !== "toolCall" ||
          part.toolCall.status !== "pending-confirmation"
        )
          continue;
        const tool = part.toolCall;
        this.reply(task, `help-${hashObject(tool)}`, {
          intent: "task.help_needed",
          text: `AXP needs maintainer approval for ${tool.displayName}.\n\nOpen session ${allowed!.session} in AXP to inspect and answer tool ${tool.toolCallId}. Mail replies do not grant tool permissions. Send task.cancel to withdraw the task.`,
        });
      }
      return;
    }
    if (chat.activeTurn || state.reservation) return;
    if (task.status === "running") {
      this.finish(
        task,
        "rejected",
        "The admitted AXP turn is no longer present; it will not be replayed.",
      );
      return;
    }
    await client.dispatch(
      state.chat,
      {
        type: ActionType.ChatTurnStarted,
        turnId: task.turnId,
        startedAt: task.startedAt,
        message: {
          text: task.request.text,
          origin: { kind: MessageKind.User },
          _meta: {
            "org.axp.aamp": {
              from: task.request.from,
              taskId: task.request.taskId,
              messageId: task.request.messageId,
              sessionKey: task.request.sessionKey ?? null,
            },
          },
        },
      },
      `aamp-dispatch-${task.key}`,
    );
    task.status = "running";
    this.journal.save(task);
  }

  private finish(
    task: MailTask,
    status: "completed" | "rejected" | "cancelled",
    text: string,
    structuredResult?: AampReply["structuredResult"],
  ): void {
    // Called both inside admission's transaction and after async host operations.
    // Reconciliation is replayable; stable outbox ids close a crash between these writes.
    if (status === "cancelled") this.journal.suppress(task.key);
    this.reply(task, "result", {
      intent: "task.result",
      status: status === "completed" ? "completed" : "rejected",
      text:
        text.length > 128_000
          ? `${text.slice(0, 128_000)}\n\n[Output shortened; the full transcript remains in AXP.]`
          : text,
      ...(status === "completed" ? {} : { error: text.slice(0, 500) }),
      ...(structuredResult ? { structuredResult } : {}),
    });
    task.status = status;
    this.journal.save(task);
  }

  private reply(
    task: MailTask,
    event: string,
    reply: Pick<AampReply, "intent" | "text"> &
      Partial<Pick<AampReply, "status" | "error" | "structuredResult">>,
  ): void {
    const key = hashObject({ task: task.key, event });
    this.journal.reply(key, task.key, {
      ...reply,
      to: task.request.from,
      taskId: task.request.taskId,
      inReplyTo: task.request.messageId,
      messageId: `<axp-${key}@${this.options.mailbox.email.split("@")[1]}>`,
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.options.mailbox.close();
    this.closing = (async () => {
      await this.syncing?.catch(() => {});
      try {
        await this.client?.close();
      } finally {
        this.journal.close();
      }
    })();
    return this.closing;
  }
}

function isCancel(mail: AampMail): boolean {
  return mail.headers.some(
    (h) =>
      h.name.toLowerCase() === "x-aamp-intent" && h.value === "task.cancel",
  );
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
function errorCode(error: unknown): number {
  return error instanceof Error && "code" in error ? Number(error.code) : 0;
}
