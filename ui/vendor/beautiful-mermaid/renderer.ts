import type { PositionedGraph, PositionedNode, PositionedEdge, PositionedGroup, Point } from './types.ts'
import type { DiagramColors } from './theme.ts'
import { svgOpenTag, buildStyleBlock } from './theme.ts'
import { FONT_SIZES, FONT_WEIGHTS, STROKE_WIDTHS, ARROW_HEAD, KAWAII, estimateTextWidth, TEXT_BASELINE_SHIFT } from './styles.ts'
import { measureMultilineText } from './text-metrics.ts'
import { renderMultilineText, renderMultilineTextWithBackground, escapeXml } from './multiline-utils.ts'

// ============================================================================
// SVG renderer — converts a PositionedGraph into an SVG string.
//
// Pure string concatenation, no DOM manipulation.
// Renders back-to-front: groups → edges → arrow heads → edge labels → nodes → node labels.
//
// All colors are referenced via CSS custom properties (var(--_xxx)) defined
// in the <style> block. The caller provides bg/fg (+ optional enrichment
// colors) via DiagramColors, which are set as inline CSS variables on the
// <svg> tag. See src/theme.ts for the full variable system.
//
// AXP "kawaii" treatment (surgical edits over upstream beautiful-mermaid):
// - Rectangles and polygons have rounded corners; groups are rounded and dashed
// - Edges keep ELK's orthogonal routing with every bend rounded
// - Arrow heads are leaves (pointed tip, curved sides, faint midrib)
// - Nodes carry a soft drop shadow (#axp-soft) so they sit like stickers
// - Strokes are 1.5-1.75px with round caps; no remote font @import
// ============================================================================

/**
 * Render a positioned graph as an SVG string.
 *
 * @param colors - DiagramColors with bg/fg and optional enrichment variables.
 *                 These are set as CSS custom properties on the <svg> tag.
 *                 All element colors reference derived --_xxx variables.
 * @param transparent - If true, renders with transparent background.
 */
export function renderSvg(
  graph: PositionedGraph,
  colors: DiagramColors,
  font: string = 'Inter',
  transparent: boolean = false
): string {
  const parts: string[] = []

  // SVG root with CSS variables + style block + defs
  parts.push(svgOpenTag(graph.width, graph.height, colors, transparent))
  parts.push(buildStyleBlock(font, false))
  parts.push('<defs>')
  // AXP: a soft, slightly warm drop shadow so nodes sit on the page like stickers.
  parts.push(
    '  <filter id="axp-soft" x="-10%" y="-10%" width="120%" height="130%">' +
    '<feDropShadow dx="0" dy="1.5" stdDeviation="1.4" flood-color="var(--fg)" flood-opacity="0.13" />' +
    '</filter>'
  )
  parts.push(arrowMarkerDefs())
  // Per-color arrow markers for edges with custom stroke via linkStyle
  const customStrokeColors = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.inlineStyle?.stroke) {
      customStrokeColors.add(edge.inlineStyle.stroke)
    }
  }
  for (const color of customStrokeColors) {
    parts.push(arrowMarkerDefsForColor(color))
  }
  parts.push('</defs>')

  // 1. Subgraph backgrounds (group rectangles with header bands)
  for (const group of graph.groups) {
    parts.push(renderGroup(group, font))
  }

  // 2. Edges (polylines — rendered behind nodes)
  // Each edge is a <polyline> with semantic data-* attributes
  for (const edge of graph.edges) {
    parts.push(renderEdge(edge))
  }

  // 3. Edge labels (positioned at midpoint of edge)
  // Each label is wrapped in <g class="edge-label">
  for (const edge of graph.edges) {
    if (edge.label) {
      parts.push(renderEdgeLabel(edge, font))
    }
  }

  // 4. Nodes (shape + label wrapped in <g class="node">)
  for (const node of graph.nodes) {
    parts.push(renderNode(node, font))
  }

  parts.push('</svg>')

  return parts.join('\n')
}

// ============================================================================
// Arrow marker definitions
// ============================================================================

/**
 * Reusable arrow head markers — both forward (end) and reverse (start) variants.
 * The reverse marker uses orient="auto-start-reverse" to flip automatically.
 * Arrow color uses var(--_arrow) CSS variable.
 */
