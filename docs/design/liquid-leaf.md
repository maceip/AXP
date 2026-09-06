# Liquid Leaf

## What it is

Liquid glass, outdoors. A translucent green surface, sap rather than glass,
for the parts of the workspace that should feel alive: presence, the primary
action, live state. It has a bright meniscus along the top, a specular
highlight that follows the pointer, a lit rim and a shaded foot, frost behind
it and a coloured glow into the page. Press it and it squashes, then springs
back with a short wobble.

Two scenes share one set of tokens: **outdoor** (default, daytime grass) and
**indoor** (`[data-scene="indoor"]`, night, moss under lamplight). The dark
theme has not been designed yet; indoor is the first sketch of what it wants
to be, and the tokens are the seam where it plugs in.

Open `docs/design/liquid-leaf.html` for both scenes side by side.

## Where it is used

- The "Live workspace" pill in the top bar, with a breathing sap drop for the
  connection state (sandy and still when reconnecting).
- The primary action ("New contribution").
- The "Connect an agent" card in the sidebar.
- Presence drops beside connected agents.

Everything else keeps the current flat chrome so the two can be compared.

Files: `ui/src/liquid/liquid-leaf.css` (tokens, surface, variants, filters),
`ui/src/liquid/LiquidLeaf.tsx` (`<LeafDefs/>`, `<Leaf variant=…/>`,
`useLeafLight`, `useLeafPress`).

## What was taken from liquid-dom, and what was not

[liquid-dom](https://github.com/AndrewPrifer/liquid-dom) renders real
refraction: an SDF of the shape gives a surface normal, the backdrop is
sampled through per-channel refraction, a specular band is lit along the rim,
and the backdrop is blurred adaptively. It needs WebGPU, and drawing live DOM
content behind the glass needs Chrome's experimental HTML-in-Canvas flag. That
is not a base to build a product on today, and its core package has no
license file, so nothing from it is vendored.

What carried over is the model of what makes glass read as liquid, rebuilt in
CSS and SVG so it works in every current browser:

| liquid-dom                        | Liquid Leaf                                                           |
| --------------------------------- | --------------------------------------------------------------------- |
| SDF rim + specular band           | 1px masked gradient border, bright at the light, dark opposite        |
| Lit highlight from a light vector | Radial gradient positioned by `--leaf-light-x/y`; pointer moves it    |
| Adaptive backdrop blur            | `backdrop-filter: blur(12px) saturate(1.35)`, solid fallback          |
| Corner smoothing                  | `corner-shape: squircle` where supported, radius elsewhere            |
| Refraction                        | Not attempted; a turbulence displacement on press stands in for "wet" |
| Blurred shadow mask               | Ambient lift plus a green-tinted glow                                 |

If WebGPU-backed glass ever becomes a reasonable dependency, it slots in as a
progressive enhancement behind the same class names.

## Notes for building on it

- The surface is one class (`.leaf`) plus a variant; new components should
  start from that rather than copying the gradient stack.
- `useLeafLight` is cheap (two custom properties per pointer move) and can be
  attached to anything, not only leaves.
- The goo filter (`.leaf-goo`) merges touching drops into one blob, the
  metaball trick. It is meant for avatar or agent clusters.
- Motion respects `prefers-reduced-motion`: no spring, no wobble, no breathing.
- Text on sap is the ink token, not pure black, and gets a 1px light text
  shadow outdoors / dark shadow indoors to stay crisp on the gradient.
