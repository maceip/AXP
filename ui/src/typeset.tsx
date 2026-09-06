import { createElement, useLayoutEffect, useRef } from "react";
import { justify } from "justif";
import { hyphenateEnUS } from "justif/hyphenate/en-us";

/* Paragraph-level typesetting.
 *
 * Justif runs Knuth–Plass line breaking over each paragraph it is given,
 * hyphenates with TeX patterns, hangs punctuation, and protrudes glyphs at
 * the margin. It only touches elements whose computed text-align is
 * `justify`, so the CSS decides which surfaces get the treatment and this
 * module decides when: never while text is still streaming in, and always
 * on a fresh element (callers key the element by its content) so React and
 * Justif never edit the same nodes. */

const BLOCKS = "p, li, dd, blockquote, figcaption";

export function typeset(root: HTMLElement): () => void {
  const targets = root.matches(BLOCKS)
    ? [root]
    : [...root.querySelectorAll<HTMLElement>(BLOCKS)];
  if (!targets.length) return () => {};
  const controller = justify(targets, {
    hyphenate: hyphenateEnUS,
    // Bringhurst's "at least a third": short last lines are widened rather
    // than left as a single hanging word.
    lastLineMinWidth: 0.33,
    cleanClipboard: true,
  });
  return () => controller.destroy();
}

/** Typeset the referenced element once it is settled. Re-run when `key` changes. */
export function useTypeset<T extends HTMLElement>(
  settled: boolean,
  key: string,
) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!settled || !ref.current) return;
    return typeset(ref.current);
  }, [settled, key]);
  return ref;
}

/** A justified block of plain text. The element remounts when its text changes. */
export function Typeset({
  as = "p",
  className,
  children,
}: {
  as?: "p" | "div";
  className?: string;
  children: string;
}) {
  return createElement(Block, { key: children, as, className, text: children });
}

function Block({
  as,
  className,
  text,
}: {
  as: "p" | "div";
  className?: string;
  text: string;
}) {
  const ref = useTypeset<HTMLElement>(true, text);
  return createElement(
    as,
    { ref, className: className ? `typeset ${className}` : "typeset" },
    text,
  );
}
