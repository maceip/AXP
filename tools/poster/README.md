# AXP poster pipeline

City map posters in AXP's palette, for the day we post or tweet something and
want an image that looks like it came from our world.

This is a vendored copy of [MapToPoster](https://github.com/originalankur/maptoposter)
by Ankur Gupta (MIT; `LICENSE` and `UPSTREAM-README.md` are upstream's), with:

- two AXP themes, `themes/axp_outdoor.json` and `themes/axp_indoor.json`
- a font hook: `font_management.py` loads AXP Runde (or any bold/regular/light
  set) from `fonts/` or `$AXP_POSTER_FONT_DIR`, falling back to matplotlib's
  DejaVu Sans. Roboto is not vendored.
- `axp-poster`, a one-line wrapper

## Use

Needs [uv](https://docs.astral.sh/uv/) and network access to OpenStreetMap
(Nominatim for geocoding, Overpass for data). First run installs the pinned
Python environment from `uv.lock`.

```sh
# copy AXP Runde .otf files into tools/poster/fonts (built by
# scripts/fonts/build-axp-runde.py on the type branch), then:
tools/poster/axp-poster "Portland" "USA" outdoor 6000
tools/poster/axp-poster "Portland" "USA" indoor 6000
```

Output lands in `tools/poster/posters/` (ignored by git). Distance is the map
radius in metres; 6000 frames a downtown, 12000–18000 a whole city. Any
upstream flag can follow the four positional arguments (`--format svg`,
`--display-city`, `--width`, …).

## Status

The pipeline runs end to end; the two themes are placeholders derived from
the current workspace tokens. They will be replaced once the design language
is locked (Liquid Leaf greens, Grove's paper and ink, the type decisions), at
which point this becomes the marketing image generator it is meant to be.
