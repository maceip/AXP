import {
  rootReducer,
  sessionReducer,
  chatReducer,
  changesetReducer,
} from "@microsoft/agent-host-protocol";
import type {
  ChatAction,
  ChatState,
  RootAction,
  RootState,
  SessionAction,
  SessionState,
  ChangesetAction,
  ChangesetState,
} from "@microsoft/agent-host-protocol";
import {
  exchangeReducer,
  memoryReducer,
  executorReducer,
} from "./protocol/reducer.js";
import type {
  Envelope,
  ExchangeAction,
  ExchangeState,
  MemoryState,
  ExecutorRegistry,
} from "./protocol/types.js";

export function reduceChannel(
  resource: string,
  state: unknown,
  action: Envelope["action"],
): unknown {
  if (resource === "ahp-root://")
    return rootReducer(state as RootState, action as RootAction);
  if (resource.startsWith("ahp-session:/"))
    return sessionReducer(state as SessionState, action as SessionAction);
  if (resource.startsWith("ahp-chat:/"))
    return chatReducer(state as ChatState, action as ChatAction);
  if (resource.startsWith("ahp-changeset:/"))
    return changesetReducer(state as ChangesetState, action as ChangesetAction);
  if (resource === "axp-executors://")
    return executorReducer(state as ExecutorRegistry, action as ExchangeAction);
  if (resource === "axp-memory://")
    return memoryReducer(state as MemoryState, action as ExchangeAction);
  return exchangeReducer(state as ExchangeState, action as ExchangeAction);
}
