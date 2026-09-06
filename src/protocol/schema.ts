import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const channel = z.string().max(256);
export const allowance = z.strictObject({
  tokens: count,
  costMicros: count,
  turns: count,
});
export const usage = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  costMicros: count,
  source: z.enum(["reported", "reservation"]),
  costSource: z.enum(["reported", "reservation"]).optional(),
});
export const blobRef = z.strictObject({
  uri: z.string().max(512),
  sha256: digest,
  size: count,
  mediaType: z.string().max(128),
});
export const checkpoint = z.strictObject({
  baseCommit: sha,
  headCommit: sha,
  branch: z.string().max(256),
  bundle: blobRef,
  patch: blobRef,
  createdAt: count,
});
export const context = z.strictObject({
  revision: count,
  throughTurn: count,
  summary: z.string().max(24_000),
  decisions: z.array(z.string().max(2000)).max(32),
  activeFiles: z.array(z.string().max(512)).max(64),
  gitHead: sha.nullable(),
  prefixHash: digest,
});
export const signature = z.strictObject({
  publicKey: z.string().max(1024),
  signature: z.string().max(256),
});
export const manifest = z.strictObject({
  version: z.literal(1),
  repository: z.string().max(512),
  session: channel,
  baseCommit: sha,
  headCommit: sha,
  model: z.string().max(256),
  promptHash: digest,
  traceHash: digest,
  traceThroughSeq: count,
  checkpointDigest: digest,
});
const base = { channel, operationId: id };
const fenced = { ...base, epoch: count };
export const methods = {
  "_axp/dispatch": z.strictObject({ ...base, action: z.unknown() }),
  "_axp/register": z.strictObject({
    ...base,
    executorId: id,
    name: z.string().min(1).max(128),
    placement: z.enum(["satellite", "hosted"]),
    capabilities: z.array(z.string().max(128)).max(32),
    ttlMs: z.number().int().min(3000).max(300_000),
  }),
  "_axp/grant": z.strictObject({
    ...base,
    grantId: id,
    limit: allowance,
    enforcement: z.enum(["provider", "accounting"]),
  }),
  "_axp/revoke": z.strictObject({ ...base, grantId: id }),
  "_axp/claim": z.strictObject({
    ...base,
    executorId: id,
    grantId: id,
    leaseMs: z.number().int().min(3000).max(300_000),
    resumeEpoch: count.optional(),
  }),
  "_axp/renew": z.strictObject(fenced),
  "_axp/release": z.strictObject(fenced),
  "_axp/close": z.strictObject(base),
  "_axp/reserve": z.strictObject({ ...fenced, turnId: id, ceiling: allowance }),
  "_axp/settle": z.strictObject({
    ...fenced,
    turnId: id,
    usage: usage.nullable(),
    outcome: z.enum(["complete", "cancelled", "error"]),
    error: z.string().max(4096).optional(),
  }),
  "_axp/emit": z.strictObject({
    ...fenced,
    actions: z.array(z.unknown()).min(1).max(64),
  }),
  "_axp/checkpoint": z.strictObject({
    ...fenced,
    checkpoint,
    files: z.array(z.unknown()).max(2000),
  }),
  "_axp/compact": z.strictObject({
    ...base,
    expectedRevision: count,
    throughTurn: count,
    summary: z.string().max(24_000),
    decisions: z.array(z.string().max(2000)).max(32),
    activeFiles: z.array(z.string().max(512)).max(64),
  }),
  "_axp/acceptCompaction": z.strictObject({ ...base, proposalId: id }),
  "_axp/memoryPropose": z.strictObject({
    ...base,
    title: z.string().min(1).max(160),
    trigger: z.string().min(1).max(1000),
    lesson: z.string().min(1).max(4000),
    outcome: z.enum(["success", "failure"]),
    fromSeq: count,
    toSeq: count,
  }),
  "_axp/memoryReview": z.strictObject({
    ...base,
    memoryId: digest,
    revision: count,
    status: z.enum(["accepted", "retired"]),
  }),
  "_axp/memorySearch": z.strictObject({
    channel,
    query: z.string().max(4096),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  "_axp/review": z.strictObject({ ...base, manifest, contributor: signature }),
  "_axp/approveReview": z.strictObject({ ...base, signature }),
  "_axp/verify": z.strictObject({
    ...base,
    headCommit: sha,
    command: z.array(z.string().max(1024)).min(1).max(64),
    exitCode: z.number().int(),
    output: blobRef,
  }),
  "_axp/export": z.strictObject({ channel }),
  "_axp/context": z.strictObject({
    channel,
    maxChars: z.number().int().min(1024).max(200_000).default(64_000),
  }),
  "_axp/blobPut": z.strictObject({
    ...base,
    data: z.string().max(24_000_000),
    mediaType: z.string().max(128),
  }),
  "_axp/blobGet": z.strictObject({ channel, digest }),
} as const;
export type Method = keyof typeof methods;
export type Params<M extends Method> = z.infer<(typeof methods)[M]>;
export type InputParams<M extends Method> = z.input<(typeof methods)[M]>;
