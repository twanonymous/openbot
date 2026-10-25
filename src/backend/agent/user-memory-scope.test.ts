// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { runCauseEffect } from "../effect-boundary";
import { OpenBotDatabase } from "../openbot-database";
import type { DynamicToolCallParams } from "../protocol";
import { AgentMemories } from "./agent-memories";
import { isTurnContextBlock, memoryContext, memoryContextUpdate } from "./developer-instructions";

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openbot-user-scope-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  databases.push(database);
  const events: AgentEvent[] = [];
  const unloaded: string[] = [];
  const memories = new AgentMemories({
    store: { database },
    conversation: {
      requireKnownAgent: (agentId) => ({ id: agentId }),
      unloadAgentThreads: (agentId) => {
        unloaded.push(agentId);
      },
      publicThreadId: (_agentId, threadId) => threadId,
    },
    emit: (event) => events.push(event),
    emitError: (_code, error) => {
      throw error;
    },
    listAgentIds: () => ["chief", "scout"],
  });
  return { memories, events, unloaded };
}

interface ToolArguments {
  text?: string;
  query?: string;
  memoryId?: string;
  scope?: string;
}

let call = 0;
function tool(tool: string, args: ToolArguments, turnId = "turn-1"): DynamicToolCallParams {
  call += 1;
  return { threadId: "thread-1", turnId, callId: `call-${call}`, namespace: "openbot", tool, arguments: args };
}

function resultText(response: ReturnType<AgentMemories["handleTool"]>): string {
  const item = response?.contentItems[0];
  return item && item.type === "inputText" ? item.text : "";
}

describe("user memory scope", () => {
  it("stages a user memory and commits it once for every agent", async () => {
    const { memories, events, unloaded } = await setup();
    const staged = memories.handleTool(tool("remember", { text: "Kevin's sister is Ana.", scope: "user" }), "chief");
    expect(staged?.success).toBe(true);
    expect(memories.listUser()).toEqual([]);

    const changes = memories.finishTurn("turn-1", "completed");
    expect(memories.listUser().map((memory) => memory.text)).toEqual(["Kevin's sister is Ana."]);
    expect(memories.listFor("chief")).toEqual([]);
    expect(changes.get("chief")).toEqual([
      expect.objectContaining({ action: "saved", text: "Kevin's sister is Ana." }),
    ]);
    expect(events).toContainEqual({ type: "user-memories-changed" });
    expect(unloaded).toEqual(["chief", "scout"]);

    const found = memories.handleTool(tool("search_memories", { query: "sister", scope: "user" }), "scout");
    expect(resultText(found)).toContain("Kevin's sister is Ana.");
    expect(resultText(memories.handleTool(tool("search_memories", { query: "sister" }), "scout"))).not.toContain("Ana");
  });

  it("discards a staged user memory when the turn fails, and forgets one by scope", async () => {
    const { memories } = await setup();
    memories.handleTool(tool("remember", { text: "Kevin wakes at six.", scope: "user" }, "turn-a"), "chief");
    memories.finishTurn("turn-a", "failed");
    expect(memories.listUser()).toEqual([]);

    const saved = memories.createUser("Kevin wakes at six.");
    expect(memories.handleTool(tool("forget_memory", { memoryId: saved.id }, "turn-b"), "chief")?.success).toBe(false);
    expect(
      memories.handleTool(tool("forget_memory", { memoryId: saved.id, scope: "user" }, "turn-b"), "chief")?.success,
    ).toBe(true);
    memories.finishTurn("turn-b", "completed");
    expect(memories.listUser()).toEqual([]);
  });

  it("refuses an unknown scope", async () => {
    const { memories } = await setup();
    expect(memories.handleTool(tool("remember", { text: "x", scope: "team" }), "chief")?.success).toBe(false);
  });

  it("saves captured facts once, in their scope, as searchable", async () => {
    const { memories } = await setup();
    memories.createUser("Kevin likes oolong tea.");
    const saved = memories.saveCaptured(
      "chief",
      [
        { scope: "user", text: "Kevin likes oolong tea." },
        { scope: "user", text: "Kevin runs on Sundays." },
        { scope: "agent", text: "The release branch is cut on Fridays." },
        { scope: "agent", text: "The release branch is cut on Fridays." },
      ],
      "capture-1",
    );
    expect(saved).toBe(2);
    // Two saves in one millisecond have no fixed order.
    expect(
      memories
        .listUser()
        .map((memory) => [memory.text, memory.origin])
        .sort(),
    ).toEqual([
      ["Kevin likes oolong tea.", "manual"],
      ["Kevin runs on Sundays.", "automatic"],
    ]);
    expect(memories.listFor("chief").map((memory) => memory.text)).toEqual(["The release branch is cut on Fridays."]);
    expect(memories.recall("user", "user", "Plans for Sundays", 5).map((memory) => memory.text)).toEqual([
      "Kevin runs on Sundays.",
    ]);
  });
});

describe("user memories in the prompt", () => {
  const memory = (id: string, text: string) => ({
    id,
    text,
    origin: "manual" as const,
    sourceTurnId: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    agentId: "user",
  });

  it("sends the user memories in their own block, and only what changed after", () => {
    const first = memoryContext([memory("a", "Agent fact.")], {
      userMemories: [memory("u", "Kevin lives in Taipei.")],
    });
    const full = memoryContextUpdate(null, first);
    expect(full).toContain('<user_memories count="1">');
    expect(full).toContain("Kevin lives in Taipei.");
    expect(full && isTurnContextBlock(full)).toBe(true);
    expect(memoryContextUpdate(first, first)).toBeNull();

    const second = memoryContext([memory("a", "Agent fact.")], {
      userMemories: [memory("u", "Kevin lives in Taipei."), memory("v", "Kevin's sister is Ana.")],
    });
    const update = memoryContextUpdate(first, second);
    expect(update).toContain("User memories added or changed:");
    expect(update).toContain("Kevin's sister is Ana.");
    expect(update).not.toContain("Kevin lives in Taipei.");
    expect(update).not.toContain("Agent fact.");
  });

  it("keeps the user block within its own budget", () => {
    const many = Array.from({ length: 20 }, (_, index) => memory(`u${index}`, `${index} ${"y".repeat(400)}`));
    const context = memoryContext([], { userMemories: many });
    expect(context.user.memories.length).toBeLessThan(many.length);
    expect(context.user.storedCount).toBe(20);
  });
});
