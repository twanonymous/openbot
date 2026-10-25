import { USER_MEMORY_CONTEXT_BUDGET_BYTES } from "@openbot/contracts/agent-memory-context";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { sourceText } from "@openbot/i18n/source";
import { SelectableMemoryStore } from "./agent-memory-store";
import type { OpenBotDatabase } from "./openbot-database";

/**
 * Owns the user memories: facts about the user that every agent of this computer shares, such as a
 * name, a preference, a person or a routine. One owner, `USER_MEMORY_OWNER`, so a caller passes that id
 * where an agent store takes an agent id. The essential ones go into each agent's prompt beside the
 * agent's own, within their own smaller budget.
 */
export class UserMemoryStore extends SelectableMemoryStore {
  constructor(database: OpenBotDatabase, limit: () => number = () => INPUT_LIMITS.userMemories) {
    super(
      database,
      {
        table: "projection_user_memories",
        ownerColumn: "owner_id",
        ownerKey: "ownerId",
        aggregateType: "user-memory",
        limit,
        limitMessage: (current) => sourceText("error.backend.userMemoryLimit", { limit: current }),
      },
      {
        selections: "user_memory_selections",
        search: "user_memory_search",
        budgetBytes: USER_MEMORY_CONTEXT_BUDGET_BYTES,
        tag: "user_memories",
      },
    );
  }
}
