import type { AxpClient } from "./client.js";
import type { ExchangeState, Manifest } from "./protocol/types.js";
import { hashObject } from "./hash.js";
import { Codes, requireThat } from "./protocol/errors.js";

/** Shared CLI/browser manifest construction; the host verifies the checkpoint and trace. */
export async function reviewManifest(
  client: AxpClient,
  state: ExchangeState,
  model: string,
): Promise<Manifest> {
  requireThat(state.checkpoint, Codes.conflict, "No checkpoint to submit");
  const archive = await client.call("_axp/export", { channel: state.resource });
  const context = await client.call("_axp/context", {
    channel: state.resource,
    maxChars: 200_000,
  });
  return {
    version: 1,
    repository: state.repository,
    session: state.session,
    baseCommit: state.checkpoint.baseCommit,
    headCommit: state.checkpoint.headCommit,
    model,
    promptHash: hashObject(context.text),
    traceHash: hashObject(
      archive.actions.filter((event) =>
        [state.resource, state.session, state.chat].includes(event.channel),
      ),
    ),
    traceThroughSeq: archive.serverSeq,
    checkpointDigest: hashObject(state.checkpoint),
  };
}
