import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  useEffect,
} from "react";
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
import { useCommand, useDraft } from "./api.js";
import { Transcript } from "./Transcript.js";
import {
  PencilCase,
  StampLayer,
  stampBody,
  stampOf,
  useReviewTools,
} from "./review/PencilCase.js";
import type { Landed } from "./review/PencilCase.js";
import { thunk } from "./review/sound.js";
import { QuotedProse } from "./review/QuotedProse.js";

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
  const draftKey = `${workspace.repository}:${workspace.principal.id}:${contribution.id}`;
  const [prompt, setPrompt] = useDraft(`${draftKey}:prompt`);
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [comment, setComment] = useDraft(`${draftKey}:comment`);
  const [anchorText, setAnchorText] = useDraft(`${draftKey}:anchor`);
  const anchor = useMemo(() => {
    try {
      const value = JSON.parse(anchorText) as {
        path?: unknown;
        checkpoint?: unknown;
      };
      return typeof value?.path === "string" &&
        typeof value?.checkpoint === "string"
        ? { path: value.path, checkpoint: value.checkpoint }
        : null;
    } catch {
      return null;
    }
  }, [anchorText]);
  const setAnchor = (value: { path: string; checkpoint: string } | null) =>
    setAnchorText(JSON.stringify(value));
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
  const command = useCommand(refresh, draftKey);
  const { pending, acknowledge } = command;
  useEffect(() => {
    if (!pending) return;
    const action = pending.action;
    if (
      action.kind === "comment" &&
      exchange.discussion?.some(
        (item) =>
          item.id === pending.operationId &&
          item.author === workspace.principal.id,
      )
    ) {
      if (comment === action.body) {
        setComment("");
        setAnchorText("null");
      }
      acknowledge();
    } else if (
      action.kind === "prompt" &&
      (chat.activeTurn?.id === pending.operationId ||
        chat.turns.some((turn) => turn.id === pending.operationId) ||
        chat.queuedMessages?.some(
          (message) => message.id === pending.operationId,
        ) ||
        chat.steeringMessage?.id === pending.operationId)
    ) {
      if (prompt === action.text) setPrompt("");
      acknowledge();
    }
  }, [
    pending,
    acknowledge,
    exchange.discussion,
    workspace.principal.id,
    chat,
    comment,
    prompt,
    setComment,
    setPrompt,
    setAnchorText,
  ]);
  const maintainer = workspace.principal.role === "maintainer";
  const writable = workspace.principal.role !== "observer";
  const disabled = offline || command.busy;
  const checkpoint = exchange.checkpoint;
  const review = useReviewTools();
  const [quote, setQuote] = useState<{
    text: string;
    author: string;
    x: number;
    y: number;
  } | null>(null);
  const [landed, setLanded] = useState<Landed[]>([]);
  useEffect(() => setQuote(null), [tab, review.tool]);
  /** Highlighter: a drag over prose paints a mark and offers to quote it. */
  const paintSelection = (panel: HTMLElement) => {
    if (review.tool !== "highlighter") return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const prose = element?.closest(".prose");
    if (!prose || !panel.contains(prose)) return;
    const text = selection.toString().trim();
    if (!text) return;
    const author = prose.closest(".turn-response")
      ? "the agent"
      : prose.closest(".turn-prompt")
        ? "the maintainer"
        : (prose.closest(".comment")?.querySelector("strong")?.textContent ??
          "the discussion");
    const rect = range.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    review.mark(range);
    selection.removeAllRanges();
    setQuote({
      text,
      author,
      x: rect.left - box.left + rect.width / 2,
      y: rect.bottom - box.top + 8,
    });
  };
  /** Stamp: lands where you click and posts the verdict. */
  const dropStamp = (event: React.MouseEvent<HTMLDivElement>) => {
    if (review.tool !== "stamp" || disabled) return;
    if (
      (event.target as HTMLElement).closest(
        "button, a, input, textarea, select",
      )
    )
      return;
    const box = event.currentTarget.getBoundingClientRect();
    setLanded((all) => [
      ...all,
      {
        id: crypto.randomUUID(),
        stamp: review.stamp,
        where: tab,
        x: event.clientX - box.left,
        y: event.clientY - box.top,
        rot: -12 + Math.random() * 10,
      },
    ]);
    thunk();
    const onChanges = tab === "changes" && checkpoint;
    void command.send(contribution.id, {
      kind: "comment",
      body: stampBody(
        review.stamp,
        onChanges ? `on ${checkpoint.headCommit.slice(0, 7)}` : undefined,
      ),
      checkpoint: onChanges ? checkpoint.headCommit : null,
      path: null,
    });
  };
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
  return (
    <section
      className={`contribution-page ${review.tool ? `tool-${review.tool}` : ""}`}
    >
      {writable && !offline && exchange.status !== "closed" && (
        <PencilCase review={review} />
      )}
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
              {contribution.turnCount === 1 ? "turn" : "turns"}
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
            onPointerUp={(event) => paintSelection(event.currentTarget)}
            onClick={dropStamp}
          >
            <StampLayer
              stamps={landed.filter((stamp) => stamp.where === tab)}
            />
            {quote && (
              <button
                type="button"
                className="pc-quote-chip"
                style={{
                  left: quote.x,
                  top: quote.y,
                  transform: "translateX(-50%)",
                }}
                onClick={() => {
                  const quoted = quote.text
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n");
                  setComment(
                    `${comment.trim() ? `${comment.trim()}\n\n` : ""}${quoted}\n\n— quoting ${quote.author}`,
                  );
                  setQuote(null);
                  setTab("discussion");
                }}
              >
                <MessageCircle size={13} /> Quote in discussion
              </button>
            )}
            {tab === "conversation" && (
              <>
                <Transcript
                  detail={detail}
                  workspace={workspace}
                  canAct={maintainer && !disabled}
                  answer={(turnId, toolId, optionId) => {
                    void command.send(contribution.id, {
                      kind: "permission",
                      turnId,
                      toolId,
                      optionId,
                    });
                  }}
                />
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
                          "No agent connected yet"
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
                      : "Only maintainers can send prompts. Other participants can follow the session and read the discussion."}
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
                    review={{
                      tool: review.tool,
                      ink: review.ink,
                      onNote: (text, path, reference) => {
                        void command.send(contribution.id, {
                          kind: "comment",
                          body: `${text}\n\n\`${reference}\``,
                          checkpoint: checkpoint.headCommit,
                          path,
                        });
                      },
                    }}
                  />
                </Suspense>
              ) : (
                <Empty title="No checkpoint yet">
                  Once the agent saves a checkpoint, its changes will show up
                  here for review.
                </Empty>
              ))}
            {tab === "discussion" && (
              <div className="discussion is-paper">
                <div className="discussion-intro">
                  <MessageCircle size={19} />
                  <div>
                    <h3>Discussion</h3>
                    <p>Comments stay with this contribution.</p>
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
                      {(() => {
                        const stamp = stampOf(item.body);
                        if (stamp) {
                          const rest = item.body
                            .trim()
                            .slice(stamp.label.length + 4)
                            .replace(/^\s*—\s*/, "");
                          return (
                            <>
                              <span
                                className="pc-stamp-inline"
                                style={{ ["--stamp-ink" as string]: stamp.ink }}
                              >
                                {stamp.label}
                              </span>
                              {rest && <p className="muted">{rest}</p>}
                            </>
                          );
                        }
                        return item.body.trimStart().startsWith("> ") ? (
                          <QuotedProse text={item.body} />
                        ) : (
                          <Prose text={item.body} />
                        );
                      })()}
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
            <h3>Review status</h3>
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
                    ? "Start axp ui with --key to sign approvals."
                    : tab !== "changes"
                      ? "Open Changes to inspect the artifact before approving."
                      : "Approving signs this checkpoint. It doesn't publish anything."}
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
          {!exchange.lease && exchange.status !== "closed" && (
            <section className="aside-section join-agent">
              <span className="agent-symbol">✳</span>
              <h3>Connect your agent</h3>
              <p>Run this command to connect to the session.</p>
              <code>
                axp park {contribution.id} --profile .axp/contributor.json
                --native -- YOUR_ACP_AGENT
              </code>
              <p className="aside-hint">
                Run from your checkout. Your local tools use your user
                permissions.
              </p>
            </section>
          )}
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
              Sign this checkpoint and its history so a maintainer can review
              it.
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
              Your signature approves this checkpoint. It doesn't merge or
              publish code.
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
