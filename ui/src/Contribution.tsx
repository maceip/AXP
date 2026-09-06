import { lazy, Suspense, useCallback, useState } from "react";
import type { ChatState } from "@microsoft/agent-host-protocol";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  GitBranch,
  GitCommitHorizontal,
  MessageCircle,
  ShieldCheck,
  Square,
  Terminal,
  Users,
  X,
} from "lucide-react";
import type {
  ContributionDetail,
  WorkspaceView,
} from "../../src/workspace-contract.js";
import {
  Avatar,
  Contributors,
  Dialog,
  Empty,
  Loading,
  Prose,
  Status,
  relativeTime,
} from "./components.js";
import { TabGroup } from "./vendor/huabu/TabGroup.js";
import { useCommand } from "./api.js";

const DiffPanel = lazy(() => import("./DiffPanel.js"));

export function ContributionPage({
  detail,
  workspace,
  back,
  refresh,
  offline,
}: {
  detail: ContributionDetail;
  workspace: WorkspaceView;
  back: () => void;
  refresh: () => void;
  offline: boolean;
}) {
  const { contribution: contribution, chat } = detail;
  const { exchange } = contribution;
  const [tab, setTab] = useState<"conversation" | "changes" | "discussion">(
    exchange.checkpoint && !chat.activeTurn ? "changes" : "conversation",
  );
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [comment, setComment] = useState("");
  const [anchor, setAnchor] = useState<{
    path: string;
    checkpoint: string;
  } | null>(null);
  const [loadedReview, setLoadedReview] = useState<{
    key: string;
    digest: string | null;
  } | null>(null);
  const [approve, setApprove] = useState<{
    checkpoint: string;
    manifestDigest: string;
  } | null>(null);
  const [submit, setSubmit] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const command = useCommand(refresh);
  const maintainer = workspace.principal.role === "maintainer";
  const writable = workspace.principal.role !== "observer";
  const disabled = offline || command.busy;
  const checkpoint = exchange.checkpoint;
  const reviewKey = `${checkpoint?.headCommit ?? ""}:${exchange.review?.contributor.signature ?? ""}`;
  const manifest = loadedReview?.key === reviewKey ? loadedReview.digest : null;
  const ready = useCallback(
    (value: string | null) =>
      setLoadedReview({ key: reviewKey, digest: value }),
    [reviewKey],
  );
  const discuss = (path: string) => {
    if (checkpoint) setAnchor({ path, checkpoint: checkpoint.headCommit });
    setTab("discussion");
  };
  const turns = [...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])];
  return (
    <section className="contribution-page">
      <button className="back-button" onClick={back}>
        <ArrowLeft size={15} /> All contributions
      </button>
      <div className="contribution-heading">
        <div>
          <div className="eyebrow">{exchange.task}</div>
          <h1>{contribution.title}</h1>
          <div className="contribution-byline">
            <Contributors contribution={contribution} />
            <span className="divider-dot">·</span>
            <span>
              {contribution.turnCount}{" "}
              {contribution.turnCount === 1 ? "turn" : "turns"} together
            </span>
          </div>
        </div>
        <Status activity={contribution.activity} />
      </div>
      <div className="contribution-layout">
        <div className="contribution-content">
          <TabGroup
            label="Contribution views"
            value={tab}
            onChange={setTab}
            options={[
              { value: "conversation", label: "Agent session" },
              { value: "changes", label: "Changes" },
              {
                value: "discussion",
                label: `Discussion${exchange.discussion?.length ? ` · ${exchange.discussion.length}` : ""}`,
              },
            ]}
          />
          {command.error && (
            <div className="notice error" role="alert">
              {command.error}
            </div>
          )}
          <div
            id="contribution-panel"
            className="tab-content"
            role="tabpanel"
            aria-label={
              tab === "conversation"
                ? "Agent session"
                : tab === "changes"
                  ? "Changes"
                  : "Discussion"
            }
          >
            {tab === "conversation" && (
              <>
                <div className="transcript">
                  {detail.totalTurns > chat.turns.length && (
                    <p className="notice">
                      Showing the latest {chat.turns.length} of{" "}
                      {detail.totalTurns} completed turns. The complete history
                      is available with axp export.
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
                              ? new Date(turn.startedAt).toLocaleTimeString(
                                  [],
                                  { hour: "numeric", minute: "2-digit" },
                                )
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
                              ? (exchange.lease?.executorId ?? "Agent")
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
                              turnId={turn.id}
                              active={turn.id === chat.activeTurn?.id}
                              canAct={maintainer && !disabled}
                              answer={(toolId, optionId) => {
                                void command.send(contribution.id, {
                                  kind: "permission",
                                  turnId: turn.id,
                                  toolId,
                                  optionId,
                                });
                              }}
                            />
                          ) : (
                            <p className="muted" key={index}>
                              Additional agent context is retained in the
                              session export.
                            </p>
                          ),
                        )}
                        {!turn.responseParts.length &&
                          turn.id === chat.activeTurn?.id && (
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
                {maintainer && exchange.status !== "closed" ? (
                  <form
                    className="composer"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void command
                        .send(contribution.id, {
                          kind: "prompt",
                          text: prompt,
                          mode: chat.activeTurn ? mode : "start",
                        })
                        .then((sent) => {
                          if (sent) setPrompt("");
                        });
                    }}
                  >
                    <label className="sr-only" htmlFor="agent-prompt">
                      Message the agent
                    </label>
                    <textarea
                      id="agent-prompt"
                      value={prompt}
                      onChange={(event) => setPrompt(event.target.value)}
                      maxLength={24_000}
                      placeholder={
                        chat.activeTurn
                          ? "Add guidance for the next step…"
                          : "What should we work on next?"
                      }
                      rows={3}
                      disabled={disabled}
                    />
                    <div className="composer-footer">
                      <span>
                        <span className="agent-symbol">✳</span>
                        {chat.activeTurn ? (
                          <select
                            aria-label="How to send guidance"
                            value={mode}
                            onChange={(event) =>
                              setMode(event.target.value as "queue" | "steer")
                            }
                          >
                            <option value="queue">Queue after this turn</option>
                            <option value="steer">
                              Interrupt and continue
                            </option>
                          </select>
                        ) : exchange.lease ? (
                          "Your agent is connected"
                        ) : (
                          "An agent can join when ready"
                        )}
                      </span>
                      <div className="toolbar-actions">
                        {chat.activeTurn && (
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Stop this turn"
                            disabled={disabled}
                            onClick={() => {
                              void command.send(contribution.id, {
                                kind: "cancel",
                                turnId: chat.activeTurn!.id,
                              });
                            }}
                          >
                            <Square size={14} />
                          </button>
                        )}
                        <button
                          className="send-button"
                          aria-label="Send prompt"
                          disabled={disabled || !prompt.trim()}
                        >
                          <ArrowUp size={18} />
                        </button>
                      </div>
                    </div>
                  </form>
                ) : (
                  <p className="read-only-note">
                    {exchange.status === "closed"
                      ? "This session is archived. Its work and discussion remain here."
                      : "Maintainers guide the agent. You can participate in the discussion."}
                  </p>
                )}
                {!!chat.queuedMessages?.length && (
                  <div className="notice">
                    {chat.queuedMessages.length} message
                    {chat.queuedMessages.length > 1 ? "s" : ""} queued for the
                    agent.
                  </div>
                )}
              </>
            )}
            {tab === "changes" &&
              (checkpoint ? (
                <Suspense
                  fallback={<Loading>Opening the code review…</Loading>}
                >
                  <DiffPanel
                    key={
                      checkpoint.headCommit +
                      (exchange.review?.contributor.signature ?? "")
                    }
                    session={contribution.id}
                    checkpoint={checkpoint.headCommit}
                    discuss={discuss}
                    ready={ready}
                  />
                </Suspense>
              ) : (
                <Empty title="The next checkpoint will appear here">
                  As the agent makes progress, its exact Git changes become a
                  shared place to review and discuss.
                </Empty>
              ))}
            {tab === "discussion" && (
              <div className="discussion">
                <div className="discussion-intro">
                  <MessageCircle size={19} />
                  <div>
                    <h3>Leave context for the next person.</h3>
                    <p>
                      Decisions, questions, and a little appreciation stay with
                      the contribution.
                    </p>
                  </div>
                </div>
                {(exchange.discussion ?? []).map((item) => (
                  <article
                    className="comment"
                    key={`${item.author}:${item.id}`}
                  >
                    <Avatar name={item.author} />
                    <div>
                      <div className="message-author">
                        <strong>{item.author}</strong>
                        <time title={new Date(item.createdAt).toLocaleString()}>
                          {relativeTime(item.createdAt)}
                        </time>
                      </div>
                      {item.checkpoint && (
                        <div className="comment-anchor">
                          <GitCommitHorizontal size={13} />
                          {item.checkpoint.slice(0, 7)}
                          {item.path && (
                            <>
                              {" "}
                              <ChevronRight size={12} />
                              {item.path}
                            </>
                          )}
                        </div>
                      )}
                      <Prose text={item.body} />
                    </div>
                  </article>
                ))}
                {writable && (
                  <form
                    className="comment-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void command
                        .send(contribution.id, {
                          kind: "comment",
                          body: comment,
                          checkpoint: anchor?.checkpoint ?? null,
                          path: anchor?.path ?? null,
                        })
                        .then((sent) => {
                          if (sent) {
                            setComment("");
                            setAnchor(null);
                          }
                        });
                    }}
                  >
                    {anchor && (
                      <div className="comment-anchor">
                        <GitCommitHorizontal size={13} />
                        {anchor.checkpoint.slice(0, 7)} · {anchor.path}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Remove file reference"
                          onClick={() => setAnchor(null)}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    )}
                    <label htmlFor="discussion-comment">
                      Join the discussion
                    </label>
                    <textarea
                      id="discussion-comment"
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Share a thought, ask a question, or help someone pick up where you left off…"
                      rows={4}
                      maxLength={8000}
                      disabled={disabled}
                    />
                    <div className="composer-footer">
                      <span>Posting as {workspace.principal.id}</span>
                      <button
                        className="button primary"
                        disabled={disabled || !comment.trim()}
                      >
                        Post comment <ArrowUp size={15} />
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
        <aside className="contribution-aside">
          <section className="aside-section">
            <h3>The contribution</h3>
            <div className="metadata-row">
              <GitBranch size={15} />
              <div>
                <span>Working branch</span>
                <code>{checkpoint?.branch ?? "No checkpoint yet"}</code>
              </div>
            </div>
            {checkpoint && (
              <div className="metadata-row">
                <GitCommitHorizontal size={15} />
                <div>
                  <span>Current checkpoint</span>
                  <code title={checkpoint.headCommit}>
                    {checkpoint.headCommit.slice(0, 12)}
                  </code>
                </div>
              </div>
            )}
            <div className="metadata-row">
              <Users size={15} />
              <div>
                <span>Agent contributed by</span>
                <strong>
                  {exchange.lease?.owner ?? "Open for a contributor"}
                </strong>
              </div>
            </div>
          </section>
          <section className="aside-section">
            <h3>From work to confidence</h3>
            <Evidence done={!!checkpoint} text="Checkpoint shared" />
            <Evidence done={!!exchange.review} text="Contributor signed" />
            <Evidence
              done={!!exchange.review?.maintainer}
              text="Maintainer approved"
            />
            <Evidence
              done={exchange.verification?.exitCode === 0}
              text={
                exchange.verification
                  ? exchange.verification.exitCode === 0
                    ? "Independent checks passed"
                    : "Independent checks failed"
                  : "Independent checks pending"
              }
            />
            {exchange.verification && (
              <div className="verification-detail">
                <code>{exchange.verification.command.join(" ")}</code>
                <p>
                  Verified by {exchange.verification.verifier} at{" "}
                  {exchange.verification.headCommit.slice(0, 7)}
                </p>
              </div>
            )}
            {maintainer && exchange.review && !exchange.review.maintainer && (
              <>
                <button
                  className="button primary full"
                  disabled={
                    disabled ||
                    !workspace.canSign ||
                    !manifest ||
                    tab !== "changes"
                  }
                  onClick={() => {
                    setReviewed(false);
                    setApprove({
                      checkpoint: checkpoint!.headCommit,
                      manifestDigest: manifest!,
                    });
                  }}
                >
                  <ShieldCheck size={15} /> Approve artifact
                </button>
                <p className="aside-hint">
                  {!workspace.canSign
                    ? "Start axp ui with --key to enable your signing identity."
                    : tab !== "changes"
                      ? "Open Changes to inspect the artifact before approving."
                      : "Approval signs this exact checkpoint. Publishing is a separate step."}
                </p>
              </>
            )}
            {checkpoint &&
              exchange.lease?.owner === workspace.principal.id &&
              !exchange.review && (
                <>
                  <button
                    className="button primary full"
                    disabled={
                      disabled ||
                      !workspace.canSign ||
                      !!chat.activeTurn ||
                      tab !== "changes"
                    }
                    onClick={() => setSubmit(checkpoint!.headCommit)}
                  >
                    Submit for review <ArrowUp size={15} />
                  </button>
                  <p className="aside-hint">
                    {!workspace.canSign
                      ? "Start axp ui with --key to sign your contribution."
                      : "Inspect Changes, then sign your checkpoint for maintainer review."}
                  </p>
                </>
              )}
          </section>
          <section className="aside-section join-agent">
            <span className="agent-symbol">✳</span>
            <h3>Bring your agent.</h3>
            <p>Your compute, a shared contribution.</p>
            <code>
              axp park {contribution.id} --profile .axp/contributor.json
              --native -- YOUR_ACP_AGENT
            </code>
            <p className="aside-hint">
              Run from your checkout. Your local tools use your user
              permissions.
            </p>
          </section>
        </aside>
      </div>
      {submit && (
        <Dialog title="Submit your contribution" close={() => setSubmit(null)}>
          <form
            className="dialog-body"
            onSubmit={(event) => {
              event.preventDefault();
              void command
                .send(contribution.id, {
                  kind: "submit",
                  checkpoint: submit,
                  model,
                })
                .then((sent) => {
                  if (sent) setSubmit(null);
                });
            }}
          >
            <p>
              Sign this checkpoint and its shared history so a maintainer can
              review the exact artifact.
            </p>
            <code className="commit-block">{submit}</code>
            <label htmlFor="artifact-model">Agent or model used</label>
            <input
              id="artifact-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              maxLength={256}
              required
              placeholder="Your ACP agent and model"
            />
            {command.error && (
              <div className="notice error" role="alert">
                {command.error}
              </div>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button"
                onClick={() => setSubmit(null)}
              >
                Keep reviewing
              </button>
              <button
                className="button primary"
                disabled={disabled || !model.trim()}
              >
                Sign and submit <ArrowUp size={15} />
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {approve && (
        <Dialog title="Approve this artifact" close={() => setApprove(null)}>
          <div className="dialog-body">
            <p>
              Your signature approves this exact checkpoint. It does not merge
              or publish code.
            </p>
            <code className="commit-block">{approve.checkpoint}</code>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(event) => setReviewed(event.target.checked)}
              />{" "}
              I reviewed these changes and want to sign this artifact.
            </label>
            {command.error && (
              <div className="notice error" role="alert">
                {command.error}
              </div>
            )}
            <div className="dialog-actions">
              <button className="button" onClick={() => setApprove(null)}>
                Keep reviewing
              </button>
              <button
                className="button primary"
                disabled={!reviewed || disabled || !manifest}
                onClick={() => {
                  void command
                    .send(contribution.id, {
                      kind: "accept",
                      checkpoint: approve.checkpoint,
                      manifestDigest: approve.manifestDigest,
                    })
                    .then((sent) => {
                      if (sent) setApprove(null);
                    });
                }}
              >
                <CheckCheck size={16} /> Sign approval
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function Evidence({ done, text }: { done: boolean; text: string }) {
  return (
    <div className={`evidence-step ${done ? "done" : ""}`}>
      {done ? <Check size={14} /> : <Circle size={12} />}
      <span>{text}</span>
    </div>
  );
}
function Tool({
  part,
  turnId,
  active,
  canAct,
  answer,
}: {
  part: Extract<
    ChatState["turns"][number]["responseParts"][number],
    { kind: "toolCall" }
  >;
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
