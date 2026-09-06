import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Include the license texts of the UI dependencies and their runtime dependency graph.
const roots = [
  "react",
  "react-dom",
  "lucide-react",
  "@pierre/diffs",
  "@pierre/trees",
  "react-markdown",
  "remark-gfm",
  "@fontsource-variable/dm-sans",
  "@fontsource/ibm-plex-mono",
];
const packages = new Map();
async function visit(name, parent = process.cwd()) {
  let current = parent,
    directory,
    manifest;
  while (true) {
    directory = join(current, "node_modules", name);
    try {
      manifest = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = dirname(current);
    if (next === current) throw new Error(`Missing bundled dependency ${name}`);
    current = next;
  }
  if (packages.has(directory)) return;
  const files = (await readdir(directory))
    .filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
    .sort();
  let texts = await Promise.all(
    files.map((file) => readFile(join(directory, file), "utf8")),
  );
  if (!files.some((file) => /^(licen[cs]e|copying)(\.|$)/i.test(file))) {
    const readme = await readFile(join(directory, "README.md"), "utf8").catch(
      () => "",
    );
    const start = readme.search(/^#+ MIT licen[cs]e\s*$/im);
    if (
      start < 0 ||
      !readme.slice(start).includes("Permission is hereby granted")
    )
      throw new Error(`Missing license text for ${name}`);
    texts = [readme.slice(start)];
  }
  packages.set(directory, {
    name: manifest.name,
    text: `${manifest.name} ${manifest.version}\nLicense: ${manifest.license}\n\n${texts.join("\n\n")}`,
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort())
    await visit(dependency, directory);
}
for (const name of roots) await visit(name);
await mkdir(resolve("dist/ui/licenses"), { recursive: true });
await writeFile(
  resolve("dist/ui/licenses/bundled.txt"),
  [...packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => item.text)
    .join("\n\n========================================\n\n"),
);
console.log(`Included license texts for ${packages.size} bundled UI packages.`);
