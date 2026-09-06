import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setup, eventually } from "./helpers.js";
import { faultProxy } from "./fault-proxy.js";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { repository } from "./project-fixture.js";
import { Hub } from "../src/hub.js";
import type { HubOptions } from "../src/hub.js";

test(
  "the parking CLI handles Ctrl-C during retry and removes signal handlers after natural failure",
  { timeout: 10_000 },
  async (t) => {
    const f = await setup();
    const proxy = await faultProxy(f.url);
    proxy.setAvailable(false);
    t.after(async () => {
      await proxy.close();
      await f.close();
    });
    for (const interrupt of [true, false]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AXP_URL: proxy.url,
        AXP_TOKEN: f.credentials[1]!.token,
      };
      delete env.NODE_TEST_CONTEXT;
      const child = fork(
        resolve("test/fixtures/cli-driver.ts"),
        [
          "park",
          f.c.exchange.slice("axp-session:/".length),
          "--native",
          ...(!interrupt ? ["--no-reconnect"] : []),
          "--",
          "unused-agent",
        ],
        {
          execArgv: [
            "--import",
            pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
          ],
          env,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "exit");
          child.kill("SIGKILL");
          await closed;
        }
      });
      let output = "";
      let errors = "";
      child.stdout!.on("data", (data: Buffer) => {
        output += data.toString();
      });
      child.stderr!.on("data", (data: Buffer) => {
        errors += data.toString();
      });
      const report = once(child, "message");
      const exited = once(child, "exit");
      if (interrupt) {
        await eventually(
          () => output,
          (s) => s.includes("Reconnecting"),
        );
        if (process.platform === "win32") child.send("interrupt");
        else child.kill("SIGINT");
      }
      const [result] = (await report) as [
        { before: number[]; after: number[] },
      ];
      const [code, signal] = await exited;
      assert.equal(signal, null, output + errors);
      assert.equal(code, interrupt ? 0 : 1, output + errors);
      assert.deepEqual(
        result.after,
        result.before,
        "CLI signal listeners must not outlive parking",
      );
      if (!interrupt) assert.match(errors, /HTTP 503/);
    }
  },
);

test("CLI errors precede connection setup and failed initialization preserves existing profiles", async (t) => {
  const repo = await repository();
  t.after(() => rm(repo, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.AXP_URL;
  delete env.AXP_TOKEN;
  const cli = (args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
        resolve("src/cli.ts"),
        ...args,
      ],
      { cwd: repo, env },
    );
  await assert.rejects(cli(["nonsense"]), /Unknown command nonsense/);
  await mkdir(join(repo, ".axp"));
  const existing = join(repo, ".axp", "contributor.json");
  await writeFile(existing, "preserve this profile");
  await assert.rejects(cli(["init", "--repo", "test/cli"]), /EEXIST/);
  assert.equal(await readFile(existing, "utf8"), "preserve this profile");
  await assert.rejects(readFile(join(repo, ".axp", "hub.json")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(repo, ".axp", "maintainer.json")), {
    code: "ENOENT",
  });
});

test("--directory selects host configuration and a failed bind releases the database", async (t) => {
  const f = await setup();
  const repo = await repository();
  t.after(async () => {
    await f.close();
    await rm(repo, { recursive: true, force: true });
  });
  const env = { ...process.env };
  delete env.AXP_URL;
  delete env.AXP_TOKEN;
  const cli = (args: string[]) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
        resolve("src/cli.ts"),
        ...args,
        "--directory",
        repo,
      ],
      { cwd: process.cwd(), env, timeout: 5000 },
    );
  await cli(["init", "--repo", "test/cli", "--port", new URL(f.url).port]);
  await assert.rejects(cli(["serve"]), /EADDRINUSE/);
  const options = JSON.parse(
    await readFile(join(repo, ".axp", "hub.json"), "utf8"),
  ) as HubOptions;
  const reopened = new Hub(options);
  await reopened.close();
  await assert.rejects(cli(["init", "--repo", "test/cli", "--port", "0"]));
});

test("an explicit CLI profile overrides ambient credentials and a partial environment fails closed", async (t) => {
  const f = await setup();
  const repo = await repository();
  t.after(async () => {
    await f.close();
    await rm(repo, { recursive: true, force: true });
  });
  const profile = join(repo, "observer.json");
  await writeFile(
    profile,
    JSON.stringify({ url: f.url, token: f.credentials[2]!.token }),
  );
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
        resolve("src/cli.ts"),
        ...args,
      ],
      { cwd: repo, env, timeout: 5000 },
    );
  await assert.rejects(
    cli(
      [
        "prompt",
        f.c.exchange.slice("axp-session:/".length),
        "This must not run as maintainer",
        "--profile",
        profile,
      ],
      { ...process.env, AXP_URL: f.url, AXP_TOKEN: f.credentials[0]!.token },
    ),
    /Only maintainers can do this/,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, AXP_URL: f.url };
  delete env.AXP_TOKEN;
  await assert.rejects(
    cli(["sessions"], env),
    /Set both AXP_URL and AXP_TOKEN/,
  );
});
