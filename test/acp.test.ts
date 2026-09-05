import { test } from "node:test";
import assert from "node:assert/strict";
import { AcpDriver } from "../src/acp.js";

const callbacks = {
  emit: async () => {},
  blob: async () => {
    throw new Error("Unexpected blob");
  },
  permission: async () => null,
};
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
