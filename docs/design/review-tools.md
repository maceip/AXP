# Review tools: the pencil case

## What we learned from highlighte.rs

[highlighte.rs](https://highlighte.rs) is a library for realistic highlighter
marks, but the thing worth taking is how its site feels to use. The tools are
physical: pens stand in a tray with their tips showing, rise when you hover,
lift right out when you pick one, and a soft outline travels between them on
a spring. Ink colour crossfades. Marks are drawn on, not switched on. There is
a squeak when you pick a marker. Everything shares one quint curve
(`cubic-bezier(0.2, 0, 0, 1)`), text sits on cream paper in warm brown ink,
and nothing is decorated that does not also do something.

Their answer to "what do you build with this?" is a highlighter. Ours is code
review, because that is what maintainers do all day in AXP.

## What was built

A pencil case: a capsule tray that floats at the bottom of a contribution
page for anyone who can post (`ui/src/review`). Three tools, four inks, four
stamps, an eraser, and an opt-in sound toggle.

- **Highlighter.** Drag over any prose (an agent turn, a maintainer prompt, a
  comment) and a real highlighter mark is laid down with `@highlighters/core`
  (MIT): chisel tip, word snapping, a short draw-on animation. A chip appears
  under the mark: _Quote in discussion_. It quotes the passage into the
  composer with an attribution and switches to the discussion. Quoted comments
  render with the same mark over the quote, so the trail is visible.
- **Highlighter and Note on the diff.** With either held, Pierre's line
  selection is enabled; dragging down the gutter selects lines (tinted with
  the current ink), and a sticky note appears under the last line with the
  reference (`src/parser.ts:L2–L4`). Pin it and it posts as a comment anchored
  to the checkpoint and file, with the reference in code.
- **Stamp.** Pick LGTM, Needs work, Question or Nice, click anywhere, and the
  stamp lands with a spring and a rubber-stamp ink texture. The verdict is
  posted to the discussion as `**LGTM** — on bbbbbbb`, which the discussion
  renders as a stamp again. Landed stamps are local decoration; the comment
  is the record.
- **Paper.** The discussion sits on ruled paper (24px rhythm, 6% ink).

No protocol changes. Every action is an ordinary `_axp/comment`, which is
why the tools work for contributors and verifiers as well as maintainers, and
why nothing needs a migration.

## The interaction language, as rules

These are the rules the pencil case follows, written down so the rest of the
app can follow them too:

1. Tools are objects. They have a resting place, they rise when you reach for
   them, and they lift when you pick them up. Selected ≠ highlighted.
2. One curve. `cubic-bezier(0.2, 0, 0, 1)` for state changes; a `linear()`
   spring only for things that arrive (the tray, a stamp, a note).
3. Ink is a colour property, so changing it crossfades rather than re-renders.
4. Marks are drawn, over the text, never in it: selection, copy and find
   keep working.
5. Sound is opt-in, synthesised, and remembered per browser.
6. Keyboard first: the tray is a toolbar, tools are toggle buttons, inks and
   stamps are radio groups, Escape puts the tool down.
7. Decoration never replaces the record. A stamp is a comment.

## Not done yet

- A vendored handwriting face for notes and stamps; the note uses a cursive
  system stack for now (see `typography.md` for candidates).
- Marks and landed stamps do not persist across reloads. If they should, the
  comment already carries enough to redraw them (file, lines, quote).
- Stamps could drive review flow: LGTM opening the approval dialog for a
  maintainer who can sign is the obvious next step.
- Underline and strike-through pens (highlighters supports both) for
  suggesting deletions in prose.
