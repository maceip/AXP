import type { ChatState } from "@microsoft/agent-host-protocol";
import type {
  Context,
  ExchangeState,
  Memory,
  MemoryState,
  Principal,
} from "./protocol/types.js";
import { MEMORY } from "./protocol/types.js";
import type { Params } from "./protocol/schema.js";
import type { Transaction } from "./store.js";
import type { Sessions } from "./sessions.js";
import { contextHash, workingContext } from "./context.js";
import { hashObject } from "./hash.js";
import { Codes, requireThat } from "./protocol/errors.js";

export class Knowledge {
  constructor(readonly sessions: Sessions) {}
  compact(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    params: Params<"_axp/compact">,
  ) {
    this.sessions.contribute(actor);
    const chat = this.sessions.store.get<ChatState>(state.chat);
    requireThat(
      !chat.activeTurn && !state.reservation,
      Codes.context,
      "Compaction requires a quiescent turn boundary",
    );
    requireThat(
      params.expectedRevision === state.context.revision,
      Codes.conflict,
      "Context revision changed",
    );
    requireThat(
      params.throughTurn > state.context.throughTurn &&
        params.throughTurn <= chat.turns.length,
      Codes.context,
      "Compaction range must advance through retained completed turns",
    );
    requireThat(
      params.summary.trim().length > 0,
      Codes.context,
      "Compaction requires a nonempty summary",
    );
    requireThat(
      state.checkpoint,
      Codes.context,
      "Record a Git checkpoint before compacting",
    );
    const base = {
      revision: state.context.revision + 1,
      throughTurn: params.throughTurn,
      summary: params.summary,
      decisions: params.decisions,
      activeFiles: params.activeFiles,
      gitHead: state.checkpoint.headCommit,
    };
    const context: Context = { ...base, prefixHash: contextHash(base) };
    const proposal = {
      id: params.operationId,
      author: actor.id,
      expectedRevision: params.expectedRevision,
      context,
      evidence: { fromSeq: 0, toSeq: this.sessions.store.seq },
    };
    tx.emit(state.resource, { type: "_axp/compactionProposed", proposal });
    return proposal;
  }
  accept(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    proposalId: string,
  ): Context {
    this.sessions.maintain(actor);
    const proposal = state.compaction;
    requireThat(
      proposal?.id === proposalId &&
        proposal.expectedRevision === state.context.revision,
      Codes.conflict,
      "Compaction proposal changed",
    );
    requireThat(
      !this.sessions.store.get<ChatState>(state.chat).activeTurn &&
        !state.reservation,
      Codes.context,
      "Finish the active turn before accepting compaction",
    );
    requireThat(
      state.checkpoint?.headCommit === proposal.context.gitHead,
      Codes.context,
      "Checkpoint changed since compaction was proposed",
    );
    tx.emit(state.resource, {
      type: "_axp/contextChanged",
      context: proposal.context,
    });
    return proposal.context;
  }
  propose(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    params: Params<"_axp/memoryPropose">,
  ): Memory {
    this.sessions.contribute(actor);
    requireThat(
      params.fromSeq <= params.toSeq && params.toSeq <= this.sessions.store.seq,
      Codes.invalid,
      "Invalid memory evidence range",
    );
    requireThat(
      this.sessions.store.events(
        [state.chat, state.resource],
        Math.max(0, params.fromSeq - 1),
        params.toSeq,
      ).length,
      Codes.invalid,
      "Memory requires evidence from this session",
    );
    const scope = this.sessions.repository;
    const content = {
      scope,
      title: params.title.trim(),
      trigger: params.trigger.trim(),
      lesson: params.lesson.trim(),
      outcome: params.outcome,
    };
    requireThat(
      content.title && content.trigger && content.lesson,
      Codes.invalid,
      "Memory text cannot be whitespace",
    );
    const id = hashObject(content);
    const prior = this.sessions.store.get<MemoryState>(MEMORY).entries[id];
    requireThat(
      !prior ||
        prior.evidence.every((e) => this.sessions.readable(actor, e.session)),
      Codes.forbidden,
      "Consolidating this lesson requires access to all its evidence",
    );
    const evidence = {
      session: state.session,
      fromSeq: params.fromSeq,
      toSeq: params.toSeq,
      gitHead: state.checkpoint?.headCommit ?? null,
    };
    const allEvidence = prior?.evidence ?? [];
    if (allEvidence.some((e) => hashObject(e) === hashObject(evidence)))
      return prior!;
    // New evidence never silently promotes a proposal or revives retired advice.
    const memory: Memory = {
      ...content,
      id,
      revision: (prior?.revision ?? 0) + 1,
      evidence: [...allEvidence, evidence],
      status: prior?.status ?? "proposed",
      author: prior?.author ?? actor.id,
    };
    tx.emit(MEMORY, { type: "_axp/memoryChanged", memory });
    return memory;
  }
  review(
    tx: Transaction,
    actor: Principal,
    id: string,
    revision: number,
    status: "accepted" | "retired",
  ): Memory {
    this.sessions.maintain(actor);
    const prior = this.sessions.store.get<MemoryState>(MEMORY).entries[id];
    requireThat(
      prior?.revision === revision,
      Codes.conflict,
      "Memory revision changed",
    );
    requireThat(
      prior.evidence.every((e) => this.sessions.readable(actor, e.session)),
      Codes.forbidden,
      "Review requires access to all memory evidence",
    );
    const memory = { ...prior, revision: revision + 1, status };
    tx.emit(MEMORY, { type: "_axp/memoryChanged", memory });
    return memory;
  }
  search(
    actor: Principal,
    query: string,
    limit: number,
  ): { items: Memory[]; total: number } {
    const words = new Set(
      query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [],
    );
    const matches = Object.values(
      this.sessions.store.get<MemoryState>(MEMORY).entries,
    )
      .filter(
        (m) =>
          m.scope === this.sessions.repository &&
          m.status === "accepted" &&
          m.evidence.every((e) => this.sessions.readable(actor, e.session)),
      )
      .map((memory) => {
        const text =
          `${memory.title} ${memory.trigger} ${memory.lesson}`.toLocaleLowerCase(
            "en-US",
          );
        return {
          memory,
          score: [...words].filter((word) => text.includes(word)).length,
        };
      })
      .filter((m) => !words.size || m.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id),
      );
    return {
      items: matches.slice(0, limit).map((m) => m.memory),
      total: matches.length,
    };
  }
  context(actor: Principal, state: ExchangeState, maxChars: number) {
    const chat = this.sessions.store.get<ChatState>(state.chat);
    const memories = this.search(actor, state.task, 5);
    const text = workingContext(state.context, chat, memories.items, maxChars);
    return {
      text,
      prefixHash: hashObject({ text }),
      revision: state.context.revision,
      throughTurn: state.context.throughTurn,
      memoryTotal: memories.total,
      memoryIncluded: memories.items.length,
    };
  }
}

/** Extraction is an application-supplied, separately budgeted operation. It
 * returns proposals, never policy or automatic shared-memory writes. */
export interface Distiller {
  extract(input: { transcript: string; signal: AbortSignal }): Promise<
    {
      title: string;
      trigger: string;
      lesson: string;
      outcome: "success" | "failure";
    }[]
  >;
}
export async function distill(
  distiller: Distiller,
  transcript: string,
  signal: AbortSignal,
) {
  const lessons = await distiller.extract({ transcript, signal });
  requireThat(
    lessons.length <= 3,
    Codes.limit,
    "Distillation must return at most three lessons",
  );
  return lessons;
}
