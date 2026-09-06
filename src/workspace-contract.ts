import type { ChatState } from "@microsoft/agent-host-protocol";
import type {
  ExchangeState,
  ExecutorInfo,
  Principal,
} from "./protocol/types.js";

/** Browser read models contain host state, never transport credentials or local paths. */
export interface Contribution {
  id: string;
  title: string;
  exchange: ExchangeState;
  activity:
    | "working"
    | "permission"
    | "review"
    | "ready"
    | "waiting"
    | "parked"
    | "failed"
    | "archived";
  preview: string;
  turnCount: number;
}
export interface WorkspaceView {
  principal: { id: string; role: Principal["role"] };
  repository: string;
  contributions: Contribution[];
  total: number;
  matched: number;
  offset: number;
  executors: ExecutorInfo[];
  canSign: boolean;
  receivedAt: number;
}
export interface ContributionDetail {
  contribution: Contribution;
  chat: ChatState;
  totalTurns: number;
}
export interface WorkspaceCommand {
  operationId: string;
  startedAt: string;
  session: string;
  action:
    | { kind: "create"; title: string; task: string }
    | { kind: "prompt"; text: string; mode: "start" | "queue" | "steer" }
    | { kind: "cancel"; turnId: string }
    | { kind: "permission"; turnId: string; toolId: string; optionId: string }
    | {
        kind: "comment";
        body: string;
        checkpoint: string | null;
        path: string | null;
      }
    | { kind: "accept"; checkpoint: string; manifestDigest: string }
    | { kind: "submit"; checkpoint: string; model: string };
}
