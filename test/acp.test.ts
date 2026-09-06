import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpDriver, normalizeUsage } from "../src/acp.js";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const callbacks = {
  emit: async () => {},
  blob: async () => {
    throw new Error("Unexpected blob");
  },
  permission: async () => null,
};
test("ACP usage normalization preserves provider totals across cache conventions and rejects inconsistent telemetry", () => {
  const inclusive = {
    totalTokens: 130,
    inputTokens: 100,
    outputTokens: 30,
    cachedReadTokens: 80,
  };
  const exclusive = { ...inclusive, inputTokens: 20 };
  assert.deepEqual(normalizeUsage(inclusive, 1), normalizeUsage(exclusive, 1));
  assert.equal(normalizeUsage(exclusive, 1)?.inputTokens, 100);
  assert.equal(normalizeUsage({ ...exclusive, totalTokens: 999 }, 1), null);
  assert.equal(normalizeUsage({ ...exclusive, inputTokens: -1 }, 1), null);
});
test("explicit ACP authentication precedes session creation and never substitutes an unadvertised method", async () => {
  const launch = {
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
      resolve("examples/fixture-agent.ts"),
      "--require-auth",
    ],
    isolation: "native" as const,
    authMethod: "fixture-key",
    env: { FIXTURE_PROVIDER_KEY: "local-only" },
  };
  const driver = new AcpDriver(launch, process.cwd(), callbacks);
  await driver.start();
  await driver.close();
  const wrong = new AcpDriver(
    { ...launch, authMethod: "unadvertised" },
    process.cwd(),
    callbacks,
  );
  await assert.rejects(wrong.start(), /did not advertise/);
  await wrong.close();
});
test(
  "an absent ACP executable fails and can be closed repeatedly without hanging",
  { timeout: 3000 },
  async () => {
    const driver = new AcpDriver(
      { command: "axp-no-such-executable-98254", isolation: "native" },
      process.cwd(),
      callbacks,
    );
    await assert.rejects(driver.start(), /ENOENT/);
    await Promise.all([driver.close(), driver.close()]);
  },
);

test(
  "an oversized unterminated ACP frame closes the stream and process",
  { timeout: 5000 },
  async () => {
    const driver = new AcpDriver(
      {
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write('x'.repeat(2000001)); setInterval(()=>{},1000)",
        ],
        isolation: "native",
      },
      process.cwd(),
      callbacks,
    );
    try {
      await assert.rejects(driver.start());
    } finally {
      await driver.close();
    }
  },
);

test(
  "native cleanup stops a SIGTERM-resistant descendant even after the ACP leader has exited",
  { skip: process.platform === "win32", timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "axp-descendant-"));
    const counter = join(directory, "pulse");
    const pidFile = join(directory, "pid");
    const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(process.argv[1], 'ready'); setInterval(()=>fs.appendFileSync(process.argv[1], '.'),20);`;
    const leader = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'}); fs.writeFileSync(process.argv[3],String(c.pid)); const ready=setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},5);`;
    const driver = new AcpDriver(
      {
        command: process.execPath,
        args: ["-e", leader, descendant, counter, pidFile],
        isolation: "native",
      },
      directory,
      callbacks,
    );
    t.after(async () => {
      await driver.close();
      const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await rm(directory, { recursive: true, force: true });
    });
    await assert.rejects(driver.start());
    await driver.close();
    await delay(50);
    const before = await readFile(counter, "utf8");
    await delay(100);
    assert.equal(
      await readFile(counter, "utf8"),
      before,
      "descendant kept executing after the driver closed",
    );
  },
);
