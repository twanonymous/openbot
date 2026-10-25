// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentMemories } from "./agent/agent-memories";
import { MemoryRecall } from "./agent/memory-recall";
import { AgentMemoryStore } from "./agent-memory-store";
import { CJK_BIGRAM_LIMIT, cjkBigrams, cjkMatchScore } from "./cjk-memory-match";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
const databases: OpenBotDatabase[] = [];
afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openDatabase(): Promise<OpenBotDatabase> {
  const root = await mkdtemp(join(tmpdir(), "openbot-cjk-memory-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  databases.push(database);
  return database;
}

function memories(database: OpenBotDatabase): AgentMemories {
  return new AgentMemories({
    store: { database },
    conversation: {
      requireKnownAgent: (agentId) => ({ id: agentId }),
      unloadAgentThreads: () => {},
      publicThreadId: (_agentId, threadId) => threadId,
    },
    emit: () => {},
    emitError: (_code, error) => {
      throw error;
    },
    listAgentIds: () => ["chief"],
  });
}

describe("cjkBigrams", () => {
  it("makes the overlapping pairs of each CJK run, without pairs of function characters", () => {
    expect(cjkBigrams("幫我推薦台北的飲料店")).toEqual(["推薦", "薦台", "台北", "飲料", "料店"]);
    expect(cjkBigrams("Falcon 版本")).toEqual(["版本"]);
    expect(cjkBigrams("東京の天気")).toEqual(["東京", "天気"]);
    expect(cjkBigrams("plain English only")).toEqual([]);
    expect(cjkBigrams("台")).toEqual([]);
    expect(cjkBigrams("甲乙丙丁戊己庚辛壬癸".repeat(20)).length).toBeLessThanOrEqual(CJK_BIGRAM_LIMIT);
  });

  it("counts the pairs that a text holds", () => {
    expect(cjkMatchScore("使用者住在台北，喜歡喝無糖綠茶", cjkBigrams("幫我推薦台北的飲料店"))).toBe(1);
    expect(cjkMatchScore("每週五發布新版本", cjkBigrams("幫我推薦台北的飲料店"))).toBe(0);
  });
});

describe("CJK memory search", () => {
  it("finds a Traditional Chinese memory by a word inside a longer phrase", async () => {
    const database = await openDatabase();
    const store = new AgentMemoryStore(database);
    store.createManual("chief", "使用者住在台北，喜歡喝無糖綠茶");
    store.createManual("chief", "每週五發布新版本");
    store.createManual("other", "使用者住在台北");
    expect(store.search("chief", "幫我推薦台北的飲料店").memories.map((memory) => memory.text)).toEqual([
      "使用者住在台北，喜歡喝無糖綠茶",
    ]);
    expect(store.search("chief", "綠茶").memories.map((memory) => memory.text)).toEqual([
      "使用者住在台北，喜歡喝無糖綠茶",
    ]);
    expect(store.search("chief", "版本什麼時候發布").memories.map((memory) => memory.text)).toEqual([
      "每週五發布新版本",
    ]);
  });

  it("ranks the memory with more shared pairs first, and keeps word matches in a mixed query", async () => {
    const database = await openDatabase();
    const store = new AgentMemoryStore(database);
    store.createManual("chief", "台北辦公室在信義區");
    store.createManual("chief", "台北辦公室的 Wi-Fi 密碼要問 Ana");
    store.createManual("chief", "The Falcon release ships on Friday.");
    expect(store.search("chief", "信義區的台北辦公室").memories[0]?.text).toBe("台北辦公室在信義區");
    expect(store.search("chief", "Falcon 台北").memories.map((memory) => memory.text)).toHaveLength(3);
  });

  it("recalls a searchable user memory for a Traditional Chinese message", async () => {
    const database = await openDatabase();
    const agentMemories = memories(database);
    agentMemories.createUser("使用者住在台北，喜歡喝無糖綠茶");
    agentMemories.createUser("使用者的妹妹叫 Ana");
    const block = new MemoryRecall(agentMemories).block("chief", "thread-1", "幫我推薦台北的飲料店");
    expect(block).toContain("使用者住在台北，喜歡喝無糖綠茶");
    expect(block).not.toContain("妹妹");
  });
});
