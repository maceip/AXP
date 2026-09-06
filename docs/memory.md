# Context, memory and local caches

The immutable observed history, model working context and repository lessons
have separate lifecycles. AXP retains provider-visible output; it cannot
export hidden model reasoning or a provider's private system prompt.

## Compaction

`_axp/compact` proposes a revision at a quiescent turn boundary. It identifies
the previous revision, number of covered completed turns, summary, decisions
and active files. An uploaded Git checkpoint is required. Maintainer-only
`_axp/acceptCompaction` rechecks both revision and checkpoint.

Acceptance replaces working context and never deletes raw turns. The satellite
starts a new ACP session after a context revision and hydrates it with the
compacted base and newer turns. Otherwise it reuses the ACP session, sending
only the next message. Timestamps and heartbeat data stay outside the prompt.
Oversized portable context produces a compaction-required error, not truncation.

Applications or contributors supply summaries; no unbudgeted model runs
automatically in the host. CLI `rpc` accepts the same schemas as the SDK:

```ts
const proposal = await contributor.call("_axp/compact", {
  channel: "axp-session:/parser-fix",
  expectedRevision: 0,
  throughTurn: 3,
  summary: "Reproduced the overflow. Preserve the public parser return type.",
  decisions: ["Use checked arithmetic"],
  activeFiles: ["src/parser.ts"],
});
await maintainer.call("_axp/acceptCompaction", {
  channel: "axp-session:/parser-fix",
  proposalId: proposal.id,
});
```

## Repository lessons

[ReasoningBank](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)
informs success/failure lessons. Google's
[Memory Bank](https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank/generate-memories)
informs scoped extraction, consolidation and retrieval. AXP does not claim
the papers' benchmark gains.

Lessons include title, applicability trigger, content, outcome and source
action ranges. Extraction runs outside the live turn. `MtplxDistiller` is a
bounded implementation; applications can supply any `Distiller`. Extracted
items become `_axp/memoryPropose` proposals. Maintainers accept or retire them
with `_axp/memoryReview`, using revision checks.

Exact duplicates consolidate evidence under a deterministic ID. Contradictory
wording remains a separate proposal. New evidence does not revive retired
advice. Search returns accepted entries only, uses lexical relevance, checks
every evidence scope and reports total matches alongside the bounded result.
Recalled advice is evidence, not security policy. Private contributor memory
stays local; AXP never imports personal memory stores automatically.

## MTPLX / SessionBank

`MtplxClient` targets `/v1/chat/completions`, inspected at MTPLX commit
`406b5f768e984e036d16aca1edaddaa29fe8519e`. It sends a stable
`x-mtplx-session-id` derived from contributor, session, context revision and
cache identity, and requests `x-mtplx-restore-mode: clone`. Identity includes
repository, Git base, model, tokenizer, template, runtime and cache format.
Compaction and incompatible identities get different namespaces. Explicit
bypass uses `x-mtplx-cache-mode: bypass`.

Cache hits come only from returned `usage.prompt_tokens_details.cached_tokens`.
Missing telemetry is unreported. The `SessionBank` interface supports local
opaque handles and compatibility-checked lookup. No claim is made that KV
tensors move between machines, quantizations or models merely because prompt
text hashes agree. Text remains the portable resumption mechanism.

HTTP and distillation contracts are tested with a real local HTTP server.
Actual MTPLX/Qwen hardware inference and KV performance require a configured
model runtime; those tests assert no inference speedup.

Portable resume context includes completed tool results alongside assistant
text. Provider reasoning stays in the audit rather than the portable prompt;
stored outputs remain explicit content references. Context exceeding its bound
requires explicit compaction rather than silent truncation.
