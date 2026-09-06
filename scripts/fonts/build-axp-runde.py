#!/usr/bin/env python3
"""Build the AXP Runde web fonts from Open Runde.

Open Runde (https://github.com/lauridskern/open-runde) is a rounded Inter. It
ships without Inter's alternate glyphs, so there is no tailed lowercase l to
switch on. This script adds one: a rounded, slightly upturned tail drawn from
the stem geometry of each weight, exposed as OpenType features `cv05` (the tag
Inter uses for the same idea) and `ss01`. Everything else is byte-for-byte the
same outline data, so with the features off the font renders as Open Runde.

Usage:
  python3 -m venv .venv && .venv/bin/pip install fonttools brotli
  .venv/bin/python scripts/fonts/build-axp-runde.py /path/to/open-runde/src/desktop ui/src/fonts/axp-runde

The output family is renamed to "AXP Runde" as the SIL OFL asks for modified
fonts. The original license travels with the files.
"""
from __future__ import annotations

import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables import otTables as ot

K = 0.5523  # circular arc approximation constant for cubic Béziers

WEIGHTS = {"Regular": 400, "Medium": 500, "Semibold": 600, "Bold": 700}


def stem_of_l(glyph_set):
    """Return (left, right, radius) of the plain l stem."""
    bp = BoundsPen(glyph_set)
    glyph_set["l"].draw(bp)
    left, _, right, top = bp.bounds
    # The stem's rounded corner radius is the y of the first on-curve point
    # (see the outline dump in the design notes); recover it from the contour.
    from fontTools.pens.recordingPen import RecordingPen

    rp = RecordingPen()
    glyph_set["l"].draw(rp)
    first = rp.value[0][1][0]
    radius = first[1]
    return left, right, radius, top


def draw_tailed_l(pen, left, right, radius, top):
    """Draw `l.tail`: the original stem ending in a short, upturned hook.

    The hook is what makes it read as a lowercase l with a tail (like Inter's
    cv05) rather than a small capital L: it is shorter than the stem is wide,
    it curves the whole way, and its terminal sits well above the baseline.
    Direction matches the source contour (right edge up first).
    """
    w = right - left
    thick = w * 0.74  # the hook is a stroke, visibly lighter than the stem
    term_r = thick / 2
    cx = right + w * 0.58  # terminal centre: the hook reaches ~0.95w past the stem
    cy = w * 0.50  # ...and its centre sits half a stem-width up
    end_x = cx + term_r
    bottom_y = cy - term_r  # lowest point of the terminal, above the baseline
    top_y = cy + term_r
    join_y = top_y + w * 0.62  # where the hook's inner curve meets the stem

    pen.moveTo((right, join_y))
    pen.lineTo((right, top - radius))
    pen.curveTo((right, top - radius * (1 - K)), (right - radius * (1 - K), top), (right - radius, top))
    pen.lineTo((left + radius, top))
    pen.curveTo((left + radius * (1 - K), top), (left, top - radius * (1 - K)), (left, top - radius))
    pen.lineTo((left, radius))
    pen.curveTo((left, radius * (1 - K)), (left + radius * (1 - K), 0), (left + radius, 0))
    # Outer edge: along the baseline, then one continuous sweep up into the terminal.
    pen.lineTo((right - w * 0.05, 0))
    pen.curveTo((right + w * 0.36, 0), (cx - term_r * 0.55, bottom_y), (cx, bottom_y))
    # Terminal: two quarter arcs, bottom → right → top.
    pen.curveTo((cx + term_r * K, bottom_y), (end_x, cy - term_r * K), (end_x, cy))
    pen.curveTo((end_x, cy + term_r * K), (cx + term_r * K, top_y), (cx, top_y))
    # Inner edge: sweep from the terminal top back into the stem.
    pen.curveTo((cx - term_r * 0.9, top_y), (right, top_y + w * 0.12), (right, join_y))
    pen.closePath()
    return end_x


def add_feature(gsub, tag, lookup_index):
    fr = ot.FeatureRecord()
    fr.FeatureTag = tag
    fr.Feature = ot.Feature()
    fr.Feature.FeatureParams = None
    fr.Feature.LookupListIndex = [lookup_index]
    fr.Feature.LookupCount = 1
    gsub.FeatureList.FeatureRecord.append(fr)
    gsub.FeatureList.FeatureCount = len(gsub.FeatureList.FeatureRecord)
    return gsub.FeatureList.FeatureCount - 1


def register_everywhere(gsub, feature_index):
    for sr in gsub.ScriptList.ScriptRecord:
        script = sr.Script
        systems = [script.DefaultLangSys] if script.DefaultLangSys else []
        systems += [r.LangSys for r in script.LangSysRecord]
        for ls in systems:
            ls.FeatureIndex.append(feature_index)
            ls.FeatureCount = len(ls.FeatureIndex)


