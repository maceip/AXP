# Diagrams

## What changed

Fenced ` ```mermaid ` blocks in any prose (agent turns, discussion comments)
now render as inline SVG. The renderer is
[beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) by Craft
(MIT), vendored at `ui/vendor/beautiful-mermaid` with a handful of surgical
edits that give every diagram the AXP look. Rendering is synchronous and
DOM-free, so the same code draws the review samples in
`docs/design/diagrams/*.svg` from Node.

Open `docs/design/diagrams/mail-task.svg`, `lease.svg` and `review.svg` to see
a flowchart, a state diagram and nested subgraphs.

## The treatment

The goal was "clean and beautiful, and unmistakably ours" without redrawing the
renderer. Each change is a few lines in `renderer.ts` / `styles.ts` / `theme.ts`,
all marked `AXP:` in the source.

- **Leaf arrowheads.** The spec's triangle became a leaf: pointed tip, two
  curved sides, a softly concave base where it meets the stem, and a faint
  midrib in the page colour. It is the one detail nobody else has, and it
  reads at 100% zoom without shouting.
- **Rounded everything.** Rectangles get a 10px radius, `()` rounded nodes
  14px, and every polygon vertex (diamonds, hexagons, trapezoids, flags) is
  rounded with a quadratic curve clamped to the shorter adjacent edge, so
  small shapes stay sane.
- **Edges as drawn lines.** ELK's orthogonal routing is kept, but each bend is
  rounded (10px) and strokes have round caps. Connectors are 1.75px instead of
  a 1px hairline; boxes 1.5px.
- **Sticker nodes.** A soft drop shadow (`#axp-soft`, 1.5px down, 13% ink) sits
  every node on the page.
- **Garden-bed groups.** Subgraphs are rounded and dashed, with a header band
  whose top corners follow the outline.
- **Pill labels** on edges.
- **No remote font `@import`.** Upstream pulls Inter from Google Fonts inside
  the SVG; the workspace never loads third-party resources, so the style block
  now inherits the page's self-hosted font instead.

Colours come from `ui/src/diagram-theme.ts` and mirror the workspace tokens
(paper background, warm charcoal text, sage lines, leaf-green accent).

## How it is wired

- `ui/src/Diagram.tsx` renders one block with `useMemo`, refuses output that
  contains anything script-like, and falls back to the source with the parse
  error underneath.
- `ui/src/components.tsx` overrides the Markdown `pre` renderer: a
  `language-mermaid` code block becomes `<Diagram>`, loaded lazily. The layout
  engine (ELK) is 1.5 MB, so it is a separate chunk fetched only when prose
  contains a diagram.
- `ui/types/beautiful-mermaid-axp.d.ts` is the type boundary. Vite resolves
  `beautiful-mermaid-axp` to the vendored sources; TypeScript resolves it to
  this declaration, so the workspace's strict settings apply to our code
  without rewriting upstream's (which fails only `noUnusedLocals`).
- `scripts/design/render-diagrams.mts` regenerates the sample SVGs.

## Not done yet

- Sequence, class and ER diagrams render through their own sub-renderers and
  have not received the treatment; flowcharts and state diagrams have.
- The ASCII renderer is vendored but unused. It would let `axp inspect` or
  the AAMP result emails draw the same diagrams in plain text.
- A "kawaii" dial (blush dots on decision nodes, a sprout on the start node)
  was sketched and left out; the leaf arrowhead carries the identity on its own.
