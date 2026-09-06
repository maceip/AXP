import { useMemo } from "react";
import {
  renderMermaidSVG,
  setLabelWrapper,
  setTextMeasurer,
} from "beautiful-mermaid-axp";
import { AXP_DIAGRAM_COLORS } from "./diagram-theme.js";
import { measure, wrap } from "./diagram-text.js";

// Real font metrics and balanced label wrapping, from Pretext (see diagram-text.ts).
setTextMeasurer(measure);
setLabelWrapper(wrap);

/* Renders a ```mermaid block as an inline SVG using the vendored
 * beautiful-mermaid renderer with the AXP kawaii treatment. Rendering is
 * synchronous, so the diagram appears with the rest of the prose; the ELK
 * layout engine is large, so this module is loaded lazily by Prose.
 *
 * The renderer escapes every label and attribute it emits. As a second line
 * of defence the output is refused (and the source shown instead) if it
 * contains anything script-like. */

const UNSAFE = /<script|javascript:|\son[a-z]+\s*=|<foreignObject|<iframe/i;

export default function Diagram({ code }: { code: string }) {
  const result = useMemo(() => {
    try {
      const svg = renderMermaidSVG(code, {
        ...AXP_DIAGRAM_COLORS,
        font: "AXP Runde",
        transparent: true,
      });
      if (UNSAFE.test(svg)) return { error: "Diagram output was refused." };
      return { svg };
    } catch (failure) {
      return {
        error:
          failure instanceof Error
            ? failure.message
            : "Diagram could not be drawn.",
      };
    }
  }, [code]);
  if ("error" in result) {
    return (
      <figure className="diagram diagram--source">
        <pre>
          <code>{code}</code>
        </pre>
        <figcaption>{result.error}</figcaption>
      </figure>
    );
  }
  return (
    <figure
      className="diagram"
      role="img"
      aria-label="Diagram"
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}
