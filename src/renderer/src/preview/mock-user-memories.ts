import { essentialMemoryBytes, USER_MEMORY_CONTEXT_BUDGET_BYTES } from "@openbot/contracts/agent-memory-context";
import type {
  AgentEvent,
  AgentMemorySelection,
  AgentMemorySelectionState,
  MemoryCapturePreference,
  MemoryEntry,
  OpenBotDesktopApi,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

/** The user memories of the preview: what every agent knows about the user, held in memory. */
export function createMockUserMemories(emit: (event: AgentEvent) => void): OpenBotDesktopApi["userMemories"] {
  let memories: MemoryEntry[] = [];
  const selections = new Map<string, AgentMemorySelection>();
  let capture: MemoryCapturePreference = { enabled: true };
  const changed = () => emit({ type: "user-memories-changed" });
  const essentialBytes = (list: readonly MemoryEntry[]) =>
    essentialMemoryBytes(
      list.filter((entry) => selections.get(entry.id)?.inclusion === "essential"),
      "user_memories",
    );
  const state = (): AgentMemorySelectionState => ({
    selections: memories.flatMap((entry) => {
      const selection = selections.get(entry.id);
      return selection ? [structuredClone(selection)] : [];
    }),
    usedBytes: essentialBytes(memories),
    budgetBytes: USER_MEMORY_CONTEXT_BUDGET_BYTES,
  });

  return {
    list: async () => structuredClone(memories),
    getSelection: async () => state(),
    setInclusion: async ({ changes }) => {
      const next = new Map(selections);
      for (const change of changes) {
        const selection = next.get(change.memoryId);
        if (!selection || selection.revision !== change.expectedRevision)
          throw new Error(sourceText("error.backend.memorySelectionConflict"));
        next.set(change.memoryId, {
          ...selection,
          inclusion: change.inclusion === "automatic" ? selection.inclusion : change.inclusion,
          userControlled: change.inclusion !== "automatic",
          revision: selection.revision + 1,
        });
      }
      const essential = memories.filter((entry) => next.get(entry.id)?.inclusion === "essential");
      if (essentialMemoryBytes(essential, "user_memories") > USER_MEMORY_CONTEXT_BUDGET_BYTES)
        throw new Error(sourceText("error.backend.memoryEssentialBudget"));
      for (const [id, selection] of next) selections.set(id, selection);
      changed();
      return state();
    },
    create: async (text) => {
      const now = new Date().toISOString();
      const memory: MemoryEntry = {
        id: crypto.randomUUID(),
        text: text.trim(),
        origin: "manual",
        sourceTurnId: null,
        createdAt: now,
        updatedAt: now,
      };
      memories = [memory, ...memories];
      selections.set(memory.id, { memoryId: memory.id, inclusion: "searchable", userControlled: false, revision: 0 });
      changed();
      return structuredClone(memory);
    },
    update: async ({ memoryId, text }) => {
      const current = memories.find((entry) => entry.id === memoryId);
      if (!current) throw new Error(sourceText("error.backend.memoryGone"));
      const updated = { ...current, text: text.trim(), updatedAt: new Date().toISOString() };
      memories = memories.map((entry) => (entry.id === memoryId ? updated : entry));
      changed();
      return structuredClone(updated);
    },
    delete: async (memoryId) => {
      memories = memories.filter((entry) => entry.id !== memoryId);
      selections.delete(memoryId);
      changed();
    },
    clear: async () => {
      memories = [];
      selections.clear();
      changed();
    },
    getCapture: async () => ({ ...capture }),
    setCapture: async (preference) => {
      capture = { enabled: preference.enabled };
      return { ...capture };
    },
  };
}
