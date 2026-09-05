import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as ahp from "@microsoft/agent-host-protocol";

const reducers = {
  root: ahp.rootReducer,
  session: ahp.sessionReducer,
  chat: ahp.chatReducer,
  changeset: ahp.changesetReducer,
  terminal: ahp.terminalReducer,
  annotations: ahp.annotationsReducer,
  resourceWatch: ahp.resourceWatchReducer,
  automation: ahp.automationReducer,
  automationRun: ahp.automationRunReducer,
};
function normalize(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as object).map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
const directory = new URL("./upstream/reducers/", import.meta.url);
for (const name of readdirSync(directory)
  .filter((n) => n.endsWith(".json"))
  .sort()) {
  const fixture = normalize(
    JSON.parse(readFileSync(new URL(name, directory), "utf8")),
  ) as {
    description: string;
    reducer: keyof typeof reducers;
    initial: unknown;
    actions: unknown[];
    expected: unknown;
  };
  test(`AHP 0.9.0: ${fixture.description}`, () => {
    // Each cross-language fixture selects its own reducer and discriminated
    // state type. The cast is confined to this generic conformance harness.
    const reducer = reducers[fixture.reducer] as (
      state: unknown,
      action: unknown,
    ) => unknown;
    assert.deepEqual(
      fixture.actions.reduce(
        (state, action) => reducer(state, action),
        fixture.initial,
      ),
      fixture.expected,
    );
  });
}
