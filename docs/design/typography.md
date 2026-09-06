# Typography

## What changed

The UI face is now **AXP Runde**: [Open Runde](https://github.com/lauridskern/open-runde)
(Laurids Kern's rounded cut of Inter, SIL OFL 1.1) plus one glyph of our own, a
hooked lowercase `l`, exposed as the OpenType features `cv05` and `ss01`. With the
features off the font is Open Runde, outline for outline. The app turns `cv05`
on globally in `ui/src/style.css`.

DM Sans is gone. IBM Plex Mono stays for code until the monospace decision below.

Files:

- `ui/src/fonts/axp-runde/*.woff2` — the four built weights (400/500/600/700)
- `ui/src/fonts/open-runde/*.woff2` — the unmodified upstream files, kept for comparison
- `ui/src/fonts/axp-runde.css` — `@font-face` rules; imported from `ui/src/main.tsx`
- `scripts/fonts/build-axp-runde.py` — reproducible build (fontTools + brotli)
- `docs/design/type-specimen.html` — open it in a browser to compare everything below

## Why a signature glyph

You pointed at Maple Mono's curled `l` as the kind of detail that makes a face
recognisable, and highlighte.rs gets a similar effect from Inter's own `cv05`
(tailed `l`). Open Runde dropped Inter's alternate glyphs when it was rounded,
so there was nothing to switch on. Drawing one is a small amount of geometry:
the stem is a rounded rectangle, and the hook is a stroke about three-quarters
of the stem width that sweeps off the baseline into a round terminal sitting
half a stem-width up. It is generated from each weight's actual stem, so it
stays proportional from Regular to Bold.

Two practical wins ride along with the identity:

- `l`, `I` and `1` stop colliding ("Illinois", "1lI") at the 10–12px sizes this UI uses.
- Because it is a feature, any surface can opt out (`font-feature-settings: "cv05" 0`)
  without loading another font.

Known limits: the new glyph is not in the kerning classes, so pairs like `ly`
and `lt` use default spacing; Open Runde is static (no variable axes), so the
CSS weights `550`/`650` were mapped to `600`/`700`.

## Ten alternatives, and why not

All open-licensed, all usable at UI sizes, deliberately different from each other.
See the specimen for the rendered comparison.

| Face                       | Character                                      | Verdict                                                                   |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- |
| Nunito                     | Fully rounded, warm, slightly wide             | The Animal Crossing library's default; friendly but generic in 2026       |
| Zen Maru Gothic            | Japanese rounded gothic, charming Latin        | Most "kawaii"; strong second choice, and gives us JP coverage             |
| M PLUS Rounded 1c          | Softer, rounder than Zen Maru                  | Toy-like at display sizes                                                 |
| Quicksand                  | Geometric rounded, light                       | Too thin at 11–12px; l/I worse                                            |
| Fredoka                    | Chunky, playful                                | Great for stamps and big labels, not for body                             |
| Figtree                    | Friendly geometric, soft joins                 | Excellent UI text, little personality                                     |
| Plus Jakarta Sans          | Quirky modern grotesque                        | Reads "startup", not "outdoors"                                           |
| Lexend                     | Readability-first, wide                        | Eats horizontal room in dense views                                       |
| Recursive                  | Variable: sans↔mono, linear↔casual, one family | Strongest alternative identity; the casual axis has real hand-drawn charm |
| Atkinson Hyperlegible Next | Tailed l, serifed I, slashed 0 by design       | Proves the signature-glyph idea; feels clinical for our mood              |
| Varela Round               | Lovely rounded shapes                          | One weight only, so no hierarchy                                          |

Recommendation: keep AXP Runde. If we ever want more character than a rounded
Inter can give, Recursive is the one to prototype next, because it would let
UI and code share one family (and its casual mono is close to what the
discussion voice wants).

## Monospace: open decision

Candidates, all OFL: Maple Mono (the curled `l` you referenced; ligatures;
build service), Recursive Mono Casual (pairs with the sans, hand-drawn feel),
Monaspace Radon (handwriting mono with texture healing), JetBrains Mono (safe),
Victor Mono (narrow, cursive italics for comments), Fantasque Sans Mono,
Commit Mono, 0xProto, Iosevka (buildable curly variants).

My lean: Maple Mono for code and diffs so the `l` hook echoes across UI and
code, with ligatures off in diffs (they hide characters reviewers need to see).
It is not on Google Fonts, so it would be vendored like AXP Runde.

## Handwriting accent

highlighte.rs sets its quotes in a handwriting face ("Letters Home"), and the
review-tools experiment wants the same for reviewer scribbles and stamps.
Caveat (loose, 18px+) and Patrick Hand (neater, works smaller) are the two
free faces that fit; both are in the specimen.
