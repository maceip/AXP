import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  realpath,
  appendFile,
  writeFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ChangesetFile } from "@microsoft/agent-host-protocol";
import type { AxpClient } from "./client.js";
import type { Checkpoint, Review, BlobRef } from "./protocol/types.js";
import { id, sha } from "./protocol/schema.js";
import { Codes, requireThat } from "./protocol/errors.js";
import { hash, verifyObject } from "./hash.js";

const execute = promisify(execFile);
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") || key.startsWith("AXP_")) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
}
async function git(
  cwd: string,
  args: string[],
  maxBuffer = 16_000_000,
): Promise<string> {
  const result = await execute(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer,
      timeout: 120_000,
      env: gitEnvironment(),
    },
  );
  return result.stdout;
}

/** Keep local credentials, worktrees and history out of ordinary git add. */
export async function excludeLocalState(repository: string): Promise<void> {
  const location = (
    await git(repository, ["rev-parse", "--git-path", "info/exclude"])
  ).trim();
  const path = resolve(repository, location);
  const existing = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (!existing.split(/\r?\n/).includes("/.axp/"))
    await appendFile(path, "\n# AXP local state\n/.axp/\n", { mode: 0o600 });
}

export class Worktree {
  private constructor(
    readonly repository: string,
    readonly path: string,
    readonly branch: string,
    readonly baseCommit: string,
  ) {}
  static async create(
    repository: string,
    sessionId: string,
    base = "HEAD",
  ): Promise<Worktree> {
    id.parse(sessionId);
    const repo = await realpath(repository);
    await excludeLocalState(repo);
    const top = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
    requireThat(
      (await realpath(top)) === repo,
      Codes.invalid,
      "Pass the repository root",
    );
    const commit = (
      await git(repo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${base}^{commit}`,
      ])
    ).trim();
    sha.parse(commit);
    const branch = `axp/${sessionId}`;
    const path = join(repo, ".axp", "worktrees", sessionId);
    await mkdir(join(repo, ".axp", "worktrees"), {
      recursive: true,
      mode: 0o700,
    });
    // Existing work is never overwritten or silently resumed under another task.
    await git(repo, ["worktree", "add", "-b", branch, path, commit]);
    return new Worktree(repo, path, branch, commit);
  }
  async checkpoint(
    client: AxpClient,
    channel: string,
    epoch: number,
    message = "AXP contribution checkpoint",
  ): Promise<Checkpoint> {
    await git(this.path, ["add", "--all"]);
    const staged = await git(this.path, ["diff", "--cached", "--name-only"]);
    if (staged.trim())
      await git(this.path, [
        "-c",
        "user.name=AXP Contributor",
        "-c",
        "user.email=axp@localhost",
        "commit",
        "-m",
        message,
      ]);
    const headCommit = (await git(this.path, ["rev-parse", "HEAD"])).trim();
    const scratch = await mkdtemp(join(tmpdir(), "axp-checkpoint-"));
    try {
      const bundlePath = join(scratch, "checkpoint.bundle");
      await git(this.path, [
        "bundle",
        "create",
        bundlePath,
        ...(headCommit === this.baseCommit
          ? [this.branch, "--max-count=1"]
          : [`${this.baseCommit}..${this.branch}`]),
      ]);
      const patch = await git(this.path, [
        "diff",
        "--binary",
        "--no-ext-diff",
        this.baseCommit,
        headCommit,
        "--",
      ]);
      const upload = (data: Uint8Array, mediaType: string) =>
        client.call("_axp/blobPut", {
          channel,
          data: Buffer.from(data).toString("base64"),
          mediaType,
        });
      const bundle = await upload(
        await readFile(bundlePath),
        "application/x-git-bundle",
      );
      const patchRef = await upload(Buffer.from(patch), "text/x-diff");
      const names = (
        await git(this.path, [
          "diff",
          "--name-only",
          "-z",
          this.baseCommit,
          headCommit,
          "--",
        ])
      )
        .split("\0")
        .filter(Boolean);
      const files: ChangesetFile[] = [];
      for (const name of names) {
        // git's object database provides exact bytes, including deleted files;
        // no symlink-following filesystem reads are necessary here.
        const parts: {
          before?: { uri: string; content: BlobRef };
          after?: { uri: string; content: BlobRef };
        } = {};
        for (const [key, commit] of [
          ["before", this.baseCommit],
          ["after", headCommit],
        ] as const) {
          try {
            const { stdout } = await execute(
              "git",
              ["show", `${commit}:${name}`],
              {
                cwd: this.path,
                encoding: "buffer",
                maxBuffer: 16_000_000,
                timeout: 30_000,
                env: gitEnvironment(),
              },
            );
            const content = await upload(stdout, "application/octet-stream");
            parts[key] = {
              uri: `axp-file:/${encodeURIComponent(channel)}/${encodeURIComponent(name)}`,
              content,
            };
          } catch (error) {
            // Only a genuinely missing path is an absent before/after side.
            const found = await git(this.path, [
              "ls-tree",
              "-z",
              commit,
              "--",
              name,
            ]);
            if (found) throw error;
          }
        }
        files.push({ id: name, edit: parts });
      }
      const checkpoint: Checkpoint = {
        baseCommit: this.baseCommit,
        headCommit,
        branch: this.branch,
        bundle,
        patch: patchRef,
        createdAt: Date.now(),
      };
      await client.call("_axp/checkpoint", {
        channel,
        epoch,
        checkpoint,
        files,
      });
      return checkpoint;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  static async restore(
    repository: string,
    sessionId: string,
    checkpoint: Checkpoint,
    bundle: Uint8Array,
  ): Promise<Worktree> {
    id.parse(sessionId);
    sha.parse(checkpoint.baseCommit);
    sha.parse(checkpoint.headCommit);
    requireThat(
      hash(bundle) === checkpoint.bundle.sha256,
      Codes.invalid,
      "Bundle digest mismatch",
    );
    const scratch = await mkdtemp(join(tmpdir(), "axp-restore-"));
    try {
      const path = join(scratch, "checkpoint.bundle");
      await writeFile(path, bundle, { mode: 0o600 });
      await git(repository, ["bundle", "verify", path]);
      const advertised = await git(repository, ["bundle", "list-heads", path]);
      requireThat(
        advertised
          .split("\n")
          .some((line) => line.startsWith(`${checkpoint.headCommit} `)),
        Codes.invalid,
        "Bundle does not advertise the checkpoint commit",
      );
      await git(repository, ["bundle", "unbundle", path]);
      await git(repository, [
        "merge-base",
        "--is-ancestor",
        checkpoint.baseCommit,
        checkpoint.headCommit,
      ]);
      const tree = await Worktree.create(
        repository,
        sessionId,
        checkpoint.headCommit,
      );
      return new Worktree(
        tree.repository,
        tree.path,
        tree.branch,
        checkpoint.baseCommit,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  async publish(remote: string, review: Review): Promise<void> {
    requireThat(
      review.maintainer &&
        review.maintainer.publicKey !== review.contributor.publicKey &&
        verifyObject(review.manifest, review.contributor) &&
        verifyObject(review.manifest, review.maintainer),
      Codes.forbidden,
      "Both contributor and maintainer must sign the manifest before publication",
    );
    const head = (await git(this.path, ["rev-parse", "HEAD"])).trim();
    requireThat(
      head === review.manifest.headCommit &&
        this.baseCommit === review.manifest.baseCommit,
      Codes.conflict,
      "Reviewed commit differs from the worktree",
    );
    // Destination is local contributor configuration; the remote host cannot
    // choose where credentials or source are sent. Never push an upstream main.
    requireThat(
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote),
      Codes.invalid,
      "Use a configured contributor-fork remote name",
    );
    await git(this.path, ["push", remote, `${head}:refs/heads/${this.branch}`]);
  }
  async remove(): Promise<void> {
    requireThat(
      !(await git(this.path, ["status", "--porcelain"])).trim(),
      Codes.conflict,
      "Worktree has uncommitted changes; preserve it",
    );
    await git(this.repository, ["worktree", "remove", this.path]);
  }
}
