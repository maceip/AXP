import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setup, eventually } from "./helpers.js";
import { faultProxy } from "./fault-proxy.js";

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
          (s) => s.includes("reconnecting"),
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
