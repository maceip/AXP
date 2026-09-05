import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import { methods } from "../src/protocol/schema.js";
await mkdir(new URL("../schema", import.meta.url), { recursive: true });
for (const [method, validator] of Object.entries(methods)) {
  const schema = z.toJSONSchema(validator);
  await writeFile(
    new URL(
      `../schema/${method.slice("_axp/".length)}.schema.json`,
      import.meta.url,
    ),
    JSON.stringify({ ...schema, title: method }, null, 2) + "\n",
  );
}
