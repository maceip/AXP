import {
  AhpErrorCodes,
  JsonRpcErrorCodes,
} from "@microsoft/agent-host-protocol";

export class ProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
export const Codes = {
  invalid: JsonRpcErrorCodes.InvalidParams,
  missing: AhpErrorCodes.NotFound,
  sessionMissing: AhpErrorCodes.SessionNotFound,
  alreadyExists: AhpErrorCodes.SessionAlreadyExists,
  busy: AhpErrorCodes.TurnInProgress,
  conflict: AhpErrorCodes.Conflict,
  version: AhpErrorCodes.UnsupportedProtocolVersion,
  forbidden: AhpErrorCodes.PermissionDenied,
  stale: -32040,
  budget: -32041,
  context: -32042,
  limit: -32043,
  method: JsonRpcErrorCodes.MethodNotFound,
  internal: JsonRpcErrorCodes.InternalError,
} as const;
export function requireThat(
  condition: unknown,
  code: number,
  message: string,
): asserts condition {
  if (!condition) throw new ProtocolError(code, message);
}
