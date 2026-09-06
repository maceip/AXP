import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  GitBranch,
  MessageCircle,
  Command,
} from "lucide-react";
import type { Contribution } from "../../src/workspace-contract.js";
import { useCommand } from "./api.js";
import { Avatar, Dialog, Empty, Mark, relativeTime } from "./components.js";

export function Nav({
  icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-item ${active ? "active" : ""}`}
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
      {count !== undefined && <span className="nav-count">{count}</span>}
    </button>
  );
}
export function Constellation({
  names,
  online,
}: {
  names: string[];
  online: number;
}) {
  return (
    <div className="constellation" aria-hidden="true">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <svg className="orbit-lines" viewBox="0 0 330 220">
        <path d="M75 60 175 114 270 53M60 164 175 114 278 177" />
      </svg>
      <div className="constellation-center">
        <Mark />
      </div>
      <div className="floating-note note-one">
        <GitBranch size={16} />
        <span>Session history</span>
      </div>
      <div className="floating-note note-two">
        <MessageCircle size={15} />
        <span>Discussion</span>
      </div>
      <div className="orbit-person person-one">
        <Avatar name={names[0] ?? "You"} />
      </div>
      <div className="orbit-person person-two">
        {names[1] ? <Avatar name={names[1]} /> : <Command size={21} />}
      </div>
      <div className="orbit-caption">
        <span className="connection-dot" />
        {online
          ? `${online} agent${online === 1 ? "" : "s"} connected`
          : "No agents connected"}
      </div>
    </div>
  );
}
export function Create({
  close,
  created,
  refresh,
}: {
  close: () => void;
  created: (session: string) => void;
  refresh: () => void;
}) {
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [session] = useState(() => crypto.randomUUID());
  const command = useCommand(refresh);
  return (
    <Dialog title="Start a contribution" close={close}>
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void command
            .send(session, { kind: "create", title, task })
            .then((sent) => {
              if (sent) created(session);
            });
        }}
      >
        <p>
          Describe the work. Contributors can connect an agent to this session.
        </p>
        <label htmlFor="contribution-title">What do you want to work on?</label>
        <input
          id="contribution-title"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Make the parser errors easier to understand"
          maxLength={256}
          required
        />
        <label htmlFor="contribution-task">Task or issue reference</label>
        <input
          id="contribution-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="issue-42 or a short, unique name"
          maxLength={512}
          required
        />
        {command.error && (
          <div className="notice error" role="alert">
            {command.error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={close}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={command.busy || !title.trim() || !task.trim()}
          >
            Create contribution <ArrowRight size={15} />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function Activity({
  contributions,
  open,
}: {
  contributions: Contribution[];
  open: (id: string) => void;
}) {
  const events = contributions
    .flatMap((contribution) => [
      ...(contribution.exchange.discussion ?? []).map((comment) => ({
        id: comment.id,
        author: comment.author,
        text: comment.body,
        label: "added to the discussion",
        at: comment.createdAt,
        contribution,
      })),
      ...(contribution.exchange.checkpoint
        ? [
            {
              id: `checkpoint-${contribution.id}`,
              author: "Project",
              text: contribution.exchange.checkpoint.headCommit.slice(0, 12),
              label: "shared a checkpoint",
              at: contribution.exchange.checkpoint.createdAt,
              contribution,
            },
          ]
        : []),
      ...(contribution.exchange.verification
        ? [
            {
              id: `verification-${contribution.id}`,
              author: contribution.exchange.verification.verifier,
              text: contribution.exchange.verification.command.join(" "),
              label:
                contribution.exchange.verification.exitCode === 0
                  ? "verified the checkpoint"
                  : "reported failing checks",
              at: contribution.exchange.verification.verifiedAt,
              contribution,
            },
          ]
        : []),
    ])
    .sort((a, b) => b.at - a.at);
  return events.length ? (
    <div className="activity-feed">
      {events.map((event) => (
        <article key={`${event.contribution.id}:${event.author}:${event.id}`}>
          <Avatar name={event.author} />
          <div>
            <div className="activity-title">
              <strong>{event.author}</strong> {event.label}
              <time>{relativeTime(event.at)}</time>
            </div>
            <button
              className="activity-contribution"
              onClick={() => open(event.contribution.id)}
            >
              {event.contribution.title}
              <ArrowUpRight size={14} />
            </button>
            <p>{event.text}</p>
          </div>
        </article>
      ))}
    </div>
  ) : (
    <Empty title="No activity yet">
      Checkpoints, verifications and comments will show up here.
    </Empty>
  );
}
