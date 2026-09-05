# AXP · Agent Exchange Protocol

Park your agent at an open source repository. A maintainer can steer it, review
tool requests, and follow its work while you keep the session's shared history.

AXP extends [AHP](https://github.com/microsoft/agent-host-protocol) with
contributor-owned executors and uses [ACP](https://agentclientprotocol.com) to
drive local agent processes. The repository host owns the session; the agent
can run on a contributor's machine or on project infrastructure.

Implementation is underway. The [design](docs/design.md) and
[acceptance criteria](docs/acceptance.md) record the intended boundaries.

MIT licensed. Consumer TEE attestation is outside this release.
