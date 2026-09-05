import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AxpClient } from "./client.js";
import type { ExchangeState } from "./protocol/types.js";
import { Worktree } from "./git.js";
import { requireThat, Codes } from "./protocol/errors.js";

/** Run by independently controlled verifier infrastructure. This function
 * checks the exact checkpoint in a separate worktree and records its output.
 * Repository tests are executable code; the caller supplies the sandbox/host. */
export async function verifyCheckpoint(
  client: AxpClient,
  channel: string,
  repository: string,
  command: string[],
  timeoutMs = 120_000,
) {
  requireThat(command[0], Codes.invalid, "Provide a verification command");
  const state = await client.snapshot<ExchangeState>(channel);
  requireThat(state.checkpoint, Codes.conflict, "No checkpoint to verify");
  const checkpoint = state.checkpoint;
  const blob = await client.call("_axp/blobGet", {
    channel,
    digest: checkpoint.bundle.sha256,
  });
  const tree = await Worktree.restore(
    repository,
    `verify-${randomUUID()}`,
    checkpoint,
    Buffer.from(blob.data, "base64"),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("AXP_") || key === "NODE_TEST_CONTEXT") delete env[key];
  let output: string;
  let exitCode: number;
  try {
    const result = await promisify(execFile)(command[0], command.slice(1), {
      cwd: tree.path,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16_000_000,
    });
    output = result.stdout + result.stderr;
    exitCode = 0;
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    exitCode = typeof failure.code === "number" ? failure.code : 1;
    output = `${failure.stdout ?? ""}${failure.stderr ?? ""}\n${failure.message ?? "Verification failed"}`;
  }
  const ref = await client.call("_axp/blobPut", {
    channel,
    data: Buffer.from(output).toString("base64"),
    mediaType: "text/plain",
  });
  await client.call("_axp/verify", {
    channel,
    headCommit: checkpoint.headCommit,
    command,
    exitCode,
    output: ref,
  });
  return {
    headCommit: checkpoint.headCommit,
    exitCode,
    output: ref,
    worktree: tree.path,
  };
}
