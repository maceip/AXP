/* Colours for diagrams rendered in the workspace. Values are literal rather
 * than var() references because the same theme is used to render review
 * samples outside the browser (scripts/design/render-diagrams.ts). They mirror
 * the Huabu-derived tokens in ui/src/vendor/huabu/tokens.css. */
export const AXP_DIAGRAM_COLORS = {
  bg: "#f6f7f4",
  fg: "#252c28",
  line: "#8aa392",
  accent: "#397452",
  muted: "#626b65",
  surface: "#ffffff",
  border: "#cfd9cc",
} as const;
