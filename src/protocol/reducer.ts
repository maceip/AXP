import type {
  ExchangeAction,
  ExchangeState,
  MemoryState,
  ExecutorRegistry,
} from "./types.js";

export function executorReducer(
  state: ExecutorRegistry,
  action: ExchangeAction,
): ExecutorRegistry {
  if (action.type !== "_axp/executorChanged") return state;
  return {
    ...state,
    entries: { ...state.entries, [action.executor.id]: action.executor },
  };
}

/** Authorization and transition validity belong to the host, never a client reducer. */
export function exchangeReducer(
  state: ExchangeState,
  action: ExchangeAction,
): ExchangeState {
  switch (action.type) {
    case "_axp/commentAdded":
      return {
        ...state,
        discussion: [...(state.discussion ?? []), action.comment],
      };
    case "_axp/leaseChanged":
      return {
        ...state,
        lease: action.lease,
        epoch: action.epoch,
        status: action.status,
      };
    case "_axp/grantChanged":
      return {
        ...state,
        grants: { ...state.grants, [action.grant.id]: action.grant },
      };
    case "_axp/reserved":
      return { ...state, reservation: action.reservation };
    case "_axp/settled":
      return {
        ...state,
        reservation: null,
        grants: { ...state.grants, [action.grant.id]: action.grant },
        usage: [
          ...state.usage,
          {
            turnId: action.turnId,
            grantId: action.grant.id,
            usage: action.usage,
          },
        ],
      };
    case "_axp/checkpointChanged":
      return {
        ...state,
        checkpoint: action.checkpoint,
        review: null,
        verification: null,
      };
    case "_axp/compactionProposed":
      return { ...state, compaction: action.proposal };
    case "_axp/contextChanged":
      return { ...state, context: action.context, compaction: null };
    case "_axp/reviewChanged":
      return { ...state, review: action.review };
    case "_axp/verificationChanged":
      return { ...state, verification: action.verification };
    default:
      return state;
  }
}

export function memoryReducer(
  state: MemoryState,
  action: ExchangeAction,
): MemoryState {
  if (action.type !== "_axp/memoryChanged") return state;
  return {
    ...state,
    entries: { ...state.entries, [action.memory.id]: action.memory },
  };
}