function arrowMarkerDefs(): string {
  return leafMarkers('arrowhead', 'var(--_arrow)')
}

/**
 * AXP: the arrowhead is a leaf. Pointed tip, two soft curved sides, a gently
 * concave base where it meets the stem, and a faint midrib. Same silhouette
 * forward and reversed; `orient` handles the flip.
 */
function leafPath(w: number, h: number): string {
  const c = h / 2
  return (
    `M0 ${c - h * 0.28} ` +
    `C${w * 0.3} ${c - h * 0.58}, ${w * 0.7} ${c - h * 0.5}, ${w} ${c} ` +
    `C${w * 0.7} ${c + h * 0.5}, ${w * 0.3} ${c + h * 0.58}, 0 ${c + h * 0.28} ` +
    `Q${w * 0.16} ${c}, 0 ${c - h * 0.28} Z`
  )
}

function leafMarkers(id: string, color: string): string {
  const w = ARROW_HEAD.width
  const h = ARROW_HEAD.height
  const style = `fill="${color}" stroke="${color}" stroke-width="0.6" stroke-linejoin="round"`
  const rib = `<path d="M${w * 0.12} ${h / 2} L${w * 0.78} ${h / 2}" stroke="var(--bg)" stroke-width="0.9" stroke-opacity="0.7" stroke-linecap="round" fill="none" />`
  const refX = w - 1
  return (
    `  <marker id="${id}" markerWidth="${w}" markerHeight="${h}" refX="${refX}" refY="${h / 2}" orient="auto" markerUnits="userSpaceOnUse">` +
    `\n    <path d="${leafPath(w, h)}" ${style} />${rib}` +
    `\n  </marker>` +
    `\n  <marker id="${id}-start" markerWidth="${w}" markerHeight="${h}" refX="${refX}" refY="${h / 2}" orient="auto-start-reverse" markerUnits="userSpaceOnUse">` +
    `\n    <path d="${leafPath(w, h)}" ${style} />${rib}` +
    `\n  </marker>`
  )
}

/**
 * Generate arrow markers tinted to a specific color (for linkStyle stroke overrides).
 * IDs are suffixed with a sanitized color string to avoid collisions.
 */
function arrowMarkerDefsForColor(color: string): string {
  return leafMarkers(`arrowhead-${markerSuffix(color)}`, escapeAttr(color)).replace(
    `id="arrowhead-${markerSuffix(color)}-start"`,
    `id="arrowhead-start-${markerSuffix(color)}"`
  )
}

/** Sanitize a color value into a collision-free SVG ID suffix.
 *  Non-alphanumeric chars are hex-encoded so distinct inputs never collapse
 *  (e.g. "var(--line-1)" → "var28--line2d129", "var(--line1)" → "var28--line129"). */
function markerSuffix(color: string): string {
  return color.replace(/[^a-zA-Z0-9]/g, (ch) => ch.charCodeAt(0).toString(16))
}

// ============================================================================
// Group rendering (subgraph backgrounds)
// ============================================================================

function renderGroup(group: PositionedGroup, font: string): string {
  const headerHeight = FONT_SIZES.groupHeader + 16
  const parts: string[] = []

  // Opening <g> with semantic attributes for subgraph identification
  // data-id: original Mermaid subgraph ID
  // data-label: display label (may differ from ID)
  parts.push(
    `<g class="subgraph" data-id="${escapeAttr(group.id)}" data-label="${escapeAttr(group.label)}">`
  )

  // Outer rectangle (AXP: rounded, dashed like a garden bed outline)
  const gr = KAWAII.groupRadius
  parts.push(
    `  <rect x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" ` +
    `rx="${gr}" ry="${gr}" fill="var(--_group-fill)" stroke="var(--_node-stroke)" stroke-width="${STROKE_WIDTHS.outerBox}" stroke-dasharray="6 5" />`
  )

  // Header band: only the top corners are rounded so it nests into the outline
  const gx = group.x, gy = group.y, gw = group.width, hh = headerHeight
  parts.push(
    `  <path d="M${gx + gr} ${gy} H${gx + gw - gr} A${gr} ${gr} 0 0 1 ${gx + gw} ${gy + gr} V${gy + hh} H${gx} V${gy + gr} A${gr} ${gr} 0 0 1 ${gx + gr} ${gy} Z" ` +
    `fill="var(--_group-hdr)" stroke="none" />`
  )

  // Header label (supports multi-line via <br> tags)
  parts.push(
    '  ' + renderMultilineText(
      group.label,
      group.x + 12,
      group.y + headerHeight / 2,
      FONT_SIZES.groupHeader,
      `font-size="${FONT_SIZES.groupHeader}" font-weight="${FONT_WEIGHTS.groupHeader}" fill="var(--_text-sec)"`
    )
  )

  // Render nested groups recursively (inside this group)
  for (const child of group.children) {
    parts.push(renderGroup(child, font))
  }

  parts.push('</g>')

  return parts.join('\n')
}

