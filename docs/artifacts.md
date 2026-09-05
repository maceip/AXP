# Artifact review and independent verification

Satellites commit locally and upload a Git bundle relative to the original
base plus a binary-safe patch. AHP changesets include before/after content
references. AXP records exact base/head commits, branch and blob digests.
These remain contributor claims until independently verified.

`Worktree.restore` verifies bundle digest, Git prerequisites, advertised head
and base ancestry before creating a new worktree. Missing bases fail explicitly;
the host never fetches an executor-selected remote. Periodic checkpoints do
not create upstream remote branches.

Submit with a contributor signing key:

```sh
axp keygen --out .axp/contributor-key.pem
axp submit parser-fix --profile .axp/contributor.json \
  --key .axp/contributor-key.pem --model YOUR_MODEL_ID
```

The manifest binds repository, session, base/head, model declaration, observed
prompt-context hash, trace cursor/hash and checkpoint digest. The model and
prompt provenance are self-reported; this is not a hash of a provider's private
system prompt. Ed25519 keys bind on first use to authenticated principals.
Signatures prove authorship of claims, not runtime honesty or legal provenance.

After examining the artifact, a maintainer countersigns with a separate key:

```sh
axp keygen --out .axp/maintainer-key.pem
axp accept parser-fix --key .axp/maintainer-key.pem
```

Verification uses a distinct role on independently controlled infrastructure:

```sh
axp verify parser-fix --profile .axp/verifier.json \
  --directory /path/to/verification-clone --native -- node --test
```

This restores the exact checkpoint, runs the command and records exit code and
content-addressed output. Use an isolated verifier: repository tests execute
code. SDK `verifyCheckpoint` performs the same operation. Stale-head results
and contributor attempts to write authoritative verifier records are rejected.

A changed checkpoint invalidates review and verification. Explicit SDK
publication, `worktree.publish('contributor-fork', review)`, requires two valid
signatures and the reviewed local head. It pushes an `axp/` branch to a locally
configured remote. The CLI provides the same path by restoring the reviewed
bundle in a new local worktree:

```sh
axp publish parser-fix --profile .axp/contributor.json --remote contributor-fork
```

It never merges, force-pushes or lets remote task text choose
the destination. PR creation and merging remain normal forge workflows.

Consumer TEE is deferred. Passing tests support tested behavior at a specific
commit, not complete correctness or execution-environment integrity.
