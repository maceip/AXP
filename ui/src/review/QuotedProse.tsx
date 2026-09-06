import { useEffect, useRef } from "react";
import { highlight } from "@highlighters/core";
import type { MarkHandle } from "@highlighters/core";
import { Prose } from "../components.js";

/** A comment that quotes something: the quoted lines get a real highlighter
 * mark, the way the quote was made. */
export function QuotedProse({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handles: MarkHandle[] = [];
    const quotes = ref.current?.querySelectorAll("blockquote") ?? [];
    for (const quote of quotes) {
      quote.classList.add("is-quote");
      try {
        handles.push(
          highlight(quote, {
            color: { palette: "mild", swatch: "yellow" },
            tip: { type: "chisel" },
            snap: "word",
          }),
        );
      } catch {
        /* a mark is decoration; the text is still there */
      }
    }
    return () => {
      for (const handle of handles) handle.remove();
    };
  }, [text]);
  return (
    <div ref={ref}>
      <Prose text={text} />
    </div>
  );
}
