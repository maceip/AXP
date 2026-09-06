import { z } from "zod";

/** The mailbox service supplies decoded RFC 5322 metadata and plain MIME text. */
export interface AampMail {
  id: string;
  from: string;
  to: string[];
  messageId: string;
  subject: string;
  text: string;
  headers: { name: string; value: string }[];
  attachments: { name: string; size: number }[];
  truncated?: boolean;
}

export const mailboxAddress = z
  .string()
  .max(254)
  .email()
  .transform((s) => s.toLowerCase());
// RFC header values cannot contain line breaks or ASCII control characters.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\x00-\x1f\x7f]/g;
const headerValue = z
  .string()
  .min(1)
  .max(998)
  .refine(
    (value) => value.replace(controlCharacters, "") === value,
    "Invalid header value",
  );
export const AAMP_VERSION = "1.1";

export interface AampRequest {
  intent: "task.dispatch" | "task.cancel" | "card.query" | "pair.request";
  taskId: string;
  from: string;
  messageId: string;
  sessionKey?: string;
  expiresAt?: string;
  context: Record<string, string>;
  title: string;
  text: string;
}

export interface AampReply {
  /** Stable RFC Message-ID, including angle brackets, reused on uncertain delivery. */
  messageId: string;
  to: string;
  taskId: string;
  inReplyTo: string;
  intent:
    | "task.ack"
    | "task.help_needed"
    | "task.result"
    | "card.response"
    | "pair.respond";
  text: string;
  status?: "completed" | "rejected";
  error?: string;
  structuredResult?: {
    fieldKey: string;
    fieldTypeKey: "text";
    value: string;
  }[];
}

/** Unknown intents/extensions are inert. Ambiguous duplicate control headers fail closed. */
export function parseAampMail(
  mail: AampMail,
  recipient: string,
): AampRequest | null {
  if (!mail.to.some((to) => to.toLowerCase() === recipient.toLowerCase()))
    return null;
  const headers = new Map<string, string>();
  const controls = new Set(
    [
      "version",
      "intent",
      "taskid",
      "session-key",
      "expires-at",
      "dispatch-context",
    ].map((name) => `x-aamp-${name}`),
  );
  for (const { name, value } of mail.headers) {
    const key = name.toLowerCase();
    if (!controls.has(key)) continue;
    if (headers.has(key)) throw new Error(`Duplicate AAMP header: ${key}`);
    headers.set(key, value.trim());
  }
  const intent = headers.get("x-aamp-intent");
  if (
    !intent ||
    !["task.dispatch", "task.cancel", "card.query", "pair.request"].includes(
      intent,
    )
  )
    return null;
  if (headers.get("x-aamp-version") !== AAMP_VERSION)
    throw new Error("Unsupported or missing AAMP version");
  const context: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const entry of (headers.get("x-aamp-dispatch-context") ?? "").split(
    ";",
  )) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator).trim();
    if (!/^[a-z0-9_-]+$/.test(key)) continue;
    if (Object.hasOwn(context, key))
      throw new Error("Duplicate dispatch context key");
    try {
      context[key] = decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      throw new Error("Invalid dispatch context encoding");
    }
  }
  const expiresAt = headers.get("x-aamp-expires-at");
  const sessionKey = headers.get("x-aamp-session-key");
  return {
    intent: intent as AampRequest["intent"],
    taskId: headerValue.parse(headers.get("x-aamp-taskid")),
    from: mailboxAddress.parse(mail.from),
    messageId: headerValue.parse(mail.messageId),
    ...(sessionKey ? { sessionKey: headerValue.parse(sessionKey) } : {}),
    ...(expiresAt
      ? { expiresAt: z.iso.datetime({ offset: true }).parse(expiresAt) }
      : {}),
    context,
    title: mail.subject,
    text: mail.text,
  };
}

/** AAMP metadata stays in headers; user-facing content remains ordinary mail text. */
export function aampReplyHeaders(reply: AampReply): Record<string, string> {
  const headers: Record<string, string> = {
    "X-AAMP-Version": AAMP_VERSION,
    "X-AAMP-Intent": reply.intent,
    "X-AAMP-TaskId": headerValue.parse(reply.taskId),
  };
  if (reply.status) headers["X-AAMP-Status"] = reply.status;
  if (reply.error)
    headers["X-AAMP-ErrorMsg"] = reply.error
      .replace(controlCharacters, " ")
      .slice(0, 500);
  if (reply.structuredResult)
    headers["X-AAMP-StructuredResult"] = Buffer.from(
      JSON.stringify(reply.structuredResult),
    ).toString("base64url");
  if (reply.intent === "card.response")
    headers["X-AAMP-Card-Summary"] =
      "AXP: durable repository sessions, ACP execution, and reviewed Git checkpoints";
  if (reply.intent === "task.help_needed")
    headers["X-AAMP-SuggestedOptions"] = "Review in AXP|Cancel task";
  return headers;
}
