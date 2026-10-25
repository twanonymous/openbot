// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USER_MEMORY_CONTEXT_BUDGET_BYTES } from "@openbot/contracts/agent-memory-context";
import { sourceText } from "@openbot/i18n/source";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemorySelectionError, AgentMemoryStore } from "./agent-memory-store";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";
import { USER_MEMORY_OWNER } from "./user-memory-schema";
import { UserMemoryStore } from "./user-memory-store";

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-user-memory-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  databases.push(database);
  return database;
}

describe("UserMemoryStore", () => {
  it("keeps the user memories apart from every agent's memories", async () => {
    const database = await openDatabase();
    const user = new UserMemoryStore(database);
    const agent = new AgentMemoryStore(database);
    user.createManual(USER_MEMORY_OWNER, "Kevin lives in Taipei.");
    agent.createManual("chief", "The build runs at night.");

    expect(user.list(USER_MEMORY_OWNER).map((memory) => memory.text)).toEqual(["Kevin lives in Taipei."]);
    expect(agent.list("chief").map((memory) => memory.text)).toEqual(["The build runs at night."]);
    expect(user.search(USER_MEMORY_OWNER, "Taipei").memories.map((memory) => memory.text)).toEqual([
      "Kevin lives in Taipei.",
    ]);
    expect(user.search(USER_MEMORY_OWNER, "build").memories).toEqual([]);
    expect(agent.search("chief", "Taipei").memories).toEqual([]);
    expect(
      database.connection
        .prepare("SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_type = 'user-memory'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("folds a duplicate, edits and deletes a memory, and erases its history", async () => {
    const database = await openDatabase();
    const user = new UserMemoryStore(database);
    const first = user.createManual(USER_MEMORY_OWNER, "Kevin likes tea.");
    expect(user.createManual(USER_MEMORY_OWNER, "Kevin likes tea.").id).toBe(first.id);
    const edited = user.updateManual(USER_MEMORY_OWNER, first.id, "Kevin likes oolong tea.");
    expect(edited.text).toBe("Kevin likes oolong tea.");
    expect(user.search(USER_MEMORY_OWNER, "oolong").memories.map((memory) => memory.id)).toEqual([first.id]);
    expect(user.delete(USER_MEMORY_OWNER, first.id)).toBe(true);
    expect(user.list(USER_MEMORY_OWNER)).toEqual([]);
    expect(
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_type = 'user-memory' AND aggregate_id = ?",
        )
        .get(first.id),
    ).toEqual({ count: 1 });
  });

  it("holds the essential user memories to their own budget", async () => {
    const database = await openDatabase();
    const user = new UserMemoryStore(database);
    const memories = Array.from({ length: 8 }, (_, index) =>
      user.createManual(USER_MEMORY_OWNER, `${index} ${"x".repeat(480)}`),
    );
    const state = user.selectionState(USER_MEMORY_OWNER);
    expect(state.budgetBytes).toBe(USER_MEMORY_CONTEXT_BUDGET_BYTES);
    const revision = (id: string) => state.selections.find((entry) => entry.memoryId === id)?.revision ?? -1;
    const fits = memories.slice(0, 5).map((memory) => ({
      memoryId: memory.id,
      inclusion: "essential" as const,
      expectedRevision: revision(memory.id),
    }));
    const selected = user.setInclusions(USER_MEMORY_OWNER, fits, "user");
    expect(selected.usedBytes).toBeLessThanOrEqual(USER_MEMORY_CONTEXT_BUDGET_BYTES);
    const last = memories[7];
    if (!last) throw new Error("No memory.");
    expect(() =>
      user.setInclusions(
        USER_MEMORY_OWNER,
        [{ memoryId: last.id, inclusion: "essential", expectedRevision: revision(last.id) }],
        "user",
      ),
    ).toThrow(AgentMemorySelectionError);
  });

  it("stops at its own limit with its own message", async () => {
    const database = await openDatabase();
    const user = new UserMemoryStore(database, () => 2);
    user.createManual(USER_MEMORY_OWNER, "One.");
    user.createManual(USER_MEMORY_OWNER, "Two.");
    expect(() => user.createManual(USER_MEMORY_OWNER, "Three.")).toThrow(
      sourceText("error.backend.userMemoryLimit", { limit: 2 }),
    );
  });
});
