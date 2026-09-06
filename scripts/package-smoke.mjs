import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
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
  const packageRoot = join(directory, "node_modules", "@maceip", "axp");
  await access(join(packageRoot, "deploy/linux/axp-host.service"));
  await access(join(packageRoot, "scripts/ops.mjs"));
  assert.ok(
    !(await readdir(join(packageRoot, "docs"))).some((name) =>
      name.startsWith("DOMAIN-DEPLOYMENT-HANDOFF-"),
    ),
    "Private deployment coordination must not enter the published package",
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
  assert.match(help.stdout, /shared repository sessions for coding agents/);
  assert.match(help.stdout, /--no-reconnect/);
  assert.match(help.stdout, /aamp --config/);
  const version = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    cwd: directory,
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `AXP ${manifest.version}`);
  const adapter = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { AampBridge, JmapSmtpMailbox } from '@maceip/axp/aamp'; if (!AampBridge || !JmapSmtpMailbox) process.exit(1)",
    ],
    { encoding: "utf8", cwd: directory },
  );
  assert.equal(adapter.status, 0, adapter.stderr);
  await assert.rejects(access(join(directory, "node_modules", "aamp-sdk")), {
    code: "ENOENT",
  });
  const git = spawnSync("git", ["init"], { cwd: directory, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const init = spawnSync(
    process.execPath,
    [cli, "init", "--repo", "test/package"],
    { encoding: "utf8", cwd: directory },
  );
  assert.equal(init.status, 0, init.stderr);
  const { Hub, WorkspaceServer } = await import(
    pathToFileURL(join(dirname(cli), "index.js")).href
  );
  const token = randomBytes(32).toString("hex");
  const hub = new Hub({
    repository: "test/package",
    credentials: [
      {
        token,
        principal: { id: "package-user", role: "maintainer", sessions: "*" },
      },
    ],
  });
  let workspace;
  try {
    workspace = new WorkspaceServer({ url: await hub.listen(), token });
    const link = new URL(await workspace.listen());
    const html = await (await fetch(link.origin)).text();
    assert.match(html, /Contribution workspace/);
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(asset, "The installed package includes its UI entrypoint");
    assert.equal((await fetch(`${link.origin}${asset}`)).status, 200);
    assert.match(
      await (await fetch(`${link.origin}/licenses/bundled.txt`)).text(),
      /react/,
    );
    const response = await fetch(`${link.origin}/api/workspace`, {
      headers: {
        authorization: `Bearer ${new URLSearchParams(link.hash.slice(1)).get("access")}`,
      },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).repository, "test/package");
  } finally {
    await workspace?.close();
    await hub.close();
  }
  console.log(
    "Package smoke test passed: CLI, AAMP import, profiles, and workspace assets/API.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
