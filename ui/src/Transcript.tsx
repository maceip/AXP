import type { ChatState } from "@microsoft/agent-host-protocol";
import { Terminal, Users } from "lucide-react";
import type {
  ContributionDetail,
  WorkspaceView,
} from "../../src/workspace-contract.js";
import { Empty, Prose } from "./components.js";
import { StoredContent } from "./StoredContent.js";

export function Transcript({
  detail,
  workspace,
  canAct,
  answer,
}: {
  detail: ContributionDetail;
  workspace: WorkspaceView;
  canAct: boolean;
  answer: (turnId: string, toolId: string, optionId: string) => void;
}) {
  const { contribution, chat } = detail;
  const { exchange } = contribution;
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
  return (
    <div className="transcript">
      {detail.totalTurns > chat.turns.length && (
        <p className="notice">
          Showing the latest {chat.turns.length} of {detail.totalTurns}{" "}
          completed turns. The complete history is available with axp export.
        </p>
      )}
      {turns.length === 0 && (
        <Empty title="Every contribution starts somewhere">
          Share the context, describe a useful next step, and give a
          contributor's agent a place to begin.
        </Empty>
      )}
      {turns.map((turn) => (
        <article className="turn" key={turn.id}>
          <div className="turn-prompt">
            <div className="message-author">
              <span className="message-icon">
                <Users size={14} />
              </span>
              <strong>Maintainer</strong>
              {turn.message._meta?.["org.axp.aamp"] ? (
                <span className="tiny-tag">via AAMP</span>
              ) : null}
              <time>
                {turn.startedAt
                  ? new Date(turn.startedAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : ""}
              </time>
            </div>
            <Prose text={turn.message.text} />
          </div>
          <div className="turn-response">
            <div className="message-author">
              <span className="agent-symbol">✳</span>
              <strong>
                {turn.id === chat.activeTurn?.id
                  ? (workspace.executors.find(
                      (executor) => executor.id === exchange.lease?.executorId,
                    )?.name ?? "Agent")
                  : "Agent"}
              </strong>
              <span className="muted">
                {turn.id === chat.activeTurn?.id
                  ? "Working"
                  : "state" in turn
                    ? String(turn.state)
                    : ""}
              </span>
            </div>
            {turn.responseParts.map((part, index) =>
              part.kind === "markdown" ? (
                <Prose key={index} text={part.content} />
              ) : part.kind === "toolCall" ? (
                <Tool
                  key={index}
                  part={part}
                  session={contribution.id}
                  turnId={turn.id}
                  active={turn.id === chat.activeTurn?.id}
                  canAct={canAct}
                  answer={(toolId, optionId) =>
                    answer(turn.id, toolId, optionId)
                  }
                />
              ) : part.kind === "error" ? (
                <div className="notice error" role="alert" key={index}>
                  {part.error.message}
                </div>
              ) : part.kind === "contentRef" ? (
                <StoredContent
                  key={index}
                  session={contribution.id}
                  uri={part.uri}
                  label="Agent attachment"
                />
              ) : part.kind === "reasoning" ? (
                <details key={index} className="agent-context">
                  <summary>Agent reasoning supplied by the provider</summary>
                  <Prose text={part.content} />
                </details>
              ) : (
                <p className="muted" key={index}>
                  Additional agent context is retained in the session export.
                </p>
              ),
            )}
            {!turn.responseParts.length && turn.id === chat.activeTurn?.id && (
              <div className="thinking">
                <span />
                <span />
                <span />
                <span>
                  {exchange.lease
                    ? "Agent is working"
                    : "Waiting for a parked agent"}
                </span>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function Tool({
  part,
  session,
  turnId,
  active,
  canAct,
  answer,
}: {
  part: Extract<
    ChatState["turns"][number]["responseParts"][number],
    { kind: "toolCall" }
  >;
  session: string;
  turnId: string;
  active: boolean;
  canAct: boolean;
  answer: (toolId: string, optionId: string) => void;
}) {
  const tool = part.toolCall;
  return (
    <div
      className={`tool-call ${tool.status === "pending-confirmation" ? "pending" : ""}`}
    >
      <details open={tool.status === "pending-confirmation"}>
        <summary>
          <Terminal size={15} />
          <strong>{tool.displayName}</strong>
          <span>{tool.status.replaceAll("-", " ")}</span>
        </summary>
        <div className="tool-body">
          {"toolInput" in tool &&
          tool.toolInput &&
          typeof tool.toolInput !== "string" ? (
            <StoredContent
              session={session}
              uri={tool.toolInput.uri}
              label="Tool input"
            />
          ) : (
            <pre>
              {"toolInput" in tool && tool.toolInput
                ? typeof tool.toolInput === "string"
                  ? tool.toolInput
                  : JSON.stringify(tool.toolInput, null, 2)
                : "invocationMessage" in tool && tool.invocationMessage
                  ? typeof tool.invocationMessage === "string"
                    ? tool.invocationMessage
                    : tool.invocationMessage.markdown
                  : "The agent has not supplied tool input."}
            </pre>
          )}
          {"content" in tool && tool.content && (
            <div className="tool-result">
              <strong>
                {!("success" in tool) || tool.success
                  ? "Tool result"
                  : "Tool failed"}
              </strong>
              {tool.content.map((content, index) =>
                content.type === "text" ? (
                  <pre key={index}>{content.text}</pre>
                ) : "uri" in content ? (
                  <StoredContent
                    key={index}
                    session={session}
                    uri={content.uri}
                    label="Tool output"
                  />
                ) : (
                  <p key={index}>
                    Additional result is available in the session export.
                  </p>
                ),
              )}
            </div>
          )}
        </div>
      </details>
      {tool.status === "pending-confirmation" && active && (
        <div className="permission-options">
          <span>
            {canAct ? "Your permission is needed" : "Waiting for a maintainer"}
          </span>
          {tool.options?.map((option) => (
            <button
              key={`${turnId}:${option.id}`}
              disabled={!canAct}
              className={`button small ${option.kind === "approve" ? "primary" : ""}`}
              onClick={() => answer(tool.toolCallId, option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
