// Run only inside test/fixtures/linux.Dockerfile's disposable systemd container.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AxpClient } from "../dist/index.js";
import { health } from "./ops.mjs";

assert.equal(
  process.env.container,
  "docker",
  "Use the disposable Linux fixture",
);
const run = (file, args) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const systemctl = (...args) => run("systemctl", args);
const pid = () =>
  systemctl("show", "axp-host.service", "--property=MainPID", "--value").trim();
async function waitForRestart(previous) {
  for (let i = 0; i < 90; i++) {
    if (pid() !== previous && pid() !== "0") {
      try {
        await health("http://127.0.0.1:7331/healthz");
        return;
      } catch {
        /* restart/startup is still in progress */
      }
    }
    await delay(1000);
  }
  throw new Error("AXP did not recover within 90 seconds");
}

let proxy;
try {
  run("shellcheck", ["deploy/linux/install.sh", "deploy/linux/backup.sh"]);
  run("bash", ["deploy/linux/install.sh", process.cwd(), "test/linux"]);
  const original = await readFile("/etc/axp/hub.json", "utf8");
  run("bash", ["deploy/linux/install.sh", process.cwd(), "test/linux"]);
  assert.equal(await readFile("/etc/axp/hub.json", "utf8"), original);
  systemctl("enable", "--now", "axp-host.service");
  assert.equal(systemctl("is-enabled", "axp-host.service").trim(), "enabled");
  const token = JSON.parse(original).credentials[0].token;
  run("caddy", [
    "validate",
    "--config",
    "deploy/linux/Caddyfile",
    "--adapter",
    "caddyfile",
  ]);
  // Use the actual site's routing, but local plaintext endpoints in this fixture.
  const fragment = (await readFile("deploy/linux/Caddyfile", "utf8"))
    .replace("axp.computer {", "http://127.0.0.1:7443 {")
    .replace("www.axp.computer {", "http://127.0.0.1:7444 {")
    .replace(/\n\ttls \{\n\t\tissuer acme \{[\s\S]*?\n\t\t\}\n\t\}/g, "");
  await writeFile("/run/axp-proxy.caddy", `{\n admin off\n}\n${fragment}`);
  proxy = spawn(
    "caddy",
    ["run", "--config", "/run/axp-proxy.caddy", "--adapter", "caddyfile"],
    { stdio: "ignore" },
  );
  await health("http://127.0.0.1:7443/healthz", 10);
  const redirect = await fetch("http://127.0.0.1:7444/example?x=1", {
    redirect: "manual",
  });
  assert.equal(redirect.status, 308);
  assert.equal(
    redirect.headers.get("location"),
    "https://axp.computer/example?x=1",
  );
  await assert.rejects(
    AxpClient.connect(
      "ws://127.0.0.1:7443/axp",
      "invalid-token-at-least-24-characters",
    ),
  );
  const client = await AxpClient.connect("ws://127.0.0.1:7443/axp", token);
  const channel = `ahp-session:/${randomUUID()}`;
  await client.ahp.request("createSession", { channel, provider: "axp" });
  await client.close();
  let previous = pid();
  systemctl("kill", "--kill-who=main", "--signal=SIGKILL", "axp-host.service");
  await waitForRestart(previous);
  const recovered = await AxpClient.connect("ws://127.0.0.1:7443/axp", token);
  try {
    const history = await recovered.call("_axp/export", { channel });
    assert.ok(
      history.snapshots.some((snapshot) => snapshot.resource === channel),
    );
  } finally {
    await recovered.close();
  }
  console.log(
    "Crash recovery retained authenticated session history through Caddy",
  );
  previous = pid();
  systemctl("kill", "--kill-who=main", "--signal=SIGSTOP", "axp-host.service");
  try {
    systemctl("start", "axp-health.service");
  } catch {
    /* expected failed probe */
  }
  await waitForRestart(previous);
  console.log("Health supervision recovered a hung process");
  const journalProbe = (value) =>
    run("runuser", [
      "-u",
      "axp",
      "--",
      "node",
      "--input-type=module",
      "-e",
      `import { AampJournal } from '/opt/axp/current/dist/aamp/journal.js';
       const journal = new AampJournal('/var/lib/axp/aamp.db');
       journal.set('probe', '${value}'); journal.close();`,
    ]);
  journalProbe("before-backup");
  systemctl("start", "axp-backup.service");
  journalProbe("after-backup");
  const backups = (await readdir("/var/backups/axp")).filter(
    (name) => !name.startsWith("."),
  );
  assert.equal(backups.length, 1);
  await readFile(`/var/backups/axp/${backups[0]}/manifest.json`);
  await health("http://127.0.0.1:7443/healthz");
  systemctl("stop", "axp-host.service");
  systemctl("start", "axp-health.service");
  assert.equal(pid(), "0", "Intentional stop must stay stopped");
  systemctl("start", "axp-backup.service");
  systemctl("start", "axp-host.service");
  await health("http://127.0.0.1:7331/healthz", 3);
  console.log(
    "Online/offline backups preserve service-user access; deliberate stop stayed stopped",
  );
} catch (error) {
  console.error(error.message);
  console.error(run("journalctl", ["--no-pager", "-n", "100"]).trim());
  throw error;
} finally {
  proxy?.kill("SIGTERM");
}
