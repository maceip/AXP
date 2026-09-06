import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Command,
  GitBranch,
  LayoutGrid,
  MessageCircle,
  Plus,
  Radio,
  Search,
  Users,
  Zap,
} from "lucide-react";
import type { Contribution } from "../../src/workspace-contract.js";
import { useCommand, useWorkspace } from "./api.js";
import {
  Avatar,
  ContributionCard,
  Dialog,
  Empty,
  Loading,
  Mark,
  people,
  relativeTime,
} from "./components.js";
import { ContributionPage } from "./Contribution.js";

type Page = "overview" | "contributions" | "people" | "activity";

export default function App() {
  const [session, setSession] = useState(() =>
    new URLSearchParams(location.search).get("session"),
  );
  const [page, setPage] = useState<Page>("overview");
  const [create, setCreate] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const { workspace, detail, error, refresh } = useWorkspace(session);
  const navigate = (id: string | null) => {
    history.pushState(
      null,
      "",
      id ? `?session=${encodeURIComponent(id)}` : "/",
    );
    setSession(id);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    const changed = () =>
      setSession(new URLSearchParams(location.search).get("session"));
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    if (workspace)
      document.title = `${detail?.contribution.title ?? workspace.repository} · AXP`;
  }, [workspace, detail]);
  const online =
    workspace?.executors.filter(
      (executor) => executor.online && executor.expiresAt > Date.now(),
    ) ?? [];
  const members = workspace ? people(workspace) : [];
  const contributions = workspace?.contributions ?? [];
  const needsHelp = contributions.filter(
    (c) => c.activity === "permission" || c.activity === "review",
  );
  const visible = contributions.filter(
    (c) =>
      (!query ||
        `${c.title} ${c.exchange.task} ${c.preview}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" || filter === "attention"
        ? filter === "all" || needsHelp.includes(c)
        : c.activity === filter),
  );
  const repository = workspace?.repository ?? "Your repository";
  const go = (next: Page) => {
    setPage(next);
    setFilter("all");
    navigate(null);
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <a
          className="brand"
          aria-label="AXP overview"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            go("overview");
          }}
        >
          <Mark />
          <span>
            axp<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-switcher">
          <span className="repo-monogram">
            {repository.split("/").at(-1)?.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{repository.split("/").at(-1)}</strong>
            <span>Contribution workspace</span>
          </div>
        </div>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Workspace">
          <Nav
            icon={<LayoutGrid size={18} />}
            label="Overview"
            active={!session && page === "overview"}
            onClick={() => go("overview")}
          />
          <Nav
            icon={<GitBranch size={18} />}
            label="Contributions"
            count={workspace?.total}
            active={!!session || page === "contributions"}
            onClick={() => go("contributions")}
          />
          <Nav
            icon={<Users size={18} />}
            label="People"
            active={!session && page === "people"}
            onClick={() => go("people")}
          />
          <Nav
            icon={<Radio size={18} />}
            label="Activity"
            active={!session && page === "activity"}
            onClick={() => go("activity")}
          />
        </nav>
        <div className="sidebar-bottom">
          <div className="bring-agent">
            <span className="agent-symbol">✳</span>
            <h3>
              A little compute.
              <br />A lot of possibility.
            </h3>
            <p>Bring your agent. Make a contribution that stays.</p>
            <button onClick={() => setHelp(true)}>
              Find your place <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={16} /> Getting started
          </button>
          <div className="identity">
            <Avatar name={workspace?.principal.id ?? "You"} />
            <div>
              <strong>{workspace?.principal.id ?? "Connecting"}</strong>
              <span>{workspace?.principal.role ?? "Your workspace"}</span>
            </div>
            <span
              className={`connection-dot ${error ? "offline" : ""}`}
              title={error ? "Disconnected" : "Connected"}
            />
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>{repository}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`live-pill ${error ? "is-offline" : ""}`}>
              <span />
              {error
                ? "Reconnecting"
                : workspace
                  ? "Live workspace"
                  : "Connecting"}
            </span>
            <button
              className="icon-button"
              onClick={() => setHelp(true)}
              aria-label="Workspace help"
            >
              <CircleHelp size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="connection-notice" role="alert">
            {error}{" "}
            {workspace &&
              "Showing the last received state. Changes are paused."}
            <button onClick={refresh}>Retry</button>
          </div>
        )}
        <main id="main" tabIndex={-1}>
          {!workspace ? (
            error ? (
              <Empty title="Your private workspace link is needed">
                Run <code>axp ui</code> in your project and open the link it
                prints. The repository's credentials stay on your computer.
              </Empty>
            ) : (
              <Loading />
            )
          ) : session ? (
            detail ? (
              <ContributionPage
                key={session}
                detail={detail}
                workspace={workspace}
                back={() => navigate(null)}
                refresh={refresh}
                offline={!!error}
              />
            ) : (
              <>
                <button className="back-button" onClick={() => navigate(null)}>
                  ← All contributions
                </button>
                <Loading>Opening contribution…</Loading>
              </>
            )
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {page === "overview" ? "YOUR SHARED WORKSPACE" : repository}
                  </div>
                  <h1>
                    {page === "overview"
                      ? "Good work adds up."
                      : page === "contributions"
                        ? "Contributions"
                        : page === "people"
                          ? "The people behind it."
                          : "A project, in motion."}
                  </h1>
                  <p>
                    {page === "overview"
                      ? "A place for your agents, your ideas, and the people moving it all forward."
                      : page === "contributions"
                        ? "Pick up a thread. Leave the project a little better."
                        : page === "people"
                          ? "Compute, context, care. Every kind of contribution belongs here."
                          : "The checkpoints and conversations that stay with the work."}
                  </p>
                </div>
                {workspace.principal.role === "maintainer" && (
                  <button
                    className="button primary"
                    disabled={!!error}
                    onClick={() => setCreate(true)}
                  >
                    <Plus size={16} /> New contribution
                  </button>
                )}
              </div>
              {page === "overview" && (
                <section className="welcome-card">
                  <div>
                    <div className="welcome-kicker">
                      <span className="small-orbit" /> OPEN SOURCE, TOGETHER
                    </div>
                    <h2>
                      Bring what you know.
                      <br />
                      Build what comes next.
                    </h2>
                    <p>
                      Your agent can do the heavy lifting.
                      <br />
                      Your judgment makes the difference.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => {
                        setPage("contributions");
                        setFilter(needsHelp.length ? "attention" : "waiting");
                      }}
                    >
                      Find a way to contribute <ArrowRight size={16} />
                    </button>
                  </div>
                  <Constellation
                    names={members.map((member) => member.id)}
                    online={online.length}
                  />
                </section>
              )}
              {(page === "overview" || page === "contributions") && (
                <div className="overview-layout">
                  <section className="work-section">
                    <div className="section-heading">
                      <h2>
                        {page === "overview"
                          ? "On the workbench"
                          : "All contributions"}
                        <span>{workspace.total}</span>
                      </h2>
                      <label className="search">
                        <Search size={15} />
                        <input
                          aria-label="Search contributions"
                          placeholder="Find a contribution…"
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                    </div>
                    <div className="filters" aria-label="Filter contributions">
                      {[
                        ["all", "All work"],
                        ["attention", "Needs a hand"],
                        ["working", "In progress"],
                        ["waiting", "Open to join"],
                        ["archived", "Archived"],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          onClick={() => setFilter(value!)}
                          aria-pressed={filter === value}
                        >
                          {label}
                          {value === "attention" && needsHelp.length > 0 && (
                            <span>{needsHelp.length}</span>
                          )}
                        </button>
                      ))}
                    </div>
                    {workspace.total > contributions.length && (
                      <div className="notice">
                        Showing the latest {contributions.length} of{" "}
                        {workspace.total} contributions. Open an older session
                        with its workspace link or the CLI.
                      </div>
                    )}
                    <div className="contribution-grid">
                      {visible.map((contribution) => (
                        <ContributionCard
                          key={contribution.id}
                          contribution={contribution}
                          open={navigate}
                        />
                      ))}
                    </div>
                    {visible.length === 0 && (
                      <Empty
                        title={
                          contributions.length
                            ? "A little quieter here."
                            : "The first contribution is yours to shape."
                        }
                      >
                        {contributions.length
                          ? "Try another filter, or start a new thread of work."
                          : "Open a contribution, invite an agent, and let the work begin."}
                      </Empty>
                    )}
                  </section>
                  <aside className="community-aside">
                    <section>
                      <div className="section-heading">
                        <h2>Here, together</h2>
                        <button
                          className="icon-button"
                          onClick={() => go("people")}
                          aria-label="View people"
                        >
                          <ArrowUpRight size={16} />
                        </button>
                      </div>
                      <p className="aside-subtitle">
                        The people making it happen.
                      </p>
                      <div className="people-list">
                        {members.slice(0, 5).map((member) => (
                          <div className="person" key={member.id}>
                            <Avatar name={member.id} />
                            <div>
                              <strong>{member.id}</strong>
                              <span>
                                {member.id === workspace.principal.id
                                  ? "You · "
                                  : ""}
                                {member.sessions.size
                                  ? `${member.sessions.size} contribution${member.sessions.size === 1 ? "" : "s"}`
                                  : "Ready to contribute"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="agent-presence">
                      <div className="section-heading">
                        <h2>
                          <Zap size={16} /> Agent presence
                        </h2>
                        <span>{online.length}</span>
                      </div>
                      {online.length ? (
                        online.slice(0, 5).map((agent) => (
                          <div className="online-agent" key={agent.id}>
                            <span className="agent-symbol">✳</span>
                            <div>
                              <strong>{agent.name}</strong>
                              <span>with {agent.owner}</span>
                            </div>
                            <span className="connection-dot" />
                          </div>
                        ))
                      ) : (
                        <p>
                          No agents connected yet.
                          <br />
                          There is room for yours.
                        </p>
                      )}
                      <button
                        className="text-button"
                        onClick={() => setHelp(true)}
                      >
                        Connect an agent <ArrowRight size={14} />
                      </button>
                    </section>
                    <div className="community-note">
                      <span>↗</span>
                      <p>
                        The code matters.
                        <br />
                        So do the people who stay.
                      </p>
                    </div>
                  </aside>
                </div>
              )}
              {page === "people" && (
                <>
                  <div className="people-grid">
                    {members.map((member) => (
                      <article className="person-card" key={member.id}>
                        <Avatar name={member.id} size="large" />
                        <h2>{member.id}</h2>
                        <p>
                          {member.id === workspace.principal.id
                            ? `You · ${workspace.principal.role}`
                            : "Project contributor"}
                        </p>
                        <div className="person-stats">
                          <span>
                            <strong>{member.sessions.size}</strong>{" "}
                            contributions
                          </span>
                          <span>
                            <strong>{member.turns}</strong> agent turns
                          </span>
                          <span>
                            <strong>{member.comments}</strong> comments
                          </span>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => {
                            setPage("contributions");
                            setQuery(
                              member.sessions.size === 1
                                ? (contributions.find((c) =>
                                    member.sessions.has(c.id),
                                  )?.title ?? "")
                                : "",
                            );
                          }}
                        >
                          Explore the work <ArrowRight size={14} />
                        </button>
                      </article>
                    ))}
                  </div>
                  <p className="fine-print">
                    Participation reflects the {contributions.length}{" "}
                    contributions in this view. Agent turns include
                    conservatively accounted interrupted work.
                  </p>
                </>
              )}
              {page === "activity" && (
                <Activity contributions={contributions} open={navigate} />
              )}
              <footer className="workspace-footer">
                <span>
                  <Mark small /> A little better, together.
                </span>
                <span>AHP · ACP · AAMP</span>
              </footer>
            </>
          )}
        </main>
      </div>
      {create && workspace && (
        <Create
          close={() => setCreate(false)}
          created={(id) => {
            setCreate(false);
            navigate(id);
          }}
          refresh={refresh}
        />
      )}
      {help && (
        <Dialog
          title="Find your place in the project"
          close={() => setHelp(false)}
        >
          <div className="dialog-body onboarding">
            <div className="onboarding-step">
              <span>01</span>
              <div>
                <h3>Choose a contribution</h3>
                <p>
                  Find something open to join, or ask a maintainer to create a
                  session for your idea.
                </p>
              </div>
            </div>
            <div className="onboarding-step">
              <span>02</span>
              <div>
                <h3>Bring your agent</h3>
                <p>
                  From your checkout, connect your ACP agent using your
                  contributor profile and a budget you choose.
                </p>
                <code>
                  axp park SESSION --profile .axp/contributor.json --native --
                  YOUR_ACP_AGENT
                </code>
                <p className="fine-print">
                  Native tools run with your user permissions. Use --image for
                  an offline container instead.
                </p>
              </div>
            </div>
            <div className="onboarding-step">
              <span>03</span>
              <div>
                <h3>Stay for the conversation</h3>
                <p>
                  Review the changes, share context, and help the next person
                  build on what you learned.
                </p>
              </div>
            </div>
            <button
              className="button primary full"
              onClick={() => {
                setHelp(false);
                go("contributions");
              }}
            >
              <Check size={16} /> Explore contributions
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Nav({
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
function Constellation({ names, online }: { names: string[]; online: number }) {
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
        <span>One shared history</span>
      </div>
      <div className="floating-note note-two">
        <MessageCircle size={15} />
        <span>Room for your ideas</span>
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
          : "Made for working together"}
      </div>
    </div>
  );
}
function Create({
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
          Give a useful piece of work a home. People and agents can pick it up
          from here.
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
function Activity({
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
    <Empty title="The story starts with a contribution.">
      Shared checkpoints, independent checks and discussion will collect here as
      the project grows.
    </Empty>
  );
}