// ============================================================================
// Edge rendering
// ============================================================================

function renderEdge(edge: PositionedEdge): string {
  if (edge.points.length < 2) return ''

  const pathData = pointsToPolylinePath(edge.points)
  const dashArray = edge.style === 'dotted' ? ' stroke-dasharray="4 4"' : ''
  const baseStrokeWidth = edge.style === 'thick' ? STROKE_WIDTHS.connector * 2 : STROKE_WIDTHS.connector
  const strokeColor = escapeAttr(edge.inlineStyle?.stroke ?? 'var(--_line)')
  const strokeWidth = escapeAttr(edge.inlineStyle?.['stroke-width'] ?? String(baseStrokeWidth))

  // Build marker attributes based on arrow direction flags
  // Use color-specific markers when edge has a custom stroke from linkStyle
  const suffix = edge.inlineStyle?.stroke ? `-${markerSuffix(edge.inlineStyle.stroke)}` : ''
  let markers = ''
  if (edge.hasArrowEnd) markers += ` marker-end="url(#arrowhead${suffix})"`
  if (edge.hasArrowStart) markers += ` marker-start="url(#arrowhead-start${suffix})"`

  // Semantic data attributes for edge identification and inspection:
  // - class="edge": CSS targeting and type identification
  // - data-from/data-to: source and target node IDs
  // - data-style: edge style (solid, dotted, thick)
  // - data-arrow-start/end: arrow presence flags
  // - data-label: edge label if present (for quick lookup without traversing DOM)
  const dataAttrs = [
    'class="edge"',
    `data-from="${escapeAttr(edge.source)}"`,
    `data-to="${escapeAttr(edge.target)}"`,
    `data-style="${edge.style}"`,
    `data-arrow-start="${edge.hasArrowStart}"`,
    `data-arrow-end="${edge.hasArrowEnd}"`,
  ]
  if (edge.label) {
    dataAttrs.push(`data-label="${escapeAttr(edge.label)}"`)
  }

  return (
    `<path ${dataAttrs.join(' ')} d="${pathData}" fill="none" stroke="${strokeColor}" ` +
    `stroke-width="${strokeWidth}"${dashArray}${markers} />`
  )
}

/**
 * AXP: edges keep ELK's orthogonal routing but every bend is rounded with a
 * quadratic curve, so a path reads as one drawn line instead of a wire.
 */
