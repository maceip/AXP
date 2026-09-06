import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  resolve: {
    alias: {
      // Vendored renderer (ui/vendor/beautiful-mermaid); typed via ui/types.
      "beautiful-mermaid-axp": fileURLToPath(
        new URL("./vendor/beautiful-mermaid/index.ts", import.meta.url),
      ),
    },
  },
  build: { outDir: "../dist/ui", emptyOutDir: true, target: "es2022" },
});
