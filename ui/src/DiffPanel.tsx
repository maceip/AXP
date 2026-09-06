import { useEffect, useMemo, useState } from "react";
import {
  parsePatchFiles,
  registerCustomTheme,
  resolveTheme,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Columns2, Rows3, MessageCircle, FileCode2 } from "lucide-react";
import { api } from "./api.js";
import { Empty, Loading } from "./components.js";
import { StickyNote } from "./review/PencilCase.js";
import type { Tool } from "./review/Pen.js";

export interface DiffReview {
  tool: Tool | null;
  /** current highlighter ink, used to tint selected lines */
  ink: string;
  /** Post a note pinned to `reference` ("path:L3–L7"). */
  onNote: (text: string, path: string, reference: string) => void;
}

// Keep comments readable on diff addition/removal backgrounds as well as white.
registerCustomTheme("axp-light", async () => {
  const theme = await resolveTheme("github-light-high-contrast");
  return {
    ...theme,
    name: "axp-light",
    settings: theme.settings.map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        ...(rule.settings.foreground?.toLowerCase() === "#66707b"
          ? { foreground: "#53606a" }
          : {}),
      },
    })),
  };
});

export default function DiffPanel({
  session,
  checkpoint,
  discuss,
  ready,
  review,
}: {
  session: string;
  checkpoint: string;
  discuss: (path: string) => void;
  ready: (manifestDigest: string | null) => void;
  review?: DiffReview;
}) {
  const [patch, setPatch] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ patch: string; manifestDigest: string | null }>(
      `patch?session=${encodeURIComponent(session)}&checkpoint=${checkpoint}`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setPatch(result.patch);
          ready(result.manifestDigest);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load this patch",
          );
      });
    return () => controller.abort();
  }, [session, checkpoint, ready]);
  if (error)
    return (
      <div className="notice error" role="alert">
        {error}
      </div>
    );
  if (patch === undefined) return <Loading>Loading checkpoint…</Loading>;
  return <Patch patch={patch} discuss={discuss} review={review} />;
}

function Patch({
  patch,
  discuss,
  review,
}: {
  patch: string;
  discuss: (path: string) => void;
  review?: DiffReview;
}) {
  // Lines the reviewer has marked with the highlighter or note tool; a sticky
  // note renders under the last one until it is pinned or discarded.
  const [pending, setPending] = useState<{ start: number; end: number } | null>(
    null,
  );
  const selecting = review?.tool === "highlighter" || review?.tool === "note";
  const parsed = useMemo(() => {
    try {
      return {
        files: parsePatchFiles(patch).flatMap((part) => part.files),
        error: null,
      };
    } catch {
      return {
        files: [],
        error:
          "This patch couldn't be displayed. Use axp export SESSION to find the checkpoint's Git bundle and patch.",
      };
    }
  }, [patch]);
  const paths = useMemo(
    () => parsed.files.map((file) => file.name),
    [parsed.files],
  );
  const [selected, setSelected] = useState(paths[0]);
  const [split, setSplit] = useState(window.innerWidth > 1800);
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    initialSelectedPaths: paths.slice(0, 1),
    // The beta's built-in search input is nested inside role=tree. Keep our
    // labelled search outside that composite until upstream fixes its semantics.
    search: false,
    fileTreeSearchMode: "hide-non-matches",
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      if (path && paths.includes(path)) setSelected(path);
    },
    unsafeCSS:
      ":host { --trees-font-family: 'DM Sans Variable', sans-serif; --trees-font-size: 12px; --trees-fg-override: #34433a; --trees-fg-muted-override: #4f5d4c; }",
  });
  const file =
    parsed.files.find((file) => file.name === selected) ?? parsed.files[0];
  useEffect(() => setPending(null), [selected, review?.tool]);
  if (parsed.error)
    return (
      <div className="notice error" role="alert">
        {parsed.error}
      </div>
    );
  if (!file)
    return (
      <Empty title="No text changes in this checkpoint">
        There are no text changes to display. Download the Git bundle to inspect
        the full checkpoint, including any binary files.
      </Empty>
    );
  return (
    <div className="diff-workspace">
      <aside className="file-sidebar">
        <div className="file-sidebar-title">
          <FileCode2 size={14} /> Changed files <span>{paths.length}</span>
        </div>
        <input
          className="file-search"
          aria-label="Search changed files"
          placeholder="Find a file…"
          onChange={(event) => {
            if (event.target.value) model.setSearch(event.target.value);
            else model.closeSearch();
          }}
        />
        <FileTree model={model} style={{ height: "min(520px, 60vh)" }} />
      </aside>
      <div className="diff-main">
        <div className="diff-toolbar">
          <span title={file.name}>{file.name}</span>
          <div className="toolbar-actions">
            <button
              className="icon-button"
              onClick={() => setSplit(!split)}
              title={split ? "Use unified diff" : "Use split diff"}
              aria-label={split ? "Use unified diff" : "Use split diff"}
            >
              {split ? <Rows3 size={16} /> : <Columns2 size={16} />}
            </button>
            <button
              className="icon-button"
              onClick={() => discuss(file.name)}
              title="Discuss this file"
              aria-label="Discuss this file"
            >
              <MessageCircle size={16} />
            </button>
          </div>
        </div>
        <FileDiff
          fileDiff={file}
          selectedLines={
            pending ? { start: pending.start, end: pending.end } : null
          }
          lineAnnotations={
            pending
              ? [
                  {
                    side: "additions",
                    lineNumber: pending.end,
                    metadata: pending,
                  },
                ]
              : []
          }
          renderAnnotation={(annotation) => {
            const range = annotation.metadata as { start: number; end: number };
            const reference =
              range.start === range.end
                ? `${file.name}:L${range.start}`
                : `${file.name}:L${range.start}–L${range.end}`;
            return (
              <StickyNote
                reference={reference}
                onCancel={() => setPending(null)}
                onPost={(text) => {
                  review?.onNote(text, file.name, reference);
                  setPending(null);
                }}
              />
            );
          }}
          options={{
            theme: "axp-light",
            themeType: "light",
            diffStyle: split ? "split" : "unified",
            overflow: "scroll",
            disableFileHeader: true,
            enableLineSelection: selecting,
            controlledSelection: true,
            onLineSelectionEnd: (range) => {
              if (!selecting || !range) return;
              const [start, end] =
                range.start <= range.end
                  ? [range.start, range.end]
                  : [range.end, range.start];
              setPending({ start, end });
            },
            unsafeCSS: `:host { --diffs-font-family: 'IBM Plex Mono', monospace; --diffs-font-size: 12px; --diffs-line-height: 22px; --diffs-bg-selection-override: color-mix(in srgb, ${review?.ink ?? "#f3d43a"} 42%, transparent); --diffs-bg-selection-number-override: color-mix(in srgb, ${review?.ink ?? "#f3d43a"} 70%, transparent); }`,
          }}
        />
      </div>
    </div>
  );
}
