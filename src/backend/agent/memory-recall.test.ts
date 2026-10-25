// @vitest-environment node
import type { AgentMemory } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import type { MemoryScope } from "./agent-memories";
import { isTurnContextBlock, withoutRelevantMemories } from "./developer-instructions";
import { MemoryRecall, RECALL_BUDGET_BYTES, RECALL_LIMIT, type RecallSource, recallQuery } from "./memory-recall";

function memory(id: string, text: string): AgentMemory {
  return {
    id,
    text,
    origin: "automatic",
    sourceTurnId: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    agentId: "chief",
  };
}

/** Matches a memory when it has one of the query's words, in the order given. */
function source(memories: Record<MemoryScope, AgentMemory[]>, queries: string[] = []): RecallSource {
  return {
    recall: (scope, _ownerId, query, limit) => {
      queries.push(query);
      const words = query.toLowerCase().split(" ");
      return memories[scope]
        .filter((entry) => words.some((word) => entry.text.toLowerCase().includes(word)))
        .slice(0, limit);
    },
  };
}

function entries(block: string | null): { id: string; scope: string; text: string }[] {
  if (!block) return [];
  const lines = block.split("\n");
  return JSON.parse(lines[2] ?? "[]");
}

describe("recallQuery", () => {
  it("keeps the words that can match, once each", () => {
    expect(recallQuery("What is the plan for the Falcon release? falcon!")).toBe("plan Falcon release");
    expect(recallQuery("ok")).toBeNull();
    expect(recallQuery("我想喝咖啡")).toBe("我想喝咖啡");
    expect(recallQuery("x".repeat(300))).toBeNull();
  });
});

describe("MemoryRecall", () => {
  it("sends the matching memories of both scopes in a block that history readers strip", () => {
    const recall = new MemoryRecall(
      source({
        agent: [memory("a1", "The Falcon release ships on Friday.")],
        user: [memory("u1", "Kevin leads the Falcon project.")],
      }),
    );
    const block = recall.block("chief", "thread-1", "When does Falcon ship?");
    expect(block && isTurnContextBlock(block)).toBe(true);
    expect(entries(block)).toEqual([
      { id: "a1", scope: "agent", text: "The Falcon release ships on Friday." },
      { id: "u1", scope: "user", text: "Kevin leads the Falcon project." },
    ]);
    expect(withoutRelevantMemories(`${block}\n\nWhen does Falcon ship?`)).toBe("When does Falcon ship?");
    expect(withoutRelevantMemories("When does Falcon ship?")).toBe("When does Falcon ship?");
  });

  it("sends a memory once per provider session", () => {
    const recall = new MemoryRecall(source({ agent: [memory("a1", "Falcon ships on Friday.")], user: [] }));
    expect(entries(recall.block("chief", "thread-1", "Falcon?"))).toHaveLength(1);
    expect(recall.block("chief", "thread-1", "Falcon again?")).toBeNull();
    expect(entries(recall.block("chief", "thread-2", "Falcon?"))).toHaveLength(1);
  });

  it("stays within its count and byte limits, and sends nothing for a message with no words", () => {
    const many = Array.from({ length: 10 }, (_, index) => memory(`a${index}`, `Falcon note ${index}.`));
    const recall = new MemoryRecall(source({ agent: many, user: [] }));
    expect(entries(recall.block("chief", "thread-1", "Falcon"))).toHaveLength(RECALL_LIMIT);
    const long = Array.from({ length: 5 }, (_, index) => memory(`l${index}`, `Falcon ${"z".repeat(490)} ${index}`));
    const bounded = entries(new MemoryRecall(source({ agent: long, user: [] })).block("chief", "t", "Falcon"));
    expect(bounded.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(RECALL_BUDGET_BYTES);
    expect(bounded.length).toBeGreaterThan(0);
    const queries: string[] = [];
    expect(new MemoryRecall(source({ agent: many, user: [] }, queries)).block("chief", "t", "?? !!")).toBeNull();
    expect(queries).toEqual([]);
  });
});
