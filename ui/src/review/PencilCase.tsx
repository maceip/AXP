import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Eraser, Volume2, VolumeX } from "lucide-react";
import { highlight } from "@highlighters/core";
import type { MarkHandle } from "@highlighters/core";
import { Highlighter, NotePen, PenDefs, Stamp } from "./Pen.js";
import type { Tool } from "./Pen.js";
import { setSoundEnabled, soundEnabled, squeak, thunk } from "./sound.js";
import "./pencil-case.css";

/* Review tools for a contribution, modelled on a real pencil case.
 *
 *   Highlighter  drag over prose to lay down a real highlighter mark and get
 *                a "Quote in discussion" chip; on the diff, select lines to
 *                pin a sticky note to them
 *   Stamp        pick a stamp, click anywhere: it lands with a thunk and the
 *                verdict is posted to the discussion
 *   Note         click a diff line for a sticky note
 *
 * Marks and stamps are local decoration; the discussion comment is the
 * record. Nothing here changes the protocol. */

export const SWATCHES = [
  { id: "yellow", label: "Yellow", ink: "#f3d43a" },
  { id: "green", label: "Green", ink: "#8fd67a" },
  { id: "pink", label: "Pink", ink: "#f4a0c6" },
  { id: "blue", label: "Blue", ink: "#8cc5f2" },
] as const;
export type Swatch = (typeof SWATCHES)[number]["id"];

export const STAMPS = [
  { id: "lgtm", label: "LGTM", ink: "#2f7d4a" },
  { id: "needs-work", label: "Needs work", ink: "#b23a2f" },
  { id: "question", label: "Question", ink: "#8b5e1a" },
  { id: "nice", label: "Nice", ink: "#4a5f9e" },
] as const;
export type StampId = (typeof STAMPS)[number]["id"];

export interface ReviewState {
  tool: Tool | null;
  swatch: Swatch;
  ink: string;
  stamp: StampId;
  setTool: (tool: Tool | null) => void;
  setSwatch: (swatch: Swatch) => void;
  setStamp: (stamp: StampId) => void;
  /** Paint a highlighter mark over a range; returns its handle. */
  mark: (range: Range) => MarkHandle | null;
  clearMarks: () => void;
  marks: number;
}

