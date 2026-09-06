/* Render the sample diagrams in docs/design/diagrams/*.mmd to SVG with the AXP
 * palette, so the kawaii treatment can be reviewed without running the app.
 *
 *   npx tsx scripts/design/render-diagrams.mts
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderMermaidSVG } from "../../ui/vendor/beautiful-mermaid/index.ts";
import { AXP_DIAGRAM_COLORS } from "../../ui/src/diagram-theme.ts";

const dir = join(import.meta.dirname, "../../docs/design/diagrams");
const files = (await readdir(dir)).filter((f) => f.endsWith(".mmd")).sort();
for (const file of files) {
  const source = await readFile(join(dir, file), "utf8");
  const svg = renderMermaidSVG(source, {
    ...AXP_DIAGRAM_COLORS,
    font: "AXP Runde",
    transparent: true,
  });
  const out = join(dir, file.replace(/\.mmd$/, ".svg"));
  await writeFile(out, svg);
  console.log(`${file} → ${out.split("/").at(-1)} (${svg.length} bytes)`);
}
