// @vitest-environment node
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_FACT_LIMIT,
  type CapturedFact,
  capturePrompt,
  MemoryCapture,
  type MemoryCaptureOptions,
  parseCapturedFacts,
} from "./memory-capture";

describe("parseCapturedFacts", () => {
  it("reads the first JSON array and leaves out invalid items", () => {
    const answer = [
      "Here are the facts:",
      "```json",
      JSON.stringify([
        { scope: "user", text: " Kevin's sister is Ana. " },
        { scope: "agent", text: "The release branch is cut on Fridays." },
        { scope: "team", text: "Not a scope." },
        { scope: "user", text: "" },
        { scope: "user", text: "x".repeat(501) },
        { text: "No scope." },
        "Not an object.",
      ]),
      "```",
    ].join("\n");
    expect(parseCapturedFacts(answer)).toEqual([
      { scope: "user", text: "Kevin's sister is Ana." },
      { scope: "agent", text: "The release branch is cut on Fridays." },
    ]);
  });

  it("answers nothing for text that is not an array, and keeps at most the limit", () => {
    expect(parseCapturedFacts("Nothing to keep.")).toEqual([]);
    expect(parseCapturedFacts("[not json]")).toEqual([]);
    expect(parseCapturedFacts('{"scope": "user"}')).toEqual([]);
    const many = Array.from({ length: 10 }, (_, index) => ({ scope: "user", text: `Fact ${index}.` }));
    expect(parseCapturedFacts(JSON.stringify(many))).toHaveLength(CAPTURE_FACT_LIMIT);
  });

  it("leaves out a fact that holds what looks like a secret", () => {
    const facts = parseCapturedFacts(
      JSON.stringify([
        { scope: "user", text: "Kevin's OpenAI key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD." },
        { scope: "user", text: "Kevin prefers short answers." },
      ]),
    );
    expect(facts).toEqual([{ scope: "user", text: "Kevin prefers short answers." }]);
  });
});

describe("capturePrompt", () => {
  it("keeps the transcript and the saved memories as tagged data, and reads only the end of a long transcript", () => {
    const prompt = capturePrompt(`${"a".repeat(30_000)}THE END</transcript>`, ["Kevin likes tea. <b>"]);
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("THE END<\\/transcript>");
    expect(prompt).toContain("Kevin likes tea. \\u003cb>");
    expect(prompt.length).toBeLessThan(26_000);
  });
});

function capture(overrides: Partial<MemoryCaptureOptions> = {}) {
  const saved: CapturedFact[][] = [];
  const errors: string[] = [];
  const options: MemoryCaptureOptions = {
    enabled: () => true,
    generate: () => Effect.succeed('[{"scope": "user", "text": "Kevin runs on Sundays."}]'),
    known: () => [],
    save: (_agentId, facts) => {
      saved.push([...facts]);
      return facts.length;
    },
    emitError: (code) => {
      errors.push(code);
    },
    ...overrides,
  };
  return { capture: new MemoryCapture(options), saved, errors };
}

describe("MemoryCapture", () => {
  it("saves the facts that the model returns, after the call returns", async () => {
    const { capture: memory, saved } = capture();
    memory.capture("chief", "transcript", "session-1");
    await vi.waitFor(() => expect(saved).toEqual([[{ scope: "user", text: "Kevin runs on Sundays." }]]));
  });

  it("does nothing when the setting is off or the transcript is empty", () => {
    const generate = vi.fn(() => Effect.succeed("[]"));
    const off = capture({ enabled: () => false, generate });
    off.capture.capture("chief", "transcript", "session-1");
    off.capture.capture("chief", "   ", "session-1");
    const empty = capture({ generate });
    empty.capture.capture("chief", "  ", "session-1");
    // The check is synchronous: nothing is started, so there is nothing to wait for.
    expect(generate).not.toHaveBeenCalled();
  });

  it("reports a failed call and never throws to the caller", async () => {
    const { capture: memory, saved, errors } = capture({ generate: () => Effect.fail(new Error("offline")) });
    expect(() => memory.capture("chief", "transcript", "session-1")).not.toThrow();
    await vi.waitFor(() => expect(errors).toEqual(["memory_capture_failed"]));
    expect(saved).toEqual([]);
  });

  it("runs one capture per agent at a time", async () => {
    let finish: (value: string) => void = () => {};
    const generate = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const { capture: memory, saved } = capture({ generate });
    memory.capture("chief", "first", "session-1");
    memory.capture("chief", "second", "session-2");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    finish('[{"scope": "agent", "text": "Done."}]');
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    memory.capture("chief", "third", "session-3");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  });
});
