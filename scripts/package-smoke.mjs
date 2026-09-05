import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const tarball = (await readdir(".")).find(
  (name) => name.startsWith("maceip-axp-") && name.endsWith(".tgz"),
);
assert.ok(tarball, "Run npm pack first");
const directory = await mkdtemp(join(tmpdir(), "axp-package-"));
try {
  const npmCli =
    process.env.npm_execpath ??
    join(
      dirname(process.execPath),
      process.platform === "win32"
        ? "node_modules/npm/bin/npm-cli.js"
        : "../lib/node_modules/npm/bin/npm-cli.js",
    );
  const installed = spawnSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--ignore-scripts",
      "--prefix",
      directory,
      resolve(tarball),
    ],
    { encoding: "utf8" },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const cli = join(
    directory,
    "node_modules",
    "@maceip",
    "axp",
    "dist",
    "cli.js",
  );
  const help = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    cwd: directory,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /park an agent/);
  const git = spawnSync("git", ["init"], { cwd: directory, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--repo", "test/package"],
    { encoding: "utf8", cwd: directory },
  );
  assert.equal(init.status, 0, init.stderr);
  console.log(
    "Packaged CLI installed, loaded schemas, displayed help and initialized access profiles.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
