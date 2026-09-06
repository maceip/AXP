import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { ActionType } from "@microsoft/agent-host-protocol";
import { actionFrom } from "../src/validation.js";
import { Store } from "../src/store.js";
import { Sessions } from "../src/sessions.js";

// Deliberately narrow CPU measurements, not a host capacity or network benchmark.
function measure(name: string, iterations: number, run: () => void) {
  for (let i = 0; i < iterations; i++) run();
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return {
    name,
    iterations,
    medianMs: samples[3],
    minMs: samples[0],
    maxMs: samples[6],
  };
}
const action = {
  type: ActionType.ChatDelta,
  turnId: "turn",
  partId: "part",
  content: "hello",
};
const validation = measure("validate chat delta", 20_000, () =>
  actionFrom(action),
);
const store = new Store();
try {
  const sessions = new Sessions(store, "benchmark/fixture");
  const actor = { id: "owner", role: "maintainer", sessions: "*" } as const;
  for (let i = 0; i < 1000; i++) {
    store.transaction((tx) =>
      sessions.create(tx, actor, `ahp-session:/s-${i}`, "Idle", String(i)),
    );
  }
  const expiry = measure("idle expiry tick with 1000 sessions", 100, () =>
    store.transaction((tx) => sessions.tick(tx)),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        storage: "in-memory SQLite",
        results: [validation, expiry],
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
