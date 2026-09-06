import { memo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  GitBranch,
  LoaderCircle,
  MessageCircle,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  Contribution,
  WorkspaceView,
} from "../../src/workspace-contract.js";

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? "brand-mark small" : "brand-mark"}
      viewBox="0 0 36 36"
      aria-hidden="true"
    >
      <path
        d="M4 4h12v12H4zM20 4h12v12H20zM4 20h12v12H4z"
        fill="currentColor"
      />
      <path
        d="m20 20 12 12M32 20 20 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
      />
    </svg>
  );
}
export function Avatar({
  name,
  size = "normal",
}: {
  name: string;
  size?: "normal" | "small" | "large";
}) {
  const color = [...name].reduce((n, char) => n + char.charCodeAt(0), 0) % 5;
  return (
    <span className={`avatar avatar-${color} ${size}`} title={name}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}
export const labels: Record<Contribution["activity"], string> = {
  working: "In progress",
  permission: "Needs your input",
  review: "Ready for review",
  ready: "Checkpoint ready",
  waiting: "Open for contribution",
  parked: "Agent ready",
  failed: "Needs attention",
  archived: "Archived",
};
export function Status({ activity }: { activity: Contribution["activity"] }) {
  return (
    <span className={`status ${activity}`}>
      <span className="status-dot" />
      {labels[activity]}
    </span>
  );
}
export function people(view: WorkspaceView) {
  const members = new Map<
    string,
    { id: string; turns: number; comments: number; sessions: Set<string> }
  >();
  const member = (id: string) => {
    let item = members.get(id);
    if (!item) {
      item = { id, turns: 0, comments: 0, sessions: new Set() };
      members.set(id, item);
    }
    return item;
  };
  member(view.principal.id);
  for (const executor of view.executors) member(executor.owner);
  for (const contribution of view.contributions) {
    for (const grant of Object.values(contribution.exchange.grants)) {
      const person = member(grant.owner);
      person.turns += grant.spent.turns;
      person.sessions.add(contribution.id);
    }
    for (const comment of contribution.exchange.discussion ?? []) {
      const person = member(comment.author);
      person.comments++;
      person.sessions.add(contribution.id);
    }
    if (contribution.exchange.verification)
      member(contribution.exchange.verification.verifier).sessions.add(
        contribution.id,
      );
  }
  return [...members.values()].sort(
    (a, b) => b.sessions.size - a.sessions.size || a.id.localeCompare(b.id),
  );
}
export function Contributors({ contribution }: { contribution: Contribution }) {
  const names = [
    ...new Set([
      ...Object.values(contribution.exchange.grants).map((g) => g.owner),
      ...(contribution.exchange.discussion ?? []).map((c) => c.author),
    ]),
  ];
  return names.length ? (
    <span className="avatar-stack">
      {names.slice(0, 3).map((name) => (
        <Avatar key={name} name={name} size="small" />
      ))}
      <span>
        {names.length === 1 ? names[0] : `${names.length} contributors`}
      </span>
    </span>
  ) : (
    <span className="muted">Be the first to join</span>
  );
}
export function ContributionCard({
  contribution,
  open,
}: {
  contribution: Contribution;
  open: (id: string) => void;
}) {
  return (
    <button className="contribution-card" onClick={() => open(contribution.id)}>
      <div className="card-top">
        <Status activity={contribution.activity} />
        <ArrowUpRight size={17} />
      </div>
      <span className="card-task">{contribution.exchange.task}</span>
      <h3>{contribution.title}</h3>
      <p>{contribution.preview || "No description yet."}</p>
      <div className="card-evidence">
        <span>
          <GitBranch size={13} />
          {contribution.exchange.checkpoint
            ? contribution.exchange.checkpoint.headCommit.slice(0, 7)
            : "No checkpoint yet"}
        </span>
        <span>
          <MessageCircle size={13} />
          {contribution.exchange.discussion?.length ?? 0}
        </span>
        {contribution.exchange.verification?.exitCode === 0 && (
          <span className="verified">
            <Check size={13} /> Verified
          </span>
        )}
      </div>
      <div className="card-footer">
        <Contributors contribution={contribution} />
      </div>
    </button>
  );
}
export const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
              <ArrowUpRight size={12} />
            </a>
          ),
          img: ({ alt }) => (
            <span className="muted">[Image: {alt || "attachment"}]</span>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark">
        <Mark small />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({
  children = "Opening the workspace…",
}: {
  children?: ReactNode;
}) {
  return (
    <div className="loading" role="status">
      <LoaderCircle size={18} className="spin" />
      {children}
    </div>
  );
}
export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    node.showModal();
    return () => node.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={close}
      onClick={(event) => {
        if (event.target === dialog.current) {
          const r = dialog.current.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            close();
        }
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close dialog"
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function relativeTime(time: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