function pointsToPolylinePath(points: Point[]): string {
  if (points.length < 2) return ''
  const r = KAWAII.bendRadius
  let d = `M${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!, bend = points[i]!, next = points[i + 1]!
    const inLen = dist(prev, bend), outLen = dist(bend, next)
    const cut = Math.min(r, inLen / 2, outLen / 2)
    if (cut < 0.5) { d += ` L${fmt(bend.x)} ${fmt(bend.y)}`; continue }
    const a = { x: bend.x + ((prev.x - bend.x) / inLen) * cut, y: bend.y + ((prev.y - bend.y) / inLen) * cut }
    const b = { x: bend.x + ((next.x - bend.x) / outLen) * cut, y: bend.y + ((next.y - bend.y) / outLen) * cut }
    d += ` L${fmt(a.x)} ${fmt(a.y)} Q${fmt(bend.x)} ${fmt(bend.y)} ${fmt(b.x)} ${fmt(b.y)}`
  }
  const last = points[points.length - 1]!
  d += ` L${fmt(last.x)} ${fmt(last.y)}`
  return d
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

function renderEdgeLabel(edge: PositionedEdge, font: string): string {
  // Use layout-computed label position when available (layout-aware, avoids collisions).
  // Fall back to geometric midpoint of the edge polyline.
  const mid = edge.labelPosition ?? edgeMidpoint(edge.points)
  const label = edge.label!
  const padding = 8

  // Measure text (works for both single and multi-line)
  const metrics = measureMultilineText(label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel)

  // Wrap in <g class="edge-label"> with reference to the edge it belongs to
  const content = renderMultilineTextWithBackground(
    label,
    mid.x,
    mid.y,
    metrics.width,
    metrics.height,
    FONT_SIZES.edgeLabel,
    padding,
    // Use --_text-sec for better contrast (was --_text-muted)
    `text-anchor="middle" font-size="${FONT_SIZES.edgeLabel}" font-weight="${FONT_WEIGHTS.edgeLabel}" fill="var(--_text-sec)"`,
    // Increased stroke width from 0.5 to 1 for better label separation from edges
    `rx="9" ry="9" fill="var(--bg)" stroke="var(--_inner-stroke)" stroke-width="1"`
  )

  // Semantic wrapper: links label to its edge via data-from/data-to
  return (
    `<g class="edge-label" data-from="${escapeAttr(edge.source)}" data-to="${escapeAttr(edge.target)}" data-label="${escapeAttr(label)}">\n` +
    `  ${content.replace(/\n/g, '\n  ')}\n` +
    `</g>`
  )
}

/** Get the midpoint of a polyline (by walking segments) */
function edgeMidpoint(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]!

  // Calculate total length
  let totalLength = 0
  for (let i = 1; i < points.length; i++) {
    totalLength += dist(points[i - 1]!, points[i]!)
  }

  // Walk to the halfway point
  let remaining = totalLength / 2
  for (let i = 1; i < points.length; i++) {
    const segLen = dist(points[i - 1]!, points[i]!)
    if (remaining <= segLen) {
      const t = remaining / segLen
      return {
        x: points[i - 1]!.x + t * (points[i]!.x - points[i - 1]!.x),
        y: points[i - 1]!.y + t * (points[i]!.y - points[i - 1]!.y),
      }
    }
    remaining -= segLen
  }

  return points[points.length - 1]!
}

function dist(a: Point, b: Point): number {
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
}

// ============================================================================
// Node rendering
// ============================================================================

/**
 * Render a complete node: shape + label wrapped in a semantic <g> element.
 *
 * The group includes data attributes for:
 * - data-id: original Mermaid node ID (for edge matching)
 * - data-label: display label text
 * - data-shape: shape type (rectangle, diamond, circle, etc.)
 */
function renderNode(node: PositionedNode, font: string): string {
  const shape = renderNodeShape(node)
  const label = renderNodeLabel(node, font)

  // Combine shape and label inside a semantic group
  // This enables reliable node identification without heuristics
  const parts: string[] = []
  parts.push(
    `<g class="node" data-id="${escapeAttr(node.id)}" data-label="${escapeAttr(node.label)}" data-shape="${node.shape}">`
  )
  parts.push(`  ${shape.replace(/\n/g, '\n  ')}`)
  if (label) {
    parts.push(`  ${label.replace(/\n/g, '\n  ')}`)
  }
  parts.push('</g>')

  return parts.join('\n')
}

function renderNodeShape(node: PositionedNode): string {
  const { x, y, width, height, shape, inlineStyle } = node

  // Resolve fill and stroke — inline styles (from mermaid `style` directives)
  // override the CSS variable defaults. When no inline style is present, the
  // CSS variable handles theming automatically via color-mix() derivation.
  const fill = escapeAttr(inlineStyle?.fill ?? 'var(--_node-fill)')
  const stroke = escapeAttr(inlineStyle?.stroke ?? 'var(--_node-stroke)')
  const sw = escapeAttr(inlineStyle?.['stroke-width'] ?? String(STROKE_WIDTHS.innerBox))

  switch (shape) {
    case 'diamond':
      return renderDiamond(x, y, width, height, fill, stroke, sw)
    case 'rounded':
      return renderRoundedRect(x, y, width, height, fill, stroke, sw)
    case 'stadium':
      return renderStadium(x, y, width, height, fill, stroke, sw)
    case 'circle':
      return renderCircle(x, y, width, height, fill, stroke, sw)
    case 'subroutine':
      return renderSubroutine(x, y, width, height, fill, stroke, sw)
    case 'doublecircle':
      return renderDoubleCircle(x, y, width, height, fill, stroke, sw)
    case 'hexagon':
      return renderHexagon(x, y, width, height, fill, stroke, sw)
    case 'cylinder':
      return renderCylinder(x, y, width, height, fill, stroke, sw)
    case 'asymmetric':
      return renderAsymmetric(x, y, width, height, fill, stroke, sw)
    case 'trapezoid':
      return renderTrapezoid(x, y, width, height, fill, stroke, sw)
    case 'trapezoid-alt':
      return renderTrapezoidAlt(x, y, width, height, fill, stroke, sw)
    case 'state-start':
      return renderStateStart(x, y, width, height)
    case 'state-end':
      return renderStateEnd(x, y, width, height)
    case 'rectangle':
    default:
      return renderRect(x, y, width, height, fill, stroke, sw)
  }
}

// --- Basic shapes ---

function renderRect(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const r = Math.min(KAWAII.rectRadius, h / 2)
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

function renderRoundedRect(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const r = Math.min(KAWAII.roundedRadius, h / 2)
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

/**
 * AXP: every polygon vertex is rounded with a quadratic curve. The cut is
 * clamped to half the shorter adjacent edge so small shapes stay sane.
 */
function roundedPolygon(points: Point[], radius: number, fill: string, stroke: string, sw: string): string {
  const n = points.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n]!, v = points[i]!, next = points[(i + 1) % n]!
    const inLen = dist(prev, v), outLen = dist(v, next)
    const cut = Math.min(radius, inLen / 2, outLen / 2)
    const a = { x: v.x + ((prev.x - v.x) / inLen) * cut, y: v.y + ((prev.y - v.y) / inLen) * cut }
    const b = { x: v.x + ((next.x - v.x) / outLen) * cut, y: v.y + ((next.y - v.y) / outLen) * cut }
    d += (i === 0 ? `M${fmt(a.x)} ${fmt(a.y)}` : ` L${fmt(a.x)} ${fmt(a.y)}`) + ` Q${fmt(v.x)} ${fmt(v.y)} ${fmt(b.x)} ${fmt(b.y)}`
  }
  return `<path d="${d} Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
}

