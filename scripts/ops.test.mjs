import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { Hub, AxpClient } from "../dist/index.js";
import { health, provision, snapshot } from "./ops.mjs";

test("health rejects an unrelated HTTP 200 and tolerates a transient failure", async (t) => {
  let calls = 0;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        ++calls < 3
          ? { status: "starting" }
          : { status: "ok", protocol: "0.3" },
      ),
    );
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  await assert.rejects(health(url), /health failed/);
  await health(url, 2);
  assert.equal(calls, 3);
});

test("provisioning preserves existing access and creates no shared contributor credential", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "axp-provision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  assert.equal(
    await provision("example/project", config, join(root, "state")),
    true,
  );
  const original = await readFile(join(config, "hub.json"), "utf8");
  assert.equal(
    await provision("example/other", config, join(root, "state")),
    false,
  );
  assert.equal(await readFile(join(config, "hub.json"), "utf8"), original);
  const hub = JSON.parse(original);
  const owner = JSON.parse(
    await readFile(join(config, "maintainer.json"), "utf8"),
  );
  assert.equal(hub.credentials.length, 1);
  assert.equal(hub.credentials[0].token, owner.token);
  assert.equal(hub.host, "127.0.0.1");
  if (process.platform !== "win32")
    assert.equal((await stat(join(config, "hub.json"))).mode & 0o777, 0o600);
});

test(
  "a live WAL snapshot restores AXP sessions and never publishes an incomplete backup",
  {
    skip:
      process.platform === "win32"
        ? "Linux operations use directory fsync"
        : false,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "axp-snapshot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const state = join(root, "state"),
      configDir = join(root, "config"),
      backups = join(root, "backups");
    await mkdir(state);
    await provision("example/project", configDir, state);
    const config = JSON.parse(
      await readFile(join(configDir, "hub.json"), "utf8"),
    );
    const hub = new Hub({ ...config, port: 0 });
    const client = await AxpClient.connect(
      await hub.listen(),
      config.credentials[0].token,
    );
    t.after(async () => {
      await client.close();
      await hub.close();
    });
    const channel = `ahp-session:/${randomUUID()}`;
    await client.ahp.request("createSession", { channel, provider: "axp" });
    assert.ok((await stat(`${config.database}-wal`)).size > 0);
    const saved = await snapshot(state, configDir, backups);
    const manifest = JSON.parse(
      await readFile(join(saved, "manifest.json"), "utf8"),
    );
    for (const file of manifest.files) {
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(saved, file.name)))
          .digest("hex"),
        file.sha256,
      );
      assert.equal((await stat(join(saved, file.name))).mode & 0o777, 0o600);
    }
    await copyFile(join(saved, "hub.db"), join(root, "restored.db"));
    const restored = new Hub({
      ...config,
      port: 0,
      database: join(root, "restored.db"),
    });
    const restoredClient = await AxpClient.connect(
      await restored.listen(),
      config.credentials[0].token,
    );
    try {
      const exported = await restoredClient.call("_axp/export", { channel });
      assert.ok(exported.snapshots.some((s) => s.resource === channel));
    } finally {
      await restoredClient.close();
      await restored.close();
    }
    // A malformed second database must not leave a completed snapshot or prune the
    // previous one. A successful health check alone could not establish this.
    await writeFile(join(state, "aamp.db"), "not sqlite");
    await assert.rejects(snapshot(state, configDir, backups));
    assert.deepEqual(await readdir(backups), [saved.split("/").at(-1)]);
    await rm(join(state, "aamp.db"));
    await writeFile(
      join(configDir, "aamp.json"),
      JSON.stringify({ database: "aamp.db" }),
    );
    await assert.rejects(snapshot(state, configDir, backups), /ENOENT/);
    assert.deepEqual(await readdir(backups), [saved.split("/").at(-1)]);
    const db = new DatabaseSync(join(saved, "hub.db"), { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      db.close();
    }
  },
);
