import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpDriver, normalizeUsage } from "../src/acp.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
