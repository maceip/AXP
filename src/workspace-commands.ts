import { z } from "zod";
import {
  ActionType,
  MessageKind,
  PendingMessageKind,
  ToolCallConfirmationReason,
  ToolCallCancellationReason,
} from "@microsoft/agent-host-protocol";
import type { ChatState, SessionState } from "@microsoft/agent-host-protocol";
import type { AxpClient } from "./client.js";
import { channels, ROOT } from "./protocol/types.js";
import type { ExchangeState } from "./protocol/types.js";
import { id, sha, digest, methods } from "./protocol/schema.js";
import { Codes, requireThat } from "./protocol/errors.js";
import { hashObject, signObject } from "./hash.js";
import { reviewManifest } from "./review.js";

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

type PreparedCommand = (client: AxpClient) => Promise<unknown>;
interface CommandReceipt {
  fingerprint: string;
  prepared: Promise<PreparedCommand>;
  running?: Promise<unknown> | undefined;
  busy: boolean;
}

/** Local retry preparation; all mutation authority and durable receipts remain on the host. */
export class WorkspaceCommands {
  private readonly commands = new Map<string, CommandReceipt>();
  constructor(private readonly signingKey?: string) {}
  async execute(client: AxpClient, raw: unknown): Promise<unknown> {
    const input = commandSchema.parse(raw);
    const fingerprint = hashObject(input);
    let receipt = this.commands.get(input.operationId);
    requireThat(
      !receipt || receipt.fingerprint === fingerprint,
      Codes.conflict,
      "Operation ID reused with different input",
    );
    if (!receipt) {
      if (this.commands.size >= 256) {
        const idle = [...this.commands].find(([, entry]) => !entry.busy);
        requireThat(
          idle,
          Codes.busy,
          "Workspace has too many pending commands",
        );
        this.commands.delete(idle[0]);
      }
      receipt = {
        fingerprint,
        prepared: this.prepareCommand(client, input),
        busy: false,
      };
      this.commands.set(input.operationId, receipt);
      const entry = receipt;
      void entry.prepared.catch(() => {
        if (this.commands.get(input.operationId) === entry)
          this.commands.delete(input.operationId);
      });
    }
    const entry = receipt;
    // Freeze permission choices/signatures before execution. A lost response must
    // retry those same host parameters, even after the turn or manifest advances.
    if (!entry.running) {
      entry.busy = true;
      entry.running = entry.prepared
        .then((execute) => execute(client))
        .then((result) => result ?? null)
        .catch((error) => {
          entry.running = undefined;
          throw error;
        })
        .finally(() => {
          entry.busy = false;
        });
    }
    return entry.running;
  }
  private async prepareCommand(
    client: AxpClient,
    input: z.infer<typeof commandSchema>,
  ): Promise<PreparedCommand> {
    const { action, operationId } = input;
    const c = channels(input.session);
    if (action.kind === "create")
      return async (client) => {
        requireThat(
          client.principalRole === "maintainer",
          Codes.forbidden,
          "Maintainer authority required",
        );
        const list = await client.ahp.request("listSessions", {
          channel: ROOT,
        });
        if (list.items.some((item) => item.resource === c.session)) {
          const state = await client.snapshot<SessionState>(c.session);
          const exchange = await client.snapshot<ExchangeState>(c.exchange);
          requireThat(
            state.title === action.title && exchange.task === action.task,
            Codes.conflict,
            "Session ID already belongs to different work",
          );
        } else
          await client.ahp.request("createSession", {
            channel: c.session,
            provider: "axp",
            config: { title: action.title, task: action.task },
          });
        return { session: input.session };
      };
    if (action.kind === "comment")
      return (client) =>
        client.call("_axp/comment", {
          channel: c.exchange,
          operationId,
          body: action.body,
          checkpoint: action.checkpoint,
          path: action.path,
        });
    if (action.kind === "submit") {
      requireThat(
        this.signingKey,
        Codes.invalid,
        "Start axp ui with --key to submit an artifact",
      );
      const state = await client.snapshot<ExchangeState>(c.exchange);
      requireThat(
        state.checkpoint?.headCommit === action.checkpoint,
        Codes.conflict,
        "Checkpoint changed; inspect the current changes before submitting",
      );
      const manifest = await reviewManifest(client, state, action.model);
      const contributor = signObject(manifest, this.signingKey);
      return (client) =>
        client.call("_axp/review", {
          channel: c.exchange,
          operationId,
          manifest,
          contributor,
        });
    }
    if (action.kind === "accept") {
      requireThat(
        this.signingKey,
        Codes.invalid,
        "Start axp ui with --key to approve an artifact",
      );
      const state = await client.snapshot<ExchangeState>(c.exchange);
      requireThat(
        state.review &&
          state.checkpoint?.headCommit === action.checkpoint &&
          hashObject(state.review.manifest) === action.manifestDigest,
        Codes.conflict,
        "Artifact changed; inspect the current review before approving",
      );
      const signature = signObject(state.review.manifest, this.signingKey);
      return (client) =>
        client.call("_axp/approveReview", {
          channel: c.exchange,
          operationId,
          signature,
        });
    }
    if (action.kind === "prompt") {
      const message = { text: action.text, origin: { kind: MessageKind.User } };
      return (client) =>
        client.dispatch(
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
      return (client) =>
        client.dispatch(
          c.chat,
          {
            type: ActionType.ChatTurnCancelled,
            turnId: action.turnId,
            duration: 0,
          },
          operationId,
        );
    } else {
      const chat = await client.snapshot<ChatState>(c.chat);
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
      return (client) =>
        client.dispatch(
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
  }
}
