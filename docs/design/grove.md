# Grove

## What it is

Grove is AXP's component kit. It starts from the Animal Island design language
([lifeodyssey/animal-island-ui-tailwind](https://github.com/lifeodyssey/animal-island-ui-tailwind),
MIT, after guokaigdg/animal-island-ui) and re-bases it on our palette. Nothing
is imported at runtime: no Tailwind, no Radix, no component code. What we took
is the design system, written down in `DESIGN_PROMPT.md` upstream, and what we
built is our own set of plain CSS classes with thin React wrappers.

Open `docs/design/grove.html` to see every component, and the palette mapping
from the foundation to ours.

## What we kept, and why

- **Capsules everywhere.** Buttons and inputs are full pills; nothing
  interactive has a corner sharper than 8px. This is the single strongest
  signal of the style.
- **The game-button press.** Depth is a flat bottom shadow, not a blur: 5px at
  rest, 6px with a 1px lift on hover, 1px with a 2px drop when pressed. Every
  button, switch handle and checkbox uses it. It is why the kit feels
  physical.
- **Chunky borders.** 2px on controls, 2.5px on inputs, in a soft sage.
- **A yellow focus ring.** `#ffcc00`, kept from the foundation on purpose: on
  a green page it is unmistakable and a little joyful.
- **Organic titles and the blob dialog.** The `Ribbon` uses the foundation's
  asymmetric radii; `BlobDialog` uses its exact clip-path on a native
  `<dialog>`.

## What is ours

- **Palette.** Parchment and brown became paper (`#f6f7f4`) and warm charcoal
  (`#252c28`); mint teal became leaf (`#58aa72`); the sand press shadow became
  a dry sage (`#b9c6b0`). Status tags map directly to the workspace's activity
  states (working, permission, review, ready, waiting, archived).
- **Speech bubbles** for turns: maintainer prompts on the left, agent replies
  on the right, each with a name tag on its shoulder. The transcript is a
  conversation; this lets it look like one.
- **A vine divider**, a repeating leaf wave in SVG.
- **Toasts** in the same paper-and-shadow language.

## Where it is applied

The "Start a contribution" dialog is now a `BlobDialog` with Grove inputs and
buttons (`ui/src/WorkspacePanels.tsx`). Everything else keeps the current
chrome so the two can be compared. Natural next surfaces: the permission
buttons on tool calls, the composer, the status chips on cards, and the
transcript (speech bubbles).

## Implementation notes

- `ui/src/grove/grove.css` is the kit; `ui/src/grove/Grove.tsx` wraps it
  (`Button`, `Input`, `Textarea`, `Switch`, `Checkbox`, `Tag`, `Ribbon`,
  `Speech`, `BlobDialog`, `Vine`, and `GroveDefs` which mounts the clip-path
  once).
- Switch and checkbox are CSS-only over a real `<input>`, using `:has()`;
  keyboard and screen-reader behaviour is the native one.
- The blob dialog fills the viewport and carries its own tint and blur. A
  transparent dialog box over a blurred `::backdrop` leaves a sharp
  un-blurred rectangle around the blob; this avoids it. The drop shadow sits
  on a wrapper so it follows the clipped silhouette.
- Reduced motion turns off the press transitions and the striped loading
  animation.
