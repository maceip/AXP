import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hub } from "../src/hub.js";
import type { HubOptions } from "../src/hub.js";
import { AxpClient } from "../src/client.js";
import { channels } from "../src/protocol/types.js";
import { ActionType, MessageKind } from "@microsoft/agent-host-protocol";

export async function setup(overrides: Partial<HubOptions> = {}) {
  const credentials = ["maintainer", "contributor", "observer", "verifier"].map(
    (role) => ({
      token: randomBytes(32).toString("hex"),
      principal: {
        id: role,
        role: role as "maintainer" | "contributor" | "observer" | "verifier",
        sessions: "*" as const,
      },
    }),
  );
  const hub = new Hub({
    repository: "example/project",
    credentials,
    ...overrides,
  });
  const url = await hub.listen();
  const clients = await Promise.all(
    credentials.map((c) => AxpClient.connect(url, c.token)),
  );
  const [maintainer, contributor, observer, verifier] = clients as [
    AxpClient,
    AxpClient,
    AxpClient,
    AxpClient,
  ];
  const c = channels(randomUUID());
  await maintainer.ahp.request("createSession", {
    channel: c.session,
    provider: "axp",
  });
  const close = async () => {
    await Promise.all(clients.map((c) => c.close()));
    await hub.close();
  };
  return {
    hub,
    url,
    credentials,
    clients,
    maintainer,
    contributor,
    observer,
    verifier,
    c,
    close,
  };
}
export async function dock(
  client: AxpClient,
  channel: string,
  leaseMs = 30_000,
) {
  await client.call("_axp/grant", {
    channel,
    grantId: "donation",
    limit: { tokens: 100_000, costMicros: 1_000_000, turns: 10 },
    enforcement: "accounting",
  });
  return client.call("_axp/claim", {
    channel,
    grantId: "donation",
    executorId: "test-agent",
    leaseMs,
  });
}
export function prompt(text = "Hello", turnId = randomUUID()) {
  return {
    type: ActionType.ChatTurnStarted,
    turnId,
    startedAt: new Date().toISOString(),
    message: { text, origin: { kind: MessageKind.User } },
  } as const;
}
export async function eventually<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(`Condition not reached: ${JSON.stringify(value)}`);
}