def sort_features(gsub):
    """FeatureList must be sorted by tag; remap LangSys indices after sorting."""
    records = gsub.FeatureList.FeatureRecord
    order = sorted(range(len(records)), key=lambda i: records[i].FeatureTag)
    remap = {old: new for new, old in enumerate(order)}
    gsub.FeatureList.FeatureRecord = [records[i] for i in order]
    for sr in gsub.ScriptList.ScriptRecord:
        script = sr.Script
        systems = [script.DefaultLangSys] if script.DefaultLangSys else []
        systems += [r.LangSys for r in script.LangSysRecord]
        for ls in systems:
            ls.FeatureIndex = sorted(remap[i] for i in ls.FeatureIndex)


def build(src: Path, weight: str, out_dir: Path) -> None:
    source = TTFont(src / f"OpenRunde-{weight}.otf")
    glyph_set = source.getGlyphSet()
    order = list(source.getGlyphOrder())
    metrics = source["hmtx"].metrics
    upm = source["head"].unitsPerEm

    charstrings = {}
    for name in order:
        pen = T2CharStringPen(metrics[name][0], glyph_set)
        glyph_set[name].draw(pen)
        charstrings[name] = pen.getCharString()

    left, right, radius, top = stem_of_l(glyph_set)
    tail_pen = T2CharStringPen(0, glyph_set)  # width set below
    end_x = draw_tailed_l(tail_pen, left, right, radius, top)
    advance = round(end_x + left * 0.55)  # tighter right sidebearing than the plain stem
    tail_pen = T2CharStringPen(advance, glyph_set)
    draw_tailed_l(tail_pen, left, right, radius, top)
    charstrings["l.tail"] = tail_pen.getCharString()
    order.append("l.tail")
    new_metrics = dict(metrics)
    new_metrics["l.tail"] = (advance, left)

    family = "AXP Runde"
    ps_name = f"AXPRunde-{weight}"
    fb = FontBuilder(upm, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(source.getBestCmap())
    fb.setupCFF(
        ps_name,
        {"FullName": f"{family} {weight}", "FamilyName": family, "Weight": weight},
        charstrings,
        {},
    )
    fb.setupHorizontalMetrics(new_metrics)
    hhea = source["hhea"]
    fb.setupHorizontalHeader(ascent=hhea.ascent, descent=hhea.descent)
    os2 = source["OS/2"]
    fb.setupNameTable(
        {
            "familyName": family,
            "styleName": weight,
            "uniqueFontIdentifier": f"{ps_name};AXP",
            "fullName": f"{family} {weight}",
            "psName": ps_name,
            "version": "Version 1.001; AXP build from Open Runde 1.001",
            "copyright": "Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter). "
            "Open Runde by Laurids Kern. AXP Runde adds a tailed l (cv05/ss01).",
            "licenseDescription": "This Font Software is licensed under the SIL Open Font License, Version 1.1.",
            "licenseInfoURL": "https://scripts.sil.org/OFL",
        }
    )
    fb.setupOS2(
        version=4,
        usWeightClass=WEIGHTS[weight],
        sTypoAscender=os2.sTypoAscender,
        sTypoDescender=os2.sTypoDescender,
        sTypoLineGap=os2.sTypoLineGap,
        usWinAscent=os2.usWinAscent,
        usWinDescent=os2.usWinDescent,
        sxHeight=os2.sxHeight,
        sCapHeight=os2.sCapHeight,
        fsSelection=os2.fsSelection,
        fsType=0,
    )
    fb.setupPost()
    font = fb.font
    font["head"].macStyle = 1 if weight == "Bold" else 0
    # Carry the shaping tables over; glyph ids are unchanged because l.tail is appended.
    for table in ("GDEF", "GPOS", "GSUB"):
        if table in source:
            font[table] = source[table]

    gsub = font["GSUB"].table
    lookup = ot.Lookup()
    lookup.LookupType = 1
    lookup.LookupFlag = 0
    subst = ot.SingleSubst()
    subst.mapping = {"l": "l.tail"}
    lookup.SubTable = [subst]
    lookup.SubTableCount = 1
    gsub.LookupList.Lookup.append(lookup)
    gsub.LookupList.LookupCount = len(gsub.LookupList.Lookup)
    index = gsub.LookupList.LookupCount - 1
    for tag in ("cv05", "ss01"):
        register_everywhere(gsub, add_feature(gsub, tag, index))
    sort_features(gsub)

    out_dir.mkdir(parents=True, exist_ok=True)
    font.save(out_dir / f"{ps_name}.otf")
    font.flavor = "woff2"
    font.save(out_dir / f"{ps_name}.woff2")
    print(f"{ps_name}: l stem {left}-{right} r={radius}; l.tail advance {advance} (plain l {metrics['l'][0]})")


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    for weight in WEIGHTS:
        build(src, weight, out)


if __name__ == "__main__":
    main()
