import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function repository() {
  const path = await mkdtemp(join(tmpdir(), "axp-project-"));
  await exec("git", ["init", "-b", "main", path]);
  await writeFile(join(path, "package.json"), '{"type":"module"}');
  await writeFile(join(path, ".gitignore"), ".axp/\n");
  await writeFile(
    join(path, "sum.js"),
    "export const sum = (a, b) => a - b;\n",
  );
  await writeFile(
    join(path, "sum.test.js"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('adds two numbers', () => assert.equal(sum(2, 3), 5));\n",
  );
  await exec("git", ["add", "."], { cwd: path });
  await exec(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Failing addition",
    ],
    { cwd: path },
  );
  return path;
}
