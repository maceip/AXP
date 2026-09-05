import { randomUUID } from "node:crypto";
import {
  ActionType,
  SessionStatus,
  SessionLifecycle,
  PendingMessageKind,
  MessageKind,
  ResponsePartKind,
  SessionInputRequestKind,
  ToolCallConfirmationReason,
} from "@microsoft/agent-host-protocol";
import type {
  ActionOrigin,
  ChatState,
  SessionState,
  ToolCallState,
  RootState,
} from "@microsoft/agent-host-protocol";
import type { Store, Transaction } from "./store.js";
import {
  AXP_VERSION,
  CAPABILITY,
  ROOT,
  MEMORY,
  EXECUTORS,
  channels,
} from "./protocol/types.js";
import type {
  ExchangeState,
  Principal,
  Lease,
  Grant,
  Usage,
  Allowance,
  BlobRef,
  ExecutorRegistry,
} from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";
import { actionFrom } from "./validation.js";
import { reserve, settle, ZERO, within } from "./budget.js";
import { contextHash } from "./context.js";
import type { Params } from "./protocol/schema.js";

const EXECUTOR_ACTIONS = new Set<string>([
  ActionType.ChatResponsePart,
  ActionType.ChatDelta,
  ActionType.ChatReasoning,
  ActionType.ChatToolCallStart,
  ActionType.ChatToolCallDelta,
  ActionType.ChatToolCallReady,
  ActionType.ChatToolCallComplete,
  ActionType.ChatToolCallContentChanged,
]);