export function useReviewTools(): ReviewState {
  const [tool, setToolState] = useState<Tool | null>(null);
  const [swatch, setSwatch] = useState<Swatch>("yellow");
  const [stamp, setStamp] = useState<StampId>("lgtm");
  const handles = useRef<MarkHandle[]>([]);
  const [marks, setMarks] = useState(0);
  const setTool = useCallback((next: Tool | null) => {
    setToolState((current) => {
      const value = current === next ? null : next;
      if (value) squeak(value === "stamp" ? 0.7 : 1);
      return value;
    });
  }, []);
  const mark = useCallback(
    (range: Range) => {
      try {
        const handle = highlight(range, {
          color: { palette: "mild", swatch },
          tip: { type: "chisel" },
          snap: "word",
          animation: { draw: true, duration: 420 },
        });
        handles.current.push(handle);
        setMarks(handles.current.length);
        squeak(1.3);
        return handle;
      } catch {
        return null;
      }
    },
    [swatch],
  );
  const clearMarks = useCallback(() => {
    for (const handle of handles.current) handle.remove();
    handles.current = [];
    setMarks(0);
  }, []);
  useEffect(() => () => clearMarks(), [clearMarks]);
  useEffect(() => {
    if (!tool) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setToolState(null);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [tool]);
  const ink = SWATCHES.find((s) => s.id === swatch)!.ink;
  return {
    tool,
    swatch,
    ink,
    stamp,
    setTool,
    setSwatch,
    setStamp,
    mark,
    clearMarks,
    marks,
  };
}

const TOOLS: { id: Tool; label: string; art: (ink: string) => ReactNode }[] = [
  {
    id: "highlighter",
    label: "Highlighter",
    art: (ink) => <Highlighter ink={ink} />,
  },
  { id: "stamp", label: "Stamp", art: (ink) => <Stamp ink={ink} /> },
  { id: "note", label: "Note", art: (ink) => <NotePen ink={ink} /> },
];

export function PencilCase({ review }: { review: ReviewState }) {
  const [sound, setSound] = useState(soundEnabled);
  const [focused, setFocused] = useState<number | null>(null);
  const ink = review.ink;
  const stampInk = STAMPS.find((s) => s.id === review.stamp)!.ink;
  const outlineIndex = focused ?? TOOLS.findIndex((t) => t.id === review.tool);
  return (
    <div className="pencil-case" role="toolbar" aria-label="Review tools">
      <PenDefs />
      <div className="pc-tools">
        {TOOLS.map((tool, index) => (
          <button
            key={tool.id}
            type="button"
            className="pc-tool"
            aria-label={tool.label}
            aria-pressed={review.tool === tool.id}
            onClick={() => review.setTool(tool.id)}
            onFocus={() => setFocused(index)}
            onBlur={() => setFocused(null)}
          >
            {tool.art(
              tool.id === "stamp"
                ? stampInk
                : tool.id === "note"
                  ? "#f3d43a"
                  : ink,
            )}
            <span className="pc-tool-label">{tool.label}</span>
          </button>
        ))}
        <span
          className="pc-outline"
          style={{
            transform: `translateX(${Math.max(outlineIndex, 0) * 50}px)`,
          }}
          aria-hidden="true"
        />
      </div>
      <span className="pc-divider" />
      {review.tool === "stamp" ? (
        <div className="pc-group" role="radiogroup" aria-label="Stamp">
          {STAMPS.map((stamp) => (
            <button
              key={stamp.id}
              type="button"
              className="pc-chip"
              role="radio"
              aria-checked={review.stamp === stamp.id}
              aria-pressed={review.stamp === stamp.id}
              style={{
                color: review.stamp === stamp.id ? undefined : stamp.ink,
              }}
              onClick={() => review.setStamp(stamp.id)}
            >
              {stamp.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="pc-group" role="radiogroup" aria-label="Ink colour">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch.id}
              type="button"
              className="pc-swatch"
              role="radio"
              aria-label={swatch.label}
              aria-checked={review.swatch === swatch.id}
              style={{ background: swatch.ink }}
              onClick={() => review.setSwatch(swatch.id)}
            />
          ))}
        </div>
      )}
      <span className="pc-divider" />
      <div className="pc-group pc-secondary">
        <button
          type="button"
          className="pc-icon"
          aria-label={
            review.marks ? `Clear ${review.marks} marks` : "No marks to clear"
          }
          disabled={!review.marks}
          onClick={review.clearMarks}
          title="Clear marks"
        >
          <Eraser size={14} />
        </button>
        <button
          type="button"
          className="pc-icon"
          aria-label="Tool sounds"
          aria-pressed={sound}
          onClick={() => {
            const next = !sound;
            setSoundEnabled(next);
            setSound(next);
            if (next) thunk();
          }}
          title={sound ? "Sounds on" : "Sounds off"}
        >
          {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      </div>
    </div>
  );
}

/** A stamp that has landed on the page. */
export interface Landed {
  id: string;
  stamp: StampId;
  /** which tab panel it landed on */
  where: string;
  x: number;
  y: number;
  rot: number;
}
export function StampLayer({ stamps }: { stamps: Landed[] }) {
  return (
    <div className="pc-stamp-layer" aria-hidden="true">
      {stamps.map((landed) => {
        const def = STAMPS.find((s) => s.id === landed.stamp)!;
        return (
          <span
            key={landed.id}
            className="pc-stamp"
            style={{
              left: landed.x,
              top: landed.y,
              ["--rot" as string]: `${landed.rot}deg`,
              ["--stamp-ink" as string]: def.ink,
            }}
          >
            {def.label}
          </span>
        );
      })}
    </div>
  );
}

/** Stamps are recorded as comments beginning with the verdict in bold. */
export function stampBody(stamp: StampId, where?: string): string {
  const def = STAMPS.find((s) => s.id === stamp)!;
  return `**${def.label}**${where ? ` — ${where}` : ""}`;
}
export function stampOf(body: string): (typeof STAMPS)[number] | null {
  const match = /^\*\*([^*]+)\*\*/.exec(body.trim());
  if (!match) return null;
  return STAMPS.find((s) => s.label === match[1]) ?? null;
}

/** Sticky note pinned to diff lines. */
export function StickyNote({
  reference,
  onPost,
  onCancel,
}: {
  reference: string;
  onPost: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
  }, []);
  return (
    <div className="pc-note" role="group" aria-label={`Note on ${reference}`}>
      <div className="pc-note-ref">{reference}</div>
      <textarea
        ref={area}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Leave a note on these lines…"
        aria-label="Note text"
        maxLength={4000}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            text.trim()
          )
            onPost(text.trim());
        }}
      />
      <div className="pc-note-actions">
        <button type="button" onClick={onCancel}>
          Discard
        </button>
        <button
          type="button"
          className="primary"
          disabled={!text.trim()}
          onClick={() => onPost(text.trim())}
        >
          Pin note
        </button>
      </div>
    </div>
  );
}
