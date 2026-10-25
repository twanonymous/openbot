// A plan limit that resets must not start every held agent in the same second: each cold resume reads a
// whole session again, and a few at once spent a large part of the next window. These tests hold three
// agents on one model, reach the reset, and check how the gate lets them go.
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLD_CACHE_MS, RELEASE_STAGGER_MS, UsageLimitGate } from "./usage-limit-gate";

const NOW = Date.UTC(2026, 9, 26, 3, 0, 0);
const GRACE_MS = 30_000;

function setup() {
  const agents = ["a1", "a2", "a3"].map((id) => ({ id, provider: "claude" as const, model: "claude-opus-5-5" }));
  const store = { list: () => agents };
  const drained: string[] = [];
  const cold: string[] = [];
  const gate = new UsageLimitGate({
    store,
    hooks: {
      emit: () => {},
      emitRuntimeSnapshot: () => {},
      scheduleDrain: (agentId) => drained.push(agentId),
      readUsage: () => Effect.succeed(null),
      held: () => Effect.void,
      released: () => Effect.void,
      coldResume: (agentIds) => cold.push(...agentIds),
    },
  });
  return { gate, drained, cold };
}

/** Holds the agents until `resetInMs` from now, then moves the clock to just past the reset. */
async function holdUntilReset(gate: UsageLimitGate, drained: string[], resetInMs: number) {
  await Effect.runPromise(gate.reached("a1", Math.floor((NOW + resetInMs) / 1_000)));
  drained.length = 0;
  await vi.advanceTimersByTimeAsync(resetInMs + GRACE_MS + 1);
}

describe("UsageLimitGate release", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets the held agents go one at a time after the reset", async () => {
    const { gate, drained } = setup();
    await holdUntilReset(gate, drained, 2 * 60 * 60_000);

    expect(drained).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(RELEASE_STAGGER_MS);
    expect(drained).toEqual(["a1", "a2"]);
    await vi.advanceTimersByTimeAsync(RELEASE_STAGGER_MS);
    expect(drained).toEqual(["a1", "a2", "a3"]);
    await Effect.runPromise(gate.dispose());
  });

  it("marks the agents cold when the limit outlived the prompt cache", async () => {
    const { gate, drained, cold } = setup();
    await holdUntilReset(gate, drained, COLD_CACHE_MS + 5 * 60_000);

    expect(cold).toEqual(["a1", "a2", "a3"]);
    await Effect.runPromise(gate.dispose());
  });

  it("keeps the agents warm after a short limit", async () => {
    const { gate, drained, cold } = setup();
    await holdUntilReset(gate, drained, 10 * 60_000);

    expect(drained).toEqual(["a1"]);
    expect(cold).toEqual([]);
    await Effect.runPromise(gate.dispose());
  });

  it("holds the later agents when the first turn after the reset is refused again", async () => {
    const { gate, drained } = setup();
    await holdUntilReset(gate, drained, 2 * 60 * 60_000);
    expect(gate.mayDrain("a2")).toBe(true);

    // The window had not really reset: the first agent's turn is refused and the gate closes again.
    await Effect.runPromise(gate.reached("a1", Math.floor((Date.now() + 60 * 60_000) / 1_000)));
    await vi.advanceTimersByTimeAsync(RELEASE_STAGGER_MS);

    expect(drained).toContain("a2");
    expect(gate.mayDrain("a2")).toBe(false);
    await Effect.runPromise(gate.dispose());
  });

  it("drops the pending staggered drains on dispose", async () => {
    const { gate, drained } = setup();
    await holdUntilReset(gate, drained, 2 * 60 * 60_000);
    await Effect.runPromise(gate.dispose());

    await vi.advanceTimersByTimeAsync(3 * RELEASE_STAGGER_MS);
    expect(drained).toEqual(["a1"]);
  });
});