export class Sessions {
  constructor(
    readonly store: Store,
    readonly repository: string,
    readonly now: () => number = Date.now,
  ) {
    if (!store.has(ROOT))
      store.transaction((tx) => {
        tx.create(ROOT, {
          agents: [
            {
              provider: "axp",
              displayName: "Parked ACP agent",
              description: "Contributor-owned or hosted ACP execution",
              models: [],
            },
          ],
          _meta: {
            [CAPABILITY]: {
              version: AXP_VERSION,
              memory: MEMORY,
              executors: EXECUTORS,
            },
          },
        } satisfies RootState);
        tx.create(MEMORY, { resource: MEMORY, entries: {} });
        tx.create(EXECUTORS, { resource: EXECUTORS, entries: {} });
      });
    if (!store.has(EXECUTORS))
      store.transaction((tx) =>
        tx.create(EXECUTORS, { resource: EXECUTORS, entries: {} }),
      );
  }
  register(tx: Transaction, actor: Principal, params: Params<"_axp/register">) {
    this.contribute(actor);
    const prior =
      this.store.get<ExecutorRegistry>(EXECUTORS).entries[params.executorId];
    requireThat(
      !prior || prior.owner === actor.id,
      Codes.forbidden,
      "Executor identity belongs to another contributor",
    );
    const executor = {
      id: params.executorId,
      owner: actor.id,
      name: params.name,
      placement: params.placement,
      capabilities: params.capabilities,
      expiresAt: this.now() + params.ttlMs,
      online: true,
    };
    tx.emit(EXECUTORS, { type: "_axp/executorChanged", executor });
    return executor;
  }
  exchangeChannel(resource: string): string {
    const match =
      /^(?:axp-session|ahp-session|ahp-chat|ahp-changeset):\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/.exec(
        resource,
      );
    requireThat(match, Codes.invalid, "Expected a session channel");
    return `axp-session:/${match[1]}`;
  }
  state(resource: string): ExchangeState {
    return this.store.get(this.exchangeChannel(resource));
  }
  readable(principal: Principal, resource: string): boolean {
    if (resource === ROOT || resource === MEMORY || resource === EXECUTORS)
      return true;
    try {
      const exchange = this.exchangeChannel(resource);
      return (
        principal.sessions === "*" ||
        principal.sessions.includes(exchange) ||
        principal.sessions.includes(exchange.replace("axp-", "ahp-"))
      );
    } catch {
      return false;
    }
  }
  authorize(principal: Principal, resource: string): void {
    requireThat(
      this.readable(principal, resource),
      Codes.forbidden,
      "Channel is outside your assigned scope",
    );
  }
  maintain(principal: Principal): void {
    requireThat(
      principal.role === "maintainer",
      Codes.forbidden,
      "Maintainer authority required",
    );
  }
  contribute(principal: Principal): void {
    requireThat(
      principal.role === "contributor" || principal.role === "maintainer",
      Codes.forbidden,
      "Contributor authority required",
    );
  }
  create(
    tx: Transaction,
    principal: Principal,
    resource: string,
    title: string,
    task: string,
  ): ExchangeState {
    this.maintain(principal);
    this.authorize(principal, resource);
    const exchange = this.exchangeChannel(resource);
    requireThat(
      !this.store.has(exchange),
      Codes.alreadyExists,
      "Session already exists",
    );
    requireThat(
      !this.store.list("axp-session:/").some((c) => {
        const s = this.state(c);
        return s.task === task && s.status !== "closed";
      }),
      Codes.conflict,
      "An open session already owns this task",
    );
    const c = channels(exchange.slice("axp-session:/".length));
    const context = {
      revision: 0,
      throughTurn: 0,
      summary: "",
      decisions: [],
      activeFiles: [],
      gitHead: null,
    };
    const state: ExchangeState = {
      resource: c.exchange,
      session: c.session,
      chat: c.chat,
      repository: this.repository,
      task,
      status: "open",
      epoch: 0,
      lease: null,
      grants: {},
      reservation: null,
      usage: [],
      checkpoint: null,
      context: { ...context, prefixHash: contextHash(context) },
      compaction: null,
      review: null,
      verification: null,
    };
    const summary = {
      resource: c.chat,
      title,
      status: SessionStatus.Idle,
      modifiedAt: new Date(this.now()).toISOString(),
    };
    tx.create(c.exchange, state);
    tx.create(c.chat, { ...summary, turns: [] } satisfies ChatState);
    tx.create(c.session, {
      provider: "axp",
      title,
      status: SessionStatus.Idle,
      lifecycle: SessionLifecycle.Ready,
      activeClients: [],
      chats: [summary],
      defaultChat: c.chat,
      changesets: [
        {
          label: "Git checkpoint",
          uriTemplate: c.changeset,
          changeKind: "session",
        },
      ],
      _meta: { [CAPABILITY]: { channel: c.exchange } },
    } satisfies SessionState);
    tx.create(c.changeset, { status: "ready", files: [] });
    return state;
  }
  grant(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    id: string,
    limit: Allowance,
    enforcement: Grant["enforcement"],
  ): Grant {
    this.contribute(principal);
    const old = state.grants[id];
    requireThat(
      !old || old.owner === principal.id,
      Codes.forbidden,
      "Only the donor can change this grant",
    );
    const committed = old?.spent ?? ZERO;
    requireThat(
      within(committed, limit),
      Codes.budget,
      "Limit is below recorded spending",
    );
    requireThat(
      !state.reservation || state.reservation.grantId !== id,
      Codes.conflict,
      "Cannot change a grant during a reserved turn; revoke to stop",
    );
    const grant: Grant = {
      id,
      owner: principal.id,
      limit,
      spent: committed,
      revoked: false,
      enforcement,
    };
    tx.emit(state.resource, { type: "_axp/grantChanged", grant });
    return grant;
  }
  revoke(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    id: string,
  ): void {
    const grant = state.grants[id];
    requireThat(
      grant?.owner === principal.id,
      Codes.forbidden,
      "Only the donor can revoke this grant",
    );
    tx.emit(state.resource, {
      type: "_axp/grantChanged",
      grant: { ...grant, revoked: true },
    });
    if (state.lease?.grantId === id)
      this.orphan(tx, this.state(state.resource), "Donation revoked");
  }
  claim(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    executorId: string,
    grantId: string,
    leaseMs: number,
  ): Lease {
    this.contribute(principal);
    requireThat(state.status !== "closed", Codes.conflict, "Session is closed");
    if (state.lease && state.lease.expiresAt <= this.now()) {
      this.orphan(tx, state, "Executor lease expired");
      state = this.state(state.resource);
    }
    requireThat(
      !state.lease,
      Codes.conflict,
      "Session already has an executor",
    );
    const grant = state.grants[grantId];
    const executor =
      this.store.get<ExecutorRegistry>(EXECUTORS).entries[executorId];
    requireThat(
      !executor || executor.owner === principal.id,
      Codes.forbidden,
      "Executor identity belongs to another contributor",
    );
    requireThat(
      grant && grant.owner === principal.id && !grant.revoked,
      Codes.forbidden,
      "An active donation owned by this principal is required",
    );
    const epoch = state.epoch + 1;
    const lease: Lease = {
      owner: principal.id,
      executorId,
      epoch,
      expiresAt: this.now() + leaseMs,
      heartbeatMs: Math.floor(leaseMs / 3),
      grantId,
    };
    tx.emit(state.resource, {
      type: "_axp/leaseChanged",
      lease,
      epoch,
      status: "open",
    });
    return lease;
  }
  fenced(principal: Principal, state: ExchangeState, epoch: number): Lease {
    this.contribute(principal);
    requireThat(
      state.lease &&
        state.lease.owner === principal.id &&
        state.lease.epoch === epoch &&
        state.lease.expiresAt > this.now() &&
        state.status === "open",
      Codes.stale,
      "Executor lease is stale or belongs to another principal",
    );
    requireThat(
      !state.grants[state.lease.grantId]?.revoked,
      Codes.budget,
      "Donation revoked",
    );
    return state.lease;
  }
  renew(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    epoch: number,
  ): Lease {
    const current = this.fenced(principal, state, epoch);
    const lease = {
      ...current,
      expiresAt: this.now() + current.heartbeatMs * 3,
    };
    const executor =
      this.store.get<ExecutorRegistry>(EXECUTORS).entries[lease.executorId];
    if (executor)
      tx.emit(EXECUTORS, {
        type: "_axp/executorChanged",
        executor: { ...executor, online: true, expiresAt: lease.expiresAt },
      });
    tx.emit(state.resource, {
      type: "_axp/leaseChanged",
      lease,
      epoch,
      status: "open",
    });
    return lease;
  }
  reserve(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    epoch: number,
    turnId: string,
    ceiling: Allowance,
  ): void {
    const lease = this.fenced(principal, state, epoch);
    requireThat(
      !state.reservation,
      Codes.conflict,
      "A turn is already reserved",
    );
    const chat = this.store.get<ChatState>(state.chat);
    requireThat(
      chat.activeTurn?.id === turnId,
      Codes.conflict,
      "Turn is no longer active",
    );
    const grant = state.grants[lease.grantId];
    requireThat(grant, Codes.budget, "Donation not found");
    reserve(grant, ceiling);
    tx.emit(state.resource, {
      type: "_axp/reserved",
      reservation: {
        turnId,
        grantId: grant.id,
        epoch,
        ceiling,
        startedAt: this.now(),
      },
    });
  }
  finish(
    tx: Transaction,
    state: ExchangeState,
    usage: Usage | null,
    outcome: "complete" | "cancelled" | "error",
    error = "Executor failed",
  ): void {
    const reservation = state.reservation;
    if (reservation) {
      const grant = state.grants[reservation.grantId];
      requireThat(grant, Codes.internal, "Reservation lost its grant");
      const result = settle(grant, reservation, usage);
      tx.emit(state.resource, {
        type: "_axp/settled",
        turnId: reservation.turnId,
        ...result,
      });
    }
    const chat = this.store.get<ChatState>(state.chat);
    if (!chat.activeTurn) return;
    const turnId = chat.activeTurn.id;
    const duration = reservation
      ? Math.max(0, this.now() - reservation.startedAt)
      : 0;
    if (usage)
      tx.emit(state.chat, {
        type: ActionType.ChatUsage,
        turnId,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          _meta: {
            [CAPABILITY]: {
              costMicros: usage.costMicros,
              source: usage.source,
              costSource: usage.costSource ?? usage.source,
            },
          },
        },
      });
    if (outcome === "complete")
      tx.emit(state.chat, {
        type: ActionType.ChatTurnComplete,
        turnId,
        duration,
      });
    else if (outcome === "cancelled")
      tx.emit(state.chat, {
        type: ActionType.ChatTurnCancelled,
        turnId,
        duration,
      });
    else
      tx.emit(state.chat, {
        type: ActionType.ChatError,
        turnId,
        duration,
        part: {
          kind: ResponsePartKind.Error,
          error: { errorType: "executor", message: error },
        },
      });
    this.syncChat(tx, state);
  }
  orphan(tx: Transaction, state: ExchangeState, reason: string): void {
    this.finish(tx, state, null, "error", reason);
    tx.emit(state.resource, {
      type: "_axp/leaseChanged",
      lease: null,
      epoch: state.epoch,
      status: "orphaned",
    });
  }
  close(tx: Transaction, actor: Principal, state: ExchangeState): void {
    this.maintain(actor);
    if (state.status === "closed") return;
    this.finish(tx, state, null, "cancelled");
    const chat = this.store.get<ChatState>(state.chat);
    if (chat.steeringMessage)
      tx.emit(state.chat, {
        type: ActionType.ChatPendingMessageRemoved,
        kind: PendingMessageKind.Steering,
        id: chat.steeringMessage.id,
      });
    for (const pending of chat.queuedMessages ?? [])
      tx.emit(state.chat, {
        type: ActionType.ChatPendingMessageRemoved,
        kind: PendingMessageKind.Queued,
        id: pending.id,
      });
    tx.emit(state.resource, {
      type: "_axp/leaseChanged",
      lease: null,
      epoch: state.epoch,
      status: "closed",
    });
    tx.emit(state.session, {
      type: ActionType.SessionIsArchivedChanged,
      isArchived: true,
    });
  }
  tick(tx: Transaction): void {
    for (const executor of Object.values(
      this.store.get<ExecutorRegistry>(EXECUTORS).entries,
    )) {
      if (executor.online && executor.expiresAt <= this.now())
        tx.emit(EXECUTORS, {
          type: "_axp/executorChanged",
          executor: { ...executor, online: false },
        });
    }
    for (const resource of this.store.list("axp-session:/")) {
      const state = this.state(resource);
      if (state.lease && state.lease.expiresAt <= this.now())
        this.orphan(tx, state, "Executor lease expired");
    }
  }
  tool(chat: ChatState, id: string): ToolCallState | undefined {
    const part = chat.activeTurn?.responseParts.find(
      (p) => p.kind === "toolCall" && p.toolCall.toolCallId === id,
    );
    return part?.kind === "toolCall" ? part.toolCall : undefined;
  }
  emit(
    tx: Transaction,
    principal: Principal,
    state: ExchangeState,
    epoch: number,
    raw: readonly unknown[],
  ): void {
    this.fenced(principal, state, epoch);
    requireThat(
      state.reservation?.epoch === epoch,
      Codes.budget,
      "Reserve a turn before producing output",
    );
    for (const value of raw) {
      const action = actionFrom(value);
      requireThat(
        EXECUTOR_ACTIONS.has(action.type),
        Codes.forbidden,
        "Executor cannot originate this AHP action",
      );
      const chat = this.store.get<ChatState>(state.chat);
      requireThat(
        "turnId" in action && action.turnId === chat.activeTurn?.id,
        Codes.stale,
        "Action does not belong to the active turn",
      );
      if (action.type === ActionType.ChatResponsePart) {
        requireThat(
          ["markdown", "reasoning", "contentRef"].includes(action.part.kind),
          Codes.forbidden,
          "Use typed tool or error transitions",
        );
        if ("id" in action.part) {
          const partId = action.part.id;
          requireThat(
            !chat.activeTurn.responseParts.some(
              (p) => "id" in p && p.id === partId,
            ),
            Codes.conflict,
            "Response part already exists",
          );
        }
      }
      if (action.type === ActionType.ChatDelta)
        requireThat(
          chat.activeTurn.responseParts.some(
            (p) => p.kind === "markdown" && p.id === action.partId,
          ),
          Codes.conflict,
          "Text delta requires an existing markdown part",
        );
      if (action.type === ActionType.ChatReasoning)
        requireThat(
          chat.activeTurn.responseParts.some(
            (p) => p.kind === "reasoning" && p.id === action.partId,
          ),
          Codes.conflict,
          "Reasoning delta requires an existing reasoning part",
        );
      if ("toolCallId" in action) {
        requireThat(
          !("contributor" in action) && !("clientId" in action),
          Codes.forbidden,
          "Tool authority is assigned by the host",
        );
        const tool = this.tool(chat, action.toolCallId);
        if (action.type === ActionType.ChatToolCallStart)
          requireThat(!tool, Codes.conflict, "Tool call already exists");
        else requireThat(tool, Codes.conflict, "Unknown tool call");
        if (
          action.type === ActionType.ChatToolCallComplete ||
          action.type === ActionType.ChatToolCallContentChanged
        )
          requireThat(
            tool?.status === "running",
            Codes.forbidden,
            "Tool must be running before it can produce results",
          );
        if (action.type === ActionType.ChatToolCallReady) {
          requireThat(
            !action.confirmed ||
              (action.confirmed === ToolCallConfirmationReason.NotNeeded &&
                !action.options),
            Codes.forbidden,
            "An executor cannot claim user approval",
          );
          requireThat(
            tool?.status === "streaming" || tool?.status === "running",
            Codes.conflict,
            "Tool is not ready for confirmation",
          );
          requireThat(
            !action.editable,
            Codes.invalid,
            "ACP cannot edit permission request input",
          );
          if (action.options)
            requireThat(
              action.options.length > 0 &&
                new Set(action.options.map((o) => o.id)).size ===
                  action.options.length,
              Codes.invalid,
              "Confirmation options must be nonempty and unique",
            );
        }
      }
      this.checkRefs(state.resource, action);
      tx.emit(state.chat, action);
    }
    this.syncChat(tx, state);
  }
  dispatch(
    tx: Transaction,
    principal: Principal,
    resource: string,
    raw: unknown,
    origin: ActionOrigin,
  ): void {
    this.maintain(principal);
    const state = this.state(resource);
    requireThat(
      resource === state.chat && state.status !== "closed",
      Codes.invalid,
      "Dispatch to an open chat channel",
    );
    const action = actionFrom(raw);
    const chat = this.store.get<ChatState>(state.chat);
    switch (action.type) {
      case ActionType.ChatTurnStarted:
        requireThat(
          !chat.activeTurn && !state.reservation,
          Codes.busy,
          "A turn is already active; steer or queue a message",
        );
        requireThat(
          !chat.turns.some((t) => t.id === action.turnId),
          Codes.conflict,
          "Turn ID already exists",
        );
        requireThat(
          action.message.origin.kind === MessageKind.User,
          Codes.forbidden,
          "Only user messages are accepted",
        );
        tx.emit(
          resource,
          { ...action, startedAt: new Date(this.now()).toISOString() },
          origin,
        );
        break;
      case ActionType.ChatPendingMessageSet:
        requireThat(
          action.message.origin.kind === MessageKind.User,
          Codes.forbidden,
          "Only user messages are accepted",
        );
        requireThat(
          (chat.queuedMessages?.length ?? 0) < 32,
          Codes.limit,
          "Pending message limit reached",
        );
        tx.emit(resource, action, origin);
        if (action.kind === PendingMessageKind.Steering && chat.activeTurn)
          this.finish(tx, state, null, "cancelled");
        // ACP v1 has no interoperable mid-prompt steering. Cancel and make the
        // steer the next turn, preserving both turns and charging uncertainty.
        this.nextTurn(tx, state);
        break;
      case ActionType.ChatPendingMessageRemoved:
        tx.emit(resource, action, origin);
        break;
      case ActionType.ChatTurnCancelled:
        requireThat(
          chat.activeTurn?.id === action.turnId,
          Codes.conflict,
          "Turn is not active",
        );
        // Echo the client origin on the cancellation for optimistic reconciliation.
        if (state.reservation) {
          const grant = state.grants[state.reservation.grantId];
          requireThat(grant, Codes.internal, "Missing grant");
          tx.emit(state.resource, {
            type: "_axp/settled",
            turnId: action.turnId,
            ...settle(grant, state.reservation, null),
          });
        }
        tx.emit(resource, action, origin);
        break;
      case ActionType.ChatToolCallConfirmed: {
        requireThat(
          chat.activeTurn?.id === action.turnId,
          Codes.conflict,
          "Turn is not active",
        );
        const tool = this.tool(chat, action.toolCallId);
        requireThat(
          tool?.status === "pending-confirmation",
          Codes.conflict,
          "Tool is not awaiting confirmation",
        );
        requireThat(
          !("editedToolInput" in action),
          Codes.invalid,
          "ACP permission choices cannot edit input",
        );
        if (tool.options) {
          const option = tool.options.find(
            (o) => o.id === action.selectedOptionId,
          );
          requireThat(
            option && (option.kind === "approve") === action.approved,
            Codes.invalid,
            "Choose a matching offered permission option",
          );
        }
        requireThat(
          state.lease && state.lease.expiresAt > this.now(),
          Codes.stale,
          "Executor is no longer available",
        );
        requireThat(
          state.lease.owner !== principal.id,
          Codes.forbidden,
          "An executor cannot approve its own tool call",
        );
        tx.emit(resource, action, origin);
        break;
      }
      default:
        requireThat(
          false,
          Codes.forbidden,
          "This AHP interaction is not supported by AXP",
        );
    }
    this.syncChat(tx, state);
  }
  nextTurn(tx: Transaction, state: ExchangeState): void {
    const chat = this.store.get<ChatState>(state.chat);
    if (chat.activeTurn) return;
    const pending = chat.steeringMessage ?? chat.queuedMessages?.[0];
    if (!pending) return;
    const kind = chat.steeringMessage
      ? PendingMessageKind.Steering
      : PendingMessageKind.Queued;
    tx.emit(state.chat, {
      type: ActionType.ChatPendingMessageRemoved,
      kind,
      id: pending.id,
    });
    tx.emit(state.chat, {
      type: ActionType.ChatTurnStarted,
      turnId: randomUUID(),
      startedAt: new Date(this.now()).toISOString(),
      message: pending.message,
    });
    this.syncChat(tx, state);
  }
  syncChat(tx: Transaction, state: ExchangeState): void {
    const chat = this.store.get<ChatState>(state.chat);
    tx.emit(state.session, {
      type: ActionType.SessionChatUpdated,
      chat: state.chat,
      changes: {
        status: chat.status,
        modifiedAt: new Date(this.now()).toISOString(),
      },
    });
    const session = this.store.get<SessionState>(state.session);
    for (const request of session.inputNeeded ?? [])
      tx.emit(state.session, {
        type: ActionType.SessionInputNeededRemoved,
        id: request.id,
      });
    for (const part of chat.activeTurn?.responseParts ?? []) {
      if (
        part.kind === "toolCall" &&
        part.toolCall.status === "pending-confirmation"
      ) {
        tx.emit(state.session, {
          type: ActionType.SessionInputNeededSet,
          request: {
            id: part.toolCall.toolCallId,
            chat: state.chat,
            kind: SessionInputRequestKind.ToolConfirmation,
            turnId: chat.activeTurn!.id,
            toolCall: part.toolCall,
          },
        });
      }
    }
  }
  checkBlob(resource: string, ref: BlobRef): void {
    const row = this.store.db
      .prepare(
        "SELECT length(b.data) AS size FROM blob_access a JOIN blobs b ON b.digest=a.digest WHERE a.channel=? AND a.digest=?",
      )
      .get(resource, ref.sha256);
    requireThat(
      row &&
        Number(row.size) === ref.size &&
        ref.uri === `axp-blob:/${encodeURIComponent(resource)}/${ref.sha256}`,
      Codes.forbidden,
      "Blob reference is missing or outside the session",
    );
  }
  checkRefs(resource: string, value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.checkRefs(resource, item);
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if ("uri" in object) {
        requireThat(
          typeof object.uri === "string" &&
            object.uri.startsWith(`axp-blob:/${encodeURIComponent(resource)}/`),
          Codes.forbidden,
          "Executor content references must use session-owned blobs",
        );
        const digest = object.uri.split("/").at(-1)!;
        requireThat(
          !!this.store.db
            .prepare("SELECT 1 FROM blob_access WHERE channel=? AND digest=?")
            .get(resource, digest),
          Codes.forbidden,
          "Unknown content reference",
        );
      }
      for (const item of Object.values(object)) this.checkRefs(resource, item);
    }
  }
}