function renderStadium(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const r = h / 2
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

function renderCircle(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const cx = x + w / 2
  const cy = y + h / 2
  const r = Math.min(w, h) / 2
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

function renderDiamond(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const cx = x + w / 2
  const cy = y + h / 2
  const hw = w / 2
  const hh = h / 2
  return roundedPolygon(
    [
      { x: cx, y: cy - hh }, // top
      { x: cx + hw, y: cy }, // right
      { x: cx, y: cy + hh }, // bottom
      { x: cx - hw, y: cy }, // left
    ],
    KAWAII.polygonRadius * 1.6,
    fill, stroke, sw
  )
}

// --- Batch 1 shapes ---

/** Subroutine: rectangle with double vertical borders on left and right */
function renderSubroutine(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const inset = 8 // distance from edge to inner vertical line
  const r = Math.min(KAWAII.rectRadius, h / 2)
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
    `rx="${r}" ry="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + inset}" y1="${y}" x2="${x + inset}" y2="${y + h}" ` +
    `stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + w - inset}" y1="${y}" x2="${x + w - inset}" y2="${y + h}" ` +
    `stroke="${stroke}" stroke-width="${sw}" />`
  )
}

/** Double circle: two concentric circles with a gap between them */
function renderDoubleCircle(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const cx = x + w / 2
  const cy = y + h / 2
  const outerR = Math.min(w, h) / 2
  const innerR = outerR - 5 // 5px gap between rings
  return (
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<circle cx="${cx}" cy="${cy}" r="${innerR}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

/** Hexagon: 6-point polygon with flat top/bottom and angled sides */
function renderHexagon(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const inset = h / 4 // horizontal inset for the angled sides
  return roundedPolygon(
    [
      { x: x + inset, y: y },
      { x: x + w - inset, y: y },
      { x: x + w, y: y + h / 2 },
      { x: x + w - inset, y: y + h },
      { x: x + inset, y: y + h },
      { x: x, y: y + h / 2 },
    ],
    KAWAII.polygonRadius,
    fill, stroke, sw
  )
}

// --- Batch 2 shapes ---

/** Cylinder / database: top ellipse cap + body rect + bottom ellipse */
function renderCylinder(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const ry = 7 // ellipse vertical radius for the cap
  const cx = x + w / 2
  const bodyTop = y + ry
  const bodyH = h - 2 * ry

  return (
    // Body rectangle (no top border — covered by top ellipse)
    `<rect x="${x}" y="${bodyTop}" width="${w}" height="${bodyH}" ` +
    `fill="${fill}" stroke="none" />` +
    // Left and right body borders
    `\n<line x1="${x}" y1="${bodyTop}" x2="${x}" y2="${bodyTop + bodyH}" stroke="${stroke}" stroke-width="${sw}" />` +
    `\n<line x1="${x + w}" y1="${bodyTop}" x2="${x + w}" y2="${bodyTop + bodyH}" stroke="${stroke}" stroke-width="${sw}" />` +
    // Bottom ellipse (half visible)
    `\n<ellipse cx="${cx}" cy="${y + h - ry}" rx="${w / 2}" ry="${ry}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />` +
    // Top ellipse (full, on top)
    `\n<ellipse cx="${cx}" cy="${bodyTop}" rx="${w / 2}" ry="${ry}" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" />`
  )
}

/** Asymmetric / flag: rectangle with a pointed left edge */
function renderAsymmetric(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const indent = 12 // how far the point indents
  return roundedPolygon(
    [
      { x: x + indent, y: y },
      { x: x + w, y: y },
      { x: x + w, y: y + h },
      { x: x + indent, y: y + h },
      { x: x, y: y + h / 2 },
    ],
    KAWAII.polygonRadius,
    fill, stroke, sw
  )
}

/** Trapezoid [/text\]: wider bottom, narrower top */
function renderTrapezoid(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const inset = w * 0.15 // top edge is narrower by this amount on each side
  return roundedPolygon(
    [
      { x: x + inset, y: y },
      { x: x + w - inset, y: y },
      { x: x + w, y: y + h },
      { x: x, y: y + h },
    ],
    KAWAII.polygonRadius,
    fill, stroke, sw
  )
}

/** Trapezoid-alt [\text/]: wider top, narrower bottom */
function renderTrapezoidAlt(x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: string): string {
  const inset = w * 0.15 // bottom edge is narrower
  return roundedPolygon(
    [
      { x: x, y: y },
      { x: x + w, y: y },
      { x: x + w - inset, y: y + h },
      { x: x + inset, y: y + h },
    ],
    KAWAII.polygonRadius,
    fill, stroke, sw
  )
}

// --- Batch 3: State diagram pseudostates ---

/** State start: small filled circle using primary text color */
function renderStateStart(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2
  const cy = y + h / 2
  const r = Math.min(w, h) / 2 - 2
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--_text)" stroke="none" />`
}

/** State end: bullseye — outer ring + inner filled circle using primary text color */
function renderStateEnd(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2
  const cy = y + h / 2
  const outerR = Math.min(w, h) / 2 - 2
  const innerR = outerR - 4
  return (
    `<circle cx="${cx}" cy="${cy}" r="${outerR}" ` +
    `fill="none" stroke="var(--_text)" stroke-width="${STROKE_WIDTHS.innerBox * 2}" />` +
    `\n<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--_text)" stroke="none" />`
  )
}

// ============================================================================
// Node label rendering
// ============================================================================

function renderNodeLabel(node: PositionedNode, font: string): string {
  // State pseudostates have no label
  if (node.shape === 'state-start' || node.shape === 'state-end') {
    if (!node.label) return ''
  }

  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2

  // Resolve text color — inline styles can override the CSS variable default
  const textColor = escapeAttr(node.inlineStyle?.color ?? 'var(--_text)')

  return renderMultilineText(
    node.label,
    cx,
    cy,
    FONT_SIZES.nodeLabel,
    `text-anchor="middle" font-size="${FONT_SIZES.nodeLabel}" font-weight="${FONT_WEIGHTS.nodeLabel}" fill="${textColor}"`
  )
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Escape a string for use as an XML/HTML attribute value.
 * Escapes quotes and ampersands to prevent attribute injection.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
