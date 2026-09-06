# Typesetting

## What changed

Prose in the workspace is now set with [Justif](https://github.com/lyallcooper/justif)
(MIT): Knuth–Plass line breaking over the whole paragraph, TeX hyphenation
patterns, punctuation hung into the margin, and glyph protrusion at the edges.
The browser's one-line-at-a-time justification produces rivers and loose
lines; Justif evaluates the paragraph as a whole, the way a book is set.

Where it applies:

- Every Markdown paragraph, list item and blockquote in the agent transcript and
  the discussion (the `Prose` component), once the text has settled.
- Not while a turn is still streaming: those paragraphs stay ragged with
  `text-wrap: pretty` so the text does not reflow under the reader, and are
  typeset the moment the turn completes.
- Not on teasers and labels. Two-line card descriptions were hyphenating
  ("exist-ing parser API"), which is fussier than it is beautiful, so short
  copy keeps the browser's `pretty` breaker and headings get `balance`.

Files: `ui/src/typeset.tsx` (the `typeset()` helper, `useTypeset` hook and a
`Typeset` block for plain text), `ui/src/components.tsx` (`Prose` gains a
`settled` prop), `ui/src/Transcript.tsx`, `ui/src/style.css`.

## How it coexists with React

Justif rewrites the inside of each paragraph (one span per line with tuned
word spacing and tracking), and restores it on `destroy()`. React must never
update nodes Justif has rearranged, so `Prose` keys its element by content:
new text means a fresh element, the old controller is destroyed on unmount,
and the new one runs in a layout effect. Resize and font loading are handled
by Justif's own observers.

One CSS detail mattered: `overflow-wrap: anywhere` (which the prose container
uses so long URLs cannot blow out the layout) lets the browser take emergency
breaks inside words, which undid Justif's plan and produced a stray short
line after inline `code`. Justified blocks now set `overflow-wrap: normal`;
long unbreakable strings are handled by Justif declining that paragraph and
leaving it native.

## Where else it could go

- The agent's tool output and comments already flow through `Prose`. The
  activity feed still renders raw comment text with `white-space: pre-wrap`;
  moving it to `Prose` would justify it too.
- Justif supports per-line `wdth` adjustments on variable fonts. AXP Runde is
  static, so that lever is unused; Recursive (see `typography.md`) would enable it.
- German, French and twenty other hyphenation dictionaries are available if
  the workspace ever carries a `lang` other than English.
