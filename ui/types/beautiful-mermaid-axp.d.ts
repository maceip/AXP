/* Type boundary for the vendored renderer in ui/vendor/beautiful-mermaid.
 * Vite resolves the same specifier to the TypeScript sources (see
 * ui/vite.config.ts); TypeScript resolves it here, so the workspace's strict
 * settings apply to our code without rewriting upstream's. */
declare module "beautiful-mermaid-axp" {
  export interface RenderOptions {
    bg?: string;
    fg?: string;
    line?: string;
    accent?: string;
    muted?: string;
    surface?: string;
    border?: string;
    font?: string;
    padding?: number;
    nodeSpacing?: number;
    layerSpacing?: number;
    componentSpacing?: number;
    transparent?: boolean;
    interactive?: boolean;
  }
  /** Synchronously render Mermaid text to an SVG string. Throws on parse errors. */
  export function renderMermaidSVG(
    text: string,
    options?: RenderOptions,
  ): string;
}
