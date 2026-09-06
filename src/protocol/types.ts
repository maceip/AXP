import type {
  ActionEnvelope,
  ChatState,
  SessionState,
  StateAction,
} from "@microsoft/agent-host-protocol";

export const AXP_VERSION = "0.2.0";
export const CAPABILITY = "org.axp.exchange";
export const ROOT = "ahp-root://";

export interface Principal {
  id: string;
  role: "maintainer" | "contributor" | "observer" | "verifier";
  /** Explicit host-issued read/participation scope, never taken from initialize. */
  sessions: "*" | string[];
}

export interface Lease {
  owner: string;
  executorId: string;
  epoch: number;
  expiresAt: number;
  heartbeatMs: number;
  grantId: string;
}

/** Integer USD millionths avoid floating-point accounting. Tokens include cache reads. */
export interface Allowance {
  tokens: number;
  costMicros: number;
  turns: number;
}
export interface Grant {
  id: string;
  owner: string;
  limit: Allowance;
  spent: Allowance;
  revoked: boolean;
  enforcement: "provider" | "accounting";
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  source: "reported" | "reservation";
  /** USD provenance may differ from token provenance. */
  costSource?: "reported" | "reservation" | undefined;
}
export interface Reservation {
  turnId: string;
  grantId: string;
  epoch: number;
  ceiling: Allowance;
  startedAt: number;
}

export interface BlobRef {
  uri: string;
  sha256: string;
  size: number;
  mediaType: string;
}
export interface Checkpoint {
  baseCommit: string;
  headCommit: string;
  branch: string;
  bundle: BlobRef;
  patch: BlobRef;
  createdAt: number;
}
export interface CacheIdentity {
  repository: string;
  baseCommit: string;
  model: string;
  tokenizer: string;
  template: string;
  runtime: string;
  format: string;
}
export interface Context {
  revision: number;
  throughTurn: number;
  summary: string;
  decisions: string[];
  activeFiles: string[];
  gitHead: string | null;
  prefixHash: string;
}
export interface CompactionProposal {
  id: string;
  author: string;
  expectedRevision: number;
  context: Context;
  evidence: { fromSeq: number; toSeq: number };
}
export interface Memory {
  id: string;
  revision: number;
  scope: string;
  title: string;
  trigger: string;
  lesson: string;
  outcome: "success" | "failure";
  evidence: {
    session: string;
    fromSeq: number;
    toSeq: number;
    gitHead: string | null;
  }[];
  status: "proposed" | "accepted" | "retired";
  author: string;
}
export interface Signature {
  publicKey: string;
  signature: string;
}
export interface Manifest {
  version: 1;
  repository: string;
  session: string;
  baseCommit: string;
  headCommit: string;
  model: string;
  promptHash: string;
  traceHash: string;
  traceThroughSeq: number;
  checkpointDigest: string;
}
export interface Review {
  manifest: Manifest;
  contributor: Signature;
  maintainer: Signature | null;
}
export interface Verification {
  headCommit: string;
  verifier: string;
  command: string[];
  exitCode: number;
  output: BlobRef;
  verifiedAt: number;
}
export interface ExchangeState {
  resource: string;
  session: string;
  chat: string;
  repository: string;
  task: string;
  status: "open" | "orphaned" | "closed";
  epoch: number;
  lease: Lease | null;
  grants: Record<string, Grant>;
  reservation: Reservation | null;
  usage: { turnId: string; grantId: string; usage: Usage }[];
  checkpoint: Checkpoint | null;
  context: Context;
  compaction: CompactionProposal | null;
  review: Review | null;
  verification: Verification | null;
  /** Optional for persisted pre-workspace sessions; comments are also retained in the audit. */
  discussion?: DiscussionComment[];
}

export interface DiscussionComment {
  id: string;
  author: string;
  body: string;
  createdAt: number;
  checkpoint: string | null;
  path: string | null;
}
export interface MemoryState {
  resource: string;
  entries: Record<string, Memory>;
}

export type ExchangeAction =
  | { type: "_axp/commentAdded"; comment: DiscussionComment }
  | {
      type: "_axp/leaseChanged";
      lease: Lease | null;
      epoch: number;
      status: ExchangeState["status"];
    }
  | { type: "_axp/grantChanged"; grant: Grant }
  | { type: "_axp/reserved"; reservation: Reservation }
  | { type: "_axp/settled"; turnId: string; grant: Grant; usage: Usage }
  | { type: "_axp/checkpointChanged"; checkpoint: Checkpoint }
  | { type: "_axp/compactionProposed"; proposal: CompactionProposal }
  | { type: "_axp/contextChanged"; context: Context }
  | { type: "_axp/reviewChanged"; review: Review }
  | { type: "_axp/verificationChanged"; verification: Verification }
  | { type: "_axp/memoryChanged"; memory: Memory }
  | ExecutorAction;

export type Envelope = Omit<ActionEnvelope, "action"> & {
  action: StateAction | ExchangeAction;
};
export interface ChannelSnapshot {
  resource: string;
  state: unknown;
  fromSeq: number;
}
export interface SessionView {
  exchange: ExchangeState;
  chat: ChatState;
  session: SessionState;
}

export function channels(id: string) {
  return {
    session: `ahp-session:/${id}`,
    chat: `ahp-chat:/${id}`,
    exchange: `axp-session:/${id}`,
    changeset: `ahp-changeset:/${id}`,
  };
}
export const MEMORY = "axp-memory://";
export const EXECUTORS = "axp-executors://";
export interface ExecutorInfo {
  id: string;
  owner: string;
  name: string;
  placement: "satellite" | "hosted";
  capabilities: string[];
  expiresAt: number;
  online: boolean;
}
export interface ExecutorRegistry {
  resource: string;
  entries: Record<string, ExecutorInfo>;
}
export type ExecutorAction = {
  type: "_axp/executorChanged";
  executor: ExecutorInfo;
};
