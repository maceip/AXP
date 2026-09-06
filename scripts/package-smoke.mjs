import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const tarball = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
await access(tarball);
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
  const packaged = JSON.parse(
    await readFile(
      join(directory, "node_modules", "@maceip", "axp", "package.json"),
      "utf8",
    ),
  );
  assert.equal(
    packaged.version,
    manifest.version,
    "Install the current release, even if older tarballs are present",
  );
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
  assert.match(help.stdout, /--no-reconnect/);
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
