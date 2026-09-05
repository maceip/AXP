import { ActionType } from "@microsoft/agent-host-protocol";
import type {
  ExchangeState,
  Principal,
  Review,
  Signature,
} from "./protocol/types.js";
import type { Params } from "./protocol/schema.js";
import type { Transaction } from "./store.js";
import type { Sessions } from "./sessions.js";
import { hashObject, verifyObject } from "./hash.js";
import { Codes, requireThat } from "./protocol/errors.js";
import { actionFrom } from "./validation.js";

export class Artifacts {
  constructor(readonly sessions: Sessions) {}
  checkpoint(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    params: Params<"_axp/checkpoint">,
  ): void {
    this.sessions.fenced(actor, state, params.epoch);
    this.sessions.checkBlob(state.resource, params.checkpoint.bundle);
    this.sessions.checkBlob(state.resource, params.checkpoint.patch);
    if (state.checkpoint)
      requireThat(
        params.checkpoint.baseCommit === state.checkpoint.baseCommit,
        Codes.conflict,
        "Checkpoint cannot change the Git base",
      );
    const action = actionFrom({
      type: ActionType.ChangesetContentChanged,
      files: params.files,
    });
    requireThat(
      action.type === ActionType.ChangesetContentChanged,
      Codes.invalid,
      "Expected changeset content",
    );
    for (const file of action.files ?? []) {
      for (const side of [file.edit.before, file.edit.after]) {
        if (!side) continue;
        requireThat(
          side.uri.startsWith(
            `axp-file:/${encodeURIComponent(state.resource)}/`,
          ),
          Codes.forbidden,
          "File identity must belong to this session",
        );
        requireThat(
          side.content,
          Codes.invalid,
          "Checkpoint files require stored content",
        );
        this.sessions.checkRefs(state.resource, side.content);
      }
    }
    tx.emit(state.session.replace("ahp-session:", "ahp-changeset:"), action);
    tx.emit(state.resource, {
      type: "_axp/checkpointChanged",
      checkpoint: { ...params.checkpoint, createdAt: this.sessions.now() },
    });
  }
  review(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    params: Params<"_axp/review">,
  ): Review {
    requireThat(
      state.lease?.owner === actor.id,
      Codes.forbidden,
      "Only the current executor can submit its artifact",
    );
    this.sessions.fenced(actor, state, state.epoch);
    requireThat(
      !state.reservation,
      Codes.conflict,
      "Finish the reserved turn before submitting review",
    );
    const manifest = params.manifest;
    requireThat(
      state.checkpoint &&
        manifest.repository === state.repository &&
        manifest.session === state.session &&
        manifest.baseCommit === state.checkpoint.baseCommit &&
        manifest.headCommit === state.checkpoint.headCommit,
      Codes.conflict,
      "Manifest does not identify the current checkpoint",
    );
    requireThat(
      manifest.checkpointDigest === hashObject(state.checkpoint),
      Codes.invalid,
      "Checkpoint digest does not match",
    );
    requireThat(
      manifest.traceThroughSeq <= this.sessions.store.seq,
      Codes.invalid,
      "Trace cursor is in the future",
    );
    const trace = this.sessions.store.events(
      [state.chat, state.resource, state.session],
      0,
      manifest.traceThroughSeq,
    );
    const checkpointEvent = trace.findLast(
      (event) =>
        event.channel === state.resource &&
        event.action.type === "_axp/checkpointChanged",
    );
    requireThat(
      checkpointEvent &&
        "checkpoint" in checkpointEvent.action &&
        hashObject(checkpointEvent.action.checkpoint) ===
          manifest.checkpointDigest,
      Codes.invalid,
      "Trace must include the current checkpoint",
    );
    requireThat(
      manifest.traceHash === hashObject(trace),
      Codes.invalid,
      "Trace digest does not match",
    );
    requireThat(
      verifyObject(manifest, params.contributor),
      Codes.invalid,
      "Invalid contributor signature",
    );
    this.sessions.store.bindKey(actor.id, params.contributor.publicKey);
    const review: Review = {
      manifest,
      contributor: params.contributor,
      maintainer: null,
    };
    tx.emit(state.resource, { type: "_axp/reviewChanged", review });
    return review;
  }
  approve(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    signature: Signature,
  ): Review {
    this.sessions.maintain(actor);
    requireThat(
      state.review &&
        state.checkpoint?.headCommit === state.review.manifest.headCommit,
      Codes.conflict,
      "No current artifact review",
    );
    requireThat(
      actor.id !== state.lease?.owner,
      Codes.forbidden,
      "Executor cannot approve its own artifact",
    );
    requireThat(
      signature.publicKey !== state.review.contributor.publicKey &&
        verifyObject(state.review.manifest, signature),
      Codes.invalid,
      "Invalid independent maintainer signature",
    );
    this.sessions.store.bindKey(actor.id, signature.publicKey);
    const review = { ...state.review, maintainer: signature };
    tx.emit(state.resource, { type: "_axp/reviewChanged", review });
    return review;
  }
  verify(
    tx: Transaction,
    actor: Principal,
    state: ExchangeState,
    params: Params<"_axp/verify">,
  ): void {
    requireThat(
      actor.role === "verifier",
      Codes.forbidden,
      "A separate verifier identity is required",
    );
    requireThat(
      state.checkpoint?.headCommit === params.headCommit,
      Codes.conflict,
      "Verification does not name the current checkpoint",
    );
    this.sessions.checkBlob(state.resource, params.output);
    tx.emit(state.resource, {
      type: "_axp/verificationChanged",
      verification: {
        headCommit: params.headCommit,
        verifier: actor.id,
        command: params.command,
        exitCode: params.exitCode,
        output: params.output,
        verifiedAt: this.sessions.now(),
      },
    });
  }
}
