# AAMP mailbox adapter

AXP accepts [AAMP 1.1](https://github.com/larksuite/aamp) text tasks into
existing repository sessions. Mail is an asynchronous entry point; the AXP
host still owns admission, history, execution leases, donor budgets, tool
permissions and artifact review. ACP agents parked at those sessions perform
the work. Consumer TEE attestation remains deferred.

## Connect a mailbox

Use an existing AAMP-compatible mailbox with JMAP and authenticated SMTP.
Its service must authenticate senders and prevent forged `From` identities.
A local address allowlist is not a cryptographic proof of who sent a message.
The adapter neither registers accounts nor changes the service's pairing policy.

Create the assigned session and park an agent using the normal
[contribution workflow](../README.md#use-your-own-agent). Save this example as
`.axp/aamp.json`, replacing the example mailbox, endpoints and sender:

```json
{
  "email": "project-agent@example.com",
  "baseUrl": "https://mail.example.com",
  "smtpHost": "smtp.example.com",
  "smtpPort": 587,
  "smtpSecure": false,
  "passwordEnv": "AAMP_MAILBOX_PASSWORD",
  "database": ".axp/aamp.db",
  "routes": [
    {
      "from": "maintainer@example.com",
      "session": "parser-fix",
      "sessionKey": "parser-room",
      "context": { "project": ["your-org/your-project"] }
    }
  ]
}
```

Supply `AAMP_MAILBOX_PASSWORD` through your environment or secret manager, then:

```sh
axp aamp --config .axp/aamp.json --profile .axp/maintainer.json
```

The profile is a local maintainer credential, preferably scoped to these
sessions. It is never sent to the mailbox. The mailbox password is never sent
to AXP. Remote JMAP requires HTTPS; remote SMTP requires STARTTLS or implicit
TLS (`smtpSecure: true`, normally port 465). Discovered JMAP endpoints must
remain on the configured origin. Database paths are relative to the project.

Each dispatch must match exactly one rule: sender, optional `Session-Key`,
and every configured `Dispatch-Context` value. Extra context keys do not grant
access. Overlapping rules are rejected at admission. Mail cannot create or
select arbitrary sessions. Remove or change a rule and restart the adapter
to revoke that route; active work is cancelled and queued output is withheld.

With the reference AAMP SDK, send a task using a new task ID:

```ts
import { AampClient } from "aamp-sdk";

// Use your sender mailbox's normal AampClient configuration.
const sender = new AampClient(senderMailboxConfig);
await sender.sendTask({
  to: "project-agent@example.com",
  taskId: crypto.randomUUID(),
  sessionKey: "parser-room",
  dispatchContext: { project: "your-org/your-project" },
  title: "Fix the parser",
  bodyText: "Reproduce issue 42 and fix it without changing the API.",
});
```

## Task behavior

| AAMP message       | AXP behavior                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task.dispatch`    | Durably admit one text task, then acknowledge it. Queue behind existing work and start one AHP turn when the session is free.                      |
| `task.ack`         | Admission receipt; an executor may still need to be parked.                                                                                        |
| `task.help_needed` | Explain a pending tool permission and identify its AXP session/tool. A maintainer answers through AXP; mail does not approve tools.                |
| `task.cancel`      | Cancel that sender's task, including a queued task. A cancellation received first leaves a tombstone preventing later dispatch.                    |
| `task.result`      | Return completed/rejected status, response text and structured session/turn identifiers. Include the checkpoint produced during that turn, if any. |
| `card.query`       | Return a brief capability description to a locally authorized sender.                                                                              |
| `pair.request`     | Reject with instructions to configure access locally; never widen admission from mail.                                                             |

This adapter's profile maps **one task ID to one AHP turn**. Use a new task ID
for the next turn and retain `Session-Key` for continuity. A repeated task ID
cannot run twice or replace its original instructions/deadline. This profile
does not accept clarification dispatches into an existing task. Cancellation
needs only the original sender and task ID, without repeating routing context.

Expired tasks cannot start after downtime; active expired tasks are cancelled
when the adapter next polls. Cancellation and execution errors use AAMP's
`rejected` terminal status. A completed turn does not mean its changes were
approved, independently verified or merged. Those remain separate AXP records.

Plain-text tasks are limited to 48 KB. Truncated bodies, empty tasks and tasks
with attachments receive a rejection; attachments are never silently omitted
from execution. Results longer than 128,000 characters disclose shortening
and retain the full transcript in AXP. The active queue holds up to 256 tasks.
Unknown intents are inert. Malformed or unauthorized messages produce local
warnings rather than replying to an untrusted sender.

## Durability and delivery

The adapter polls every five seconds. It paginates the complete mailbox on
first connection, so old unexpired tasks can be admitted; use expiry headers
or a dedicated mailbox when establishing the initial route. JMAP cursor
advancement and inbox storage share a SQLite transaction. Expired JMAP state
triggers a full paginated rescan. Mailbox changes during pagination restart
the scan without skipping shifted messages.

The journal deduplicates both mailbox IDs and sender/Message-ID pairs. Stable
task IDs and the host's durable `_axp/dispatch` receipt prevent duplicate
execution when a connection fails after commit. An outgoing journal retains
acknowledgements, help requests and results across restarts. SMTP delivery is
**at least once**: if acceptance succeeds but its reply is lost, the adapter
resends the exact payload with the same Message-ID. Receivers should deduplicate
that ID. No SMTP client can infer exactly-once delivery from a lost reply.

Keep the journal when restarting; do not share it between adapters, mailboxes
or hosts. One process owns its OS-backed database lock. Mail history contains
task text and results and needs the same storage protection as AXP history.
A receive failure postpones that poll's execution and outbound delivery until
the next successful receive; cancellation is checked before reconciliation.

## Embedding and interoperability

`@maceip/axp/aamp` exports `AampBridge`, `JmapSmtpMailbox` and their typed
interfaces. Supply another `AampMailbox` implementation for a different mail
transport; preserve cursor, sender-authentication and stable Message-ID
semantics. `bridge.sync()` performs one bounded pass; `bridge.run(signal)`
supervises polling until cancellation. Listen for `warning` events for
admission and transient transport failures.

The wire implementation follows the pinned
[AAMP 1.1 specification](https://github.com/larksuite/aamp/blob/7fd750875f4da2417672b91aa39eb30d4d7c80d3/docs/AAMP_CORE_SPECIFICATION.md).
Tests build requests and parse replies with the unmodified `aamp-sdk` 0.1.24
wire helpers, exercise real loopback SMTP/JMAP, and drop real committed AHP
replies. The SDK is a development dependency; the runtime uses a small
explicit codec and Nodemailer 10. This avoids the reference client's automatic
acknowledgement before application authorization and in-memory receive cursor.

This is an AAMP ingress adapter, not an AAMP mail service or an outbound
executor/delegation driver. Optional SSE streaming, attachment execution,
dynamic pairing and discovery hosting are not advertised. No live external
mailbox delivery has been verified; transport tests use local servers.
