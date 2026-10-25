// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  parseMemoryCapturePreference,
  parseSetUserMemoryInclusion,
  parseUpdateUserMemory,
} from "./user-memory-handlers";

describe("user memory inputs", () => {
  it("reads an update, and refuses a missing id or a text past the limit", () => {
    expect(parseUpdateUserMemory({ memoryId: "m1", text: "Kevin likes tea." })).toEqual({
      memoryId: "m1",
      text: "Kevin likes tea.",
    });
    expect(() => parseUpdateUserMemory({ text: "x" })).toThrow("memoryId is required.");
    expect(() => parseUpdateUserMemory({ memoryId: "m1", text: "x".repeat(501) })).toThrow("text is too long.");
    expect(() => parseUpdateUserMemory("m1")).toThrow("Invalid memory update request.");
  });

  it("reads inclusion changes, and refuses a bad inclusion, a bad revision and a repeated memory", () => {
    const change = { memoryId: "m1", inclusion: "essential", expectedRevision: 0 };
    expect(parseSetUserMemoryInclusion({ changes: [change] })).toEqual({ changes: [change] });
    expect(() => parseSetUserMemoryInclusion({ changes: [] })).toThrow("Invalid memory inclusion request.");
    expect(() => parseSetUserMemoryInclusion({ changes: [{ ...change, inclusion: "always" }] })).toThrow(
      "Invalid memory inclusion change.",
    );
    expect(() => parseSetUserMemoryInclusion({ changes: [{ ...change, expectedRevision: -1 }] })).toThrow(
      "Invalid memory inclusion change.",
    );
    expect(() => parseSetUserMemoryInclusion({ changes: [change, change] })).toThrow(
      "Duplicate memory inclusion change.",
    );
  });

  it("reads the capture setting only as a boolean", () => {
    expect(parseMemoryCapturePreference({ enabled: false })).toEqual({ enabled: false });
    expect(() => parseMemoryCapturePreference({ enabled: "no" })).toThrow("Invalid memory capture setting.");
  });
});
