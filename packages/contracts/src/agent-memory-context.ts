import type { MemoryEntry } from "./ipc-agent-memories";

export const AGENT_MEMORY_CONTEXT_BUDGET_BYTES = 8192;
/**
 * The essential user memories: facts about the user that every agent sees. A separate budget beside the
 * agent one, so that an agent with a full budget keeps every essential memory it had.
 */
export const USER_MEMORY_CONTEXT_BUDGET_BYTES = 3072;
type ContextMemory = Pick<MemoryEntry, "id" | "text" | "origin">;
export type EssentialMemoryTag = "agent_memories" | "user_memories";

/** One format for migration selection, mutation budgets, and provider instructions. */
export function serializeEssentialMemories(
  memories: readonly ContextMemory[],
  tag: EssentialMemoryTag = "agent_memories",
): string {
  const entries = memories.map(({ id, text, origin }) => ({ id, text, origin }));
  return `<${tag} count="${entries.length}">
${JSON.stringify(entries)}
</${tag}>`;
}

export function essentialMemoryBytes(
  memories: readonly ContextMemory[],
  tag: EssentialMemoryTag = "agent_memories",
): number {
  return new TextEncoder().encode(serializeEssentialMemories(memories, tag)).byteLength;
}
