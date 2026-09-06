import { randomBytes, createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export async function health(url, attempts = 1) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 30)
    throw new Error("Health attempts must be an integer from 1 to 30");
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      const body = await response.json();
      if (!response.ok || body.status !== "ok" || !body.protocol)
        throw new Error("Unexpected health response");
      return;
    } catch (error) {
      if (attempt === attempts)
        throw new Error(`AXP health failed after ${attempts} attempt(s)`, {
          cause: error,
        });
      await delay(1000);
    }
  }
}

export async function provision(repository, configDirectory, stateDirectory) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
    throw new Error("Repository must be owner/project");
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  const configPath = join(configDirectory, "hub.json");
  try {
    await stat(configPath);
    return false; // Re-running installation must never rotate a live identity.
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  // Write the profile first: a partial install can never leave an undisclosed
  // host credential. Existing files require inspection, not silent replacement.
  await writeFile(
    join(configDirectory, "maintainer.json"),
    JSON.stringify({ url: "wss://axp.computer/axp", token }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    configPath,
    JSON.stringify(
      {
        repository,
        host: "127.0.0.1",
        port: 7331,
        database: join(resolve(stateDirectory), "hub.db"),
        credentials: [
          {
            token,
            principal: { id: "owner", role: "maintainer", sessions: "*" },
          },
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return true;
}

async function sync(path) {
  const file = await open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const snapshotName = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/;

// The caller serializes backups and quiesces AAMP; the host stays online.
export async function snapshot(stateDirectory, configDirectory, destination) {
  const config = JSON.parse(
    await readFile(join(configDirectory, "hub.json"), "utf8"),
  );
  if (resolve(config.database) !== resolve(stateDirectory, "hub.db"))
    throw new Error("Backup expects hub database at STATE/hub.db");
  const configs = await readdir(configDirectory, { withFileTypes: true });
  if (configs.some((entry) => !entry.isFile()))
    throw new Error("Configuration backup requires regular files only");
  if (configs.some((entry) => entry.name === "aamp.json")) {
    const mail = JSON.parse(
      await readFile(join(configDirectory, "aamp.json"), "utf8"),
    );
    if (
      !mail.database ||
      resolve(stateDirectory, mail.database) !==
        resolve(stateDirectory, "aamp.db")
    )
      throw new Error("Backup expects AAMP database at STATE/aamp.db");
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(destination, ".partial-"));
  try {
    const files = [];
    for (const name of ["hub.db", "aamp.db"]) {
      const sourcePath = join(stateDirectory, name);
      try {
        await stat(sourcePath);
      } catch (error) {
        if (name === "aamp.db" && error.code === "ENOENT") continue;
        throw error;
      }
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      try {
        await backup(source, join(temporary, name));
      } finally {
        source.close();
      }
      const check = new DatabaseSync(join(temporary, name));
      try {
        check.exec("PRAGMA journal_mode=DELETE");
        if (check.prepare("PRAGMA quick_check").get().quick_check !== "ok")
          throw new Error(`Backup integrity check failed: ${name}`);
      } finally {
        check.close();
      }
      files.push(name);
    }
    await mkdir(join(temporary, "config"), { mode: 0o700 });
    for (const { name } of configs) {
      await copyFile(
        join(configDirectory, name),
        join(temporary, "config", name),
      );
      files.push(join("config", name));
    }
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      files: [],
    };
    for (const name of files) {
      const path = join(temporary, name);
      await chmod(path, 0o600);
      await sync(path);
      manifest.files.push({ name, sha256: await digest(path) });
    }
    await writeFile(
      join(temporary, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await sync(join(temporary, "manifest.json"));
    await sync(join(temporary, "config"));
    await sync(temporary);
    const name = `${manifest.createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    const published = join(destination, name);
    await rename(temporary, published);
    await sync(destination);
    // Prune only our completed snapshots, after publishing a verified successor.
    const previous = (await readdir(destination, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== name &&
          snapshotName.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const old of previous.slice(6))
      await rm(join(destination, old), { recursive: true });
    return published;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "health" && args.length >= 1 && args.length <= 2) {
      await health(args[0], Number(args[1] ?? 1));
      console.log("AXP host is responsive");
    } else if (command === "provision" && args.length === 3) {
      const created = await provision(...args);
      console.log(
        created ? "Created private owner access" : "Kept existing access",
      );
    } else if (command === "backup" && args.length === 3) {
      console.log(`Verified snapshot: ${await snapshot(...args)}`);
    } else {
      throw new Error(
        "Usage: ops.mjs health URL [ATTEMPTS] | provision OWNER/REPO CONFIG STATE | backup STATE CONFIG DESTINATION",
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
