import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hub } from "../src/hub.js";
import { AxpClient } from "../src/client.js";
import { channels } from "../src/protocol/types.js";
import type { ExchangeState } from "../src/protocol/types.js";
import { dock, prompt } from "./helpers.js";

test(
  "SIGKILL preserves acknowledged WAL transactions and discards a partial transaction",
  { timeout: 15_000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "axp-crash-"));
    const credentials = ["maintainer", "contributor"].map((role) => ({
      token: randomUUID(),
      principal: {
        id: role,
        role: role as "maintainer" | "contributor",
        sessions: "*" as const,
      },
    }));
    const options = {
      database: join(dir, "hub.db"),
      repository: "crash-test",
      credentials,
    };
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify(options), { mode: 0o600 });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = fork(resolve("test/fixtures/crash-host.ts"), [config], {
      execArgv: [
        "--import",
        pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
      ],
      env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    let restoredHub: Hub | undefined;
    let restoredClient: AxpClient | undefined;
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await restoredClient?.close();
      await restoredHub?.close();
      await rm(dir, { recursive: true, force: true });
    });
    const [started] = (await once(child, "message")) as [{ url: string }];
    assert.throws(() => new Hub(options), /Another AXP host owns/);
    const maintainer = await AxpClient.connect(
      started.url,
      credentials[0]!.token,
    );
    const contributor = await AxpClient.connect(
      started.url,
      credentials[1]!.token,
    );
    const c = channels(randomUUID());
    await maintainer.ahp.request("createSession", {
      channel: c.session,
      provider: "axp",
    });
    const lease = await dock(contributor, c.exchange);
    const turn = prompt();
    await maintainer.dispatch(c.chat, turn);
    const reserve = {
      channel: c.exchange,
      epoch: lease.epoch,
      turnId: turn.turnId,
      ceiling: { tokens: 555, costMicros: 12, turns: 1 },
      operationId: "crash-reserve",
    };
    await contributor.call("_axp/reserve", reserve);
    const reply = once(child, "message");
    child.send("begin-partial");
    await reply;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    await contributor.close();
    await maintainer.close();
    const hub = (restoredHub = new Hub(options));
    const url = await hub.listen();
    const client = (restoredClient = await AxpClient.connect(
      url,
      credentials[1]!.token,
    ));
    const state = await client.snapshot<ExchangeState>(c.exchange);
    assert.equal(state.status, "orphaned");
    assert.equal(state.grants.donation?.spent.tokens, 555);
    assert.equal(state.usage.length, 1);
    await client.call("_axp/reserve", reserve);
    assert.equal(
      (await client.snapshot<ExchangeState>(c.exchange)).reservation,
      null,
    );
    assert.equal(
      hub.store.receipt("crash", "uncommitted", "fingerprint"),
      null,
    );
    await assert.rejects(
      client.call("_axp/renew", { channel: c.exchange, epoch: lease.epoch }),
      /stale/,
    );
  },
);
