import type { Allowance, Grant, Reservation, Usage } from "./protocol/types.js";
import { Codes, requireThat } from "./protocol/errors.js";

export const ZERO: Allowance = { tokens: 0, costMicros: 0, turns: 0 };
export function add(a: Allowance, b: Allowance): Allowance {
  const result = {
    tokens: a.tokens + b.tokens,
    costMicros: a.costMicros + b.costMicros,
    turns: a.turns + b.turns,
  };
  requireThat(
    Object.values(result).every(Number.isSafeInteger),
    Codes.budget,
    "Allowance overflow",
  );
  return result;
}
export function within(value: Allowance, limit: Allowance): boolean {
  return (
    value.tokens <= limit.tokens &&
    value.costMicros <= limit.costMicros &&
    value.turns <= limit.turns
  );
}
export function reserve(grant: Grant, ceiling: Allowance): void {
  requireThat(!grant.revoked, Codes.budget, "Donation revoked");
  requireThat(
    ceiling.turns === 1 && ceiling.tokens > 0,
    Codes.invalid,
    "Reserve exactly one turn and a positive token ceiling",
  );
  requireThat(
    within(add(grant.spent, ceiling), grant.limit),
    Codes.budget,
    "Donation limit reached",
  );
}
export function settle(
  grant: Grant,
  reservation: Reservation,
  reported: Usage | null,
): { grant: Grant; usage: Usage } {
  const usage: Usage = reported ?? {
    inputTokens: reservation.ceiling.tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    costMicros: reservation.ceiling.costMicros,
    source: "reservation",
    costSource: "reservation",
  };
  // Cache reads are a subset of input; they are never charged twice.
  requireThat(
    usage.cacheReadTokens <= usage.inputTokens,
    Codes.invalid,
    "Cache reads exceed input tokens",
  );
  const spent = add(grant.spent, {
    tokens: usage.inputTokens + usage.outputTokens,
    costMicros: usage.costMicros,
    turns: 1,
  });
  // Truthful overspend is recorded, then blocks subsequent work. Rejecting the
  // report would hide the debt and permit repeated attempts with fake numbers.
  return {
    grant: {
      ...grant,
      spent,
      revoked: grant.revoked || !within(spent, grant.limit),
    },
    usage,
  };
}
