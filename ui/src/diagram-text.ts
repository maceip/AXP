import {
  layoutWithLines,
  measureLineStats,
  measureNaturalWidth,
  prepareWithSegments,
} from "@chenglou/pretext";
import type { PreparedTextWithSegments } from "@chenglou/pretext";

/* Exact text metrics for diagrams, from Pretext (MIT).
 *
 * beautiful-mermaid sizes nodes from a per-character width table calibrated
 * for Inter and cannot wrap a long label. In the browser we can do better:
 * Pretext measures with the page's actual font through canvas and lays lines
 * out itself, so node boxes fit the text and long labels break into balanced
 * lines before layout runs. Both hooks are no-ops outside a browser, where the
 * renderer keeps its estimates (the review-sample script runs there). */

const FAMILY = "AXP Runde";
const prepared = new Map<string, PreparedTextWithSegments>();

function font(fontSize: number, fontWeight: number): string {
  return `${fontWeight} ${fontSize}px "${FAMILY}", system-ui, sans-serif`;
}

function prepare(text: string, fontSize: number, fontWeight: number) {
  const key = `${fontWeight}|${fontSize}|${text}`;
  let ready = prepared.get(key);
  if (!ready) {
    ready = prepareWithSegments(text, font(fontSize, fontWeight));
    if (prepared.size > 2000) prepared.clear();
    prepared.set(key, ready);
  }
  return ready;
}

/** Width of a single line of text in the diagram font. */
export function measure(
  text: string,
  fontSize: number,
  fontWeight: number,
): number | null {
  if (typeof document === "undefined" || !text) return null;
  try {
    return measureNaturalWidth(prepare(text, fontSize, fontWeight));
  } catch {
    return null;
  }
}

/** Break a label into lines no wider than `maxWidth`, then tighten the width
 * until one more line would be needed, so the lines come out balanced rather
 * than one long line and one short one. Returns the label with '\n' breaks. */
export function wrap(
  text: string,
  fontSize: number,
  fontWeight: number,
  maxWidth: number,
): string {
  if (typeof document === "undefined") return text;
  try {
    const ready = prepare(text, fontSize, fontWeight);
    if (measureNaturalWidth(ready) <= maxWidth) return text;
    const target = measureLineStats(ready, maxWidth).lineCount;
    // binary search the narrowest width that still fits in `target` lines
    let low = maxWidth * 0.5;
    let high = maxWidth;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (measureLineStats(ready, mid).lineCount <= target) high = mid;
      else low = mid;
    }
    const lines = layoutWithLines(ready, high, fontSize * 1.4).lines.map(
      (line) => line.text.trim(),
    );
    return lines.filter(Boolean).join("\n");
  } catch {
    return text;
  }
}
