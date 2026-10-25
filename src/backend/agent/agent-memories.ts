import { AGENT_MEMORY_CONTEXT_BUDGET_BYTES } from "@openbot/contracts/agent-memory-context";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentEvent,
  AgentMemory,
  AgentMemorySelectionState,
  ConversationMemoryChange,
  CreateAgentMemoryInput,
  DeleteAgentMemoryInput,
  SetAgentMemoryInclusionInput,
  UpdateAgentMemoryInput,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import {
  type AgentMemoryListPage,
  type AgentMemorySearchResult,
  AgentMemorySelectionError,
  AgentMemoryStore,
  type SelectableMemoryStore,
} from "../agent-memory-store";
import type { AgentStore } from "../agent-store";
import { normalizeMemoryText } from "../memory-store";
import { type DynamicToolCallParams, isRecord } from "../protocol";
import { USER_MEMORY_OWNER } from "../user-memory-schema";
import { UserMemoryStore } from "../user-memory-store";
import type { ConversationRuntime } from "./conversation-runtime";
import { listMemoriesInput, searchMemoriesInput, setMemoryInclusionInput } from "./memory-tool-inputs";
import { type OpenBotToolResponse, openBotToolFailure, openBotToolResult } from "./routine-tools";

/** Whose memory a tool call addresses: the calling agent's own, or the user memories that every agent shares. */
export type MemoryScope = "agent" | "user";

/**
 * Every staged mutation names its scope and owner: the agent itself, or `USER_MEMORY_OWNER`. The
 * sender is the agent whose turn staged it, which is where the chat shows the committed change.
 */
type PendingMemoryMutation =
  | {
      callId: string;
      type: "selection";
      scope: MemoryScope;
      ownerId: string;
      senderAgentId: string;
      epoch: number;
      memoryId?: never;
      changes: SetAgentMemoryInclusionInput["changes"];
    }
  | {
      callId: string;
      type: "remember";
      scope: MemoryScope;
      ownerId: string;
      senderAgentId: string;
      epoch: number;
      memoryId?: string;
      text: string;
      sourceTurnId: string;
      expectedUpdatedAt?: string | null;
      expectedSelectionRevision?: number;
      duplicate?: { memoryId: string; expectedRevision: number };
      inclusion: "essential" | "searchable";
    }
  | {
      callId: string;
      type: "forget";
      scope: MemoryScope;
      ownerId: string;
      senderAgentId: string;
      epoch: number;
      memoryId: string;
      expectedUpdatedAt: string;
      expectedSelectionRevision: number;
    };

/** What memories need from the conversation runtime. A test passes a fake. */
export type MemoryConversation = Pick<ConversationRuntime, "unloadAgentThreads" | "publicThreadId"> & {
  requireKnownAgent(agentId: string): { id: string };
};

export interface AgentMemoriesOptions {
  store: Pick<AgentStore, "database">;
  conversation: MemoryConversation;
  emit(event: AgentEvent): void;
  emitError(code: string, error: unknown, agentId?: string): void;
  /** How many memories one agent can hold: the app setting. Omitted, the default cap. */
  limit?: () => number;
  /** Every agent of this computer, so a user-memory change can unload all of their sessions. */
  listAgentIds?: () => string[];
}

/**
 * What an agent remembers about its work between turns.
 *
 * The staging half is the reason this is a class and not a store wrapper. An agent's `remember` and
 * `forget_memory` calls do not take effect when the model makes them: they are held against the
 * turn and committed only if that turn completes, so a turn the user interrupts or that fails
 * leaves nothing behind. The epoch counter is what makes that safe against a concurrent manual
 * edit — `clearMemories` bumps it, and a staged mutation whose epoch has moved is dropped rather
 * than resurrecting a memory the user just deleted.
 */
export class AgentMemories {
  readonly #conversation: MemoryConversation;
  readonly #emit: (event: AgentEvent) => void;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #memories: AgentMemoryStore;
  readonly #userMemories: UserMemoryStore;
  readonly #listAgentIds: () => string[];
  readonly #pending = new Map<string, PendingMemoryMutation[]>();
  readonly #epochs = new Map<string, number>();

  constructor(options: AgentMemoriesOptions) {
    this.#conversation = options.conversation;
    this.#emit = options.emit;
    this.#emitError = options.emitError;
    this.#memories = new AgentMemoryStore(options.store.database, options.limit);
    this.#userMemories = new UserMemoryStore(options.store.database);
    this.#listAgentIds = options.listAgentIds ?? (() => []);
  }

  #store(scope: MemoryScope): SelectableMemoryStore {
    return scope === "user" ? this.#userMemories : this.#memories;
  }

  limit(): number {
    return this.#memories.limit();
  }

  list(agentId: string): AgentMemory[] {
    this.#conversation.requireKnownAgent(agentId);
    return this.#memories.list(agentId);
  }

  /** Unchecked read for callers that already hold the agent, such as the developer instructions. */
  listFor(agentId: string): AgentMemory[] {
    return this.#memories.list(agentId);
  }

  essentialFor(agentId: string): AgentMemory[] {
    return this.#withInclusion("agent", agentId, "essential");
  }

  #withInclusion(scope: MemoryScope, ownerId: string, inclusion: "essential" | "searchable"): AgentMemory[] {
    const store = this.#store(scope);
    const ids = new Set(
      store
        .listSelections(ownerId)
        .filter((entry) => entry.inclusion === inclusion)
        .map((entry) => entry.memoryId),
    );
    return store.list(ownerId).filter((memory) => ids.has(memory.id));
  }

  // The user memories: facts about the user that every agent shares. The settings page edits them, and
  // a change unloads every agent's sessions, as an agent's own change unloads its own.

  userLimit(): number {
    return this.#userMemories.limit();
  }

  listUser(): AgentMemory[] {
    return this.#userMemories.list(USER_MEMORY_OWNER);
  }

  essentialUser(): AgentMemory[] {
    return this.#withInclusion("user", USER_MEMORY_OWNER, "essential");
  }

  /**
   * Committed searchable (not essential) matches of a literal word search, best first: the memories
   * that are not in the prompt already. A query with no word finds nothing.
   */
  recall(scope: MemoryScope, ownerId: string, query: string, limit: number): AgentMemory[] {
    const store = this.#store(scope);
    const essential = new Set(this.#withInclusion(scope, ownerId, "essential").map((memory) => memory.id));
    try {
      return store
        .search(ownerId, query, Math.min(10, limit + essential.size))
        .memories.filter((memory) => memory.inclusion === "searchable")
        .slice(0, limit);
    } catch (error) {
      if (error instanceof AgentMemorySelectionError) return [];
      throw error;
    }
  }

  userSelectionState(): AgentMemorySelectionState {
    return this.#userMemories.selectionState(USER_MEMORY_OWNER);
  }

  setUserInclusions(changes: SetAgentMemoryInclusionInput["changes"]): AgentMemorySelectionState {
    const result = this.#userMemories.setInclusions(USER_MEMORY_OWNER, changes, "user");
    this.userStateChanged();
    return result;
  }

  createUser(text: string): AgentMemory {
    const memory = this.#userMemories.createManual(USER_MEMORY_OWNER, text);
    this.userStateChanged();
    return memory;
  }

  updateUser(memoryId: string, text: string): AgentMemory {
    const memory = this.#userMemories.updateManual(USER_MEMORY_OWNER, memoryId, text);
    this.userStateChanged();
    return memory;
  }

  deleteUser(memoryId: string): void {
    if (!this.#userMemories.delete(USER_MEMORY_OWNER, memoryId))
      throw new Error(sourceText("error.backend.memoryGone"));
    this.userStateChanged();
  }

  clearUser(): void {
    this.#epochs.set(epochKey("user", USER_MEMORY_OWNER), this.#epoch("user", USER_MEMORY_OWNER) + 1);
    if (this.#userMemories.clear(USER_MEMORY_OWNER) > 0) this.userStateChanged();
  }

  /**
   * Saves facts that OpenBot drew from a conversation before its context was lost, as automatic,
   * searchable memories. A fact already saved, in either scope, is skipped, and a full owner saves no
   * more. Answers how many it saved.
   */
  saveCaptured(agentId: string, facts: readonly { scope: MemoryScope; text: string }[], sourceTurnId: string): number {
    let saved = 0;
    const touched = new Set<MemoryScope>();
    const known = new Set(
      [...this.#memories.list(agentId), ...this.#userMemories.list(USER_MEMORY_OWNER)].map((memory) =>
        normalizeMemoryText(memory.text),
      ),
    );
    for (const fact of facts) {
      const text = fact.text.trim();
      if (!text || text.length > INPUT_LIMITS.agentMemoryText || known.has(normalizeMemoryText(text))) continue;
      const ownerId = fact.scope === "user" ? USER_MEMORY_OWNER : agentId;
      const store = this.#store(fact.scope);
      if (store.count(ownerId) >= store.limit()) continue;
      try {
        if (!store.saveAutomatic({ agentId: ownerId, text, sourceTurnId })) continue;
      } catch {
        // A fact that cannot be saved, such as one past a cap that a concurrent save filled, is
        // skipped. The capture is optional: the others are still saved.
        continue;
      }
      known.add(normalizeMemoryText(text));
      touched.add(fact.scope);
      saved += 1;
    }
    if (touched.has("agent")) this.stateChanged(agentId);
    if (touched.has("user")) this.userStateChanged();
    return saved;
  }

  selectionState(agentId: string): AgentMemorySelectionState {
    this.#conversation.requireKnownAgent(agentId);
    return this.#memories.selectionState(agentId);
  }

  setInclusions(input: SetAgentMemoryInclusionInput): AgentMemorySelectionState {
    this.#conversation.requireKnownAgent(input.agentId);
    const result = this.#memories.setInclusions(input.agentId, input.changes, "user");
    this.stateChanged(input.agentId);
    return result;
  }

  initializeSelection(agentId: string): void {
    this.#conversation.requireKnownAgent(agentId);
    this.#memories.initializeSelection(agentId);
    this.stateChanged(agentId);
  }

  create(input: CreateAgentMemoryInput): AgentMemory {
    this.#conversation.requireKnownAgent(input.agentId);
    const memory = this.#memories.createManual(input.agentId, input.text);
    this.stateChanged(input.agentId);
    return memory;
  }

  update(input: UpdateAgentMemoryInput): AgentMemory {
    this.#conversation.requireKnownAgent(input.agentId);
    const memory = this.#memories.updateManual(input.agentId, input.memoryId, input.text);
    this.stateChanged(input.agentId);
    return memory;
  }

  delete(input: DeleteAgentMemoryInput): void {
    this.#conversation.requireKnownAgent(input.agentId);
    if (!this.#memories.delete(input.agentId, input.memoryId)) {
      throw new Error(sourceText("error.backend.memoryGone"));
    }
    this.stateChanged(input.agentId);
  }

  clear(agentId: string): void {
    this.#conversation.requireKnownAgent(agentId);
    this.#epochs.set(epochKey("agent", agentId), this.#epoch("agent", agentId) + 1);
    if (this.#memories.clear(agentId) > 0) this.stateChanged(agentId);
  }

  duplicate(sourceAgentId: string, targetAgentId: string): void {
    this.#memories.duplicate(sourceAgentId, targetAgentId);
  }

  /** Return expected memory failures to the agent without exposing database errors or memory text. */
  handleTool(
    params: DynamicToolCallParams,
    senderAgentId: string,
    redact: (value: string) => string = redactText,
  ): OpenBotToolResponse | null {
    try {
      return this.#handleTool(params, senderAgentId, redact);
    } catch (error) {
      const message =
        error instanceof AgentMemorySelectionError ? error.message : sourceText("error.backend.memoryOperationFailed");
      return openBotToolFailure(message);
    }
  }

  #handleTool(
    params: DynamicToolCallParams,
    senderAgentId: string,
    redact: (value: string) => string,
  ): OpenBotToolResponse | null {
    if (!MEMORY_TOOLS.has(params.tool)) return null;
    const scope = toolScope(params.arguments);
    if (!scope) return openBotToolFailure("scope must be agent or user.");
    const store = this.#store(scope);
    const ownerId = scope === "user" ? USER_MEMORY_OWNER : senderAgentId;
    if (params.tool === "search_memories") {
      const parsed = searchMemoriesInput.safeParse(params.arguments);
      if (!parsed.success) return openBotToolFailure(sourceText("error.backend.memorySearchQuery"));
      const result = memoryRecallResult(store.search(ownerId, parsed.data.query, parsed.data.limit), redact);
      this.#emitRecallProgress(params, senderAgentId, result.count);
      return result.response;
    }
    if (params.tool === "list_memories") {
      const parsed = listMemoriesInput.safeParse(params.arguments);
      if (!parsed.success) return openBotToolFailure("after must be a memory ID or null.");
      const result = memoryRecallResult(store.listPage(ownerId, parsed.data.after ?? null), redact);
      this.#emitRecallProgress(params, senderAgentId, result.count);
      return result.response;
    }
    if (params.tool === "set_memory_inclusion") {
      const parsed = setMemoryInclusionInput.safeParse(params.arguments);
      if (!parsed.success) return openBotToolFailure("Provide 1 to 25 memory selections with their current revisions.");
      const ids = new Set<string>();
      const planned = this.#plannedContext(scope, ownerId, params.turnId, params.callId);
      const essentials = planned.essential;
      for (const change of parsed.data.changes) {
        const selection = store.getSelection(ownerId, change.memoryId);
        const memory = store.get(ownerId, change.memoryId);
        if (!selection || !memory || selection.revision !== change.expectedRevision || ids.has(change.memoryId))
          return openBotToolFailure(sourceText("error.backend.memorySelectionConflict"));
        if (selection.userControlled)
          return openBotToolFailure(sourceText("error.backend.memorySelectionUserControlled"));
        ids.add(change.memoryId);
        if (change.inclusion === "essential") essentials.set(memory.id, planned.all.get(memory.id) ?? memory);
        else essentials.delete(memory.id);
      }
      if (store.essentialBytes([...essentials.values()]) > store.budgetBytes)
        return openBotToolFailure(sourceText("error.backend.memoryEssentialBudget"));
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "selection",
        scope,
        ownerId,
        senderAgentId,
        epoch: this.#epoch(scope, ownerId),
        changes: parsed.data.changes,
      });
      return openBotToolResult({ status: "staged" });
    }
    if (params.tool === "remember") {
      const args = params.arguments;
      if (!isRecord(args) || !isString(args.text))
        return openBotToolFailure(sourceText("error.backend.memoryTextRequired"));
      const text = args.text.trim();
      if (!text) return openBotToolFailure(sourceText("error.backend.memoryTextRequired"));
      if (text.length > INPUT_LIMITS.agentMemoryText)
        return openBotToolFailure(sourceText("error.backend.memoryTextTooLong"));
      if (args.inclusion !== undefined && args.inclusion !== "essential" && args.inclusion !== "searchable")
        return openBotToolFailure("inclusion must be essential or searchable.");
      const memoryId = args.memoryId;
      if (
        memoryId !== undefined &&
        (!isString(memoryId) || memoryId.length === 0 || memoryId.length > INPUT_LIMITS.identifier)
      ) {
        return openBotToolFailure("memoryId is invalid.");
      }
      const current = memoryId ? store.get(ownerId, memoryId) : null;
      if (memoryId && !current) return openBotToolFailure(notInScope(scope));
      const planned = this.#plannedContext(scope, ownerId, params.turnId, params.callId);
      const duplicateEntry = [...planned.all].find(([key, memory]) => key !== memoryId && memory.text === text);
      const duplicate = duplicateEntry?.[1];
      const sourceSelection = current ? store.getSelection(ownerId, current.id) : null;
      const duplicateSelection = duplicate ? store.getSelection(ownerId, duplicate.id) : null;
      const selectedId = duplicate?.id ?? current?.id;
      const selectedKey = duplicateEntry?.[0] ?? current?.id;
      const selection = duplicateSelection ?? sourceSelection;
      if (duplicate && sourceSelection?.userControlled)
        return openBotToolFailure(sourceText("error.backend.memorySelectionUserControlled"));
      if (selection?.userControlled && args.inclusion !== undefined && args.inclusion !== selection.inclusion)
        return openBotToolFailure(sourceText("error.backend.memorySelectionUserControlled"));
      if (!current && duplicate && selection?.userControlled)
        return openBotToolResult({ status: "unchanged", memoryId: duplicate.id, inclusion: selection.inclusion });
      const plannedEssentials = planned.essential;
      const intendedInclusion =
        args.inclusion ??
        (selection?.userControlled
          ? selection.inclusion
          : selectedKey && plannedEssentials.has(selectedKey)
            ? "essential"
            : "searchable");
      let inclusion: "essential" | "searchable" = intendedInclusion;
      if (inclusion === "essential") {
        const others = [...plannedEssentials]
          .filter(([key, memory]) => key !== current?.id && key !== duplicateEntry?.[0] && memory.text !== text)
          .map(([, memory]) => memory);
        const candidate = {
          id: selectedId ?? "00000000-0000-0000-0000-000000000000",
          text,
          origin: duplicate?.origin ?? ("automatic" as const),
        };
        if (store.essentialBytes([...others, candidate]) > store.budgetBytes) {
          if (current && sourceSelection?.inclusion === "essential")
            return openBotToolFailure(sourceText("error.backend.memoryEssentialBudget"));
          inclusion = "searchable";
        }
      }
      // A full agent hears it now, while it can still merge or forget in this turn. Staged anyway,
      // the save would fail at commit and the memory would be lost.
      if (!memoryId) {
        const projected = this.#projectedMemories(scope, ownerId, params.turnId, params.callId);
        const normalized = normalizeMemoryText(text);
        const limit = store.limit();
        const saved = projected.size;
        if (saved >= limit && ![...projected.values()].some((memory) => memory.text === normalized)) {
          // Over the limit only when the user lowered it. The agent must not delete memories for that.
          const key =
            saved > limit ? "error.backend.agentMemoryLimitExceeded" : "error.backend.agentMemoryLimitReached";
          return openBotToolFailure(sourceText(key, { saved, limit }));
        }
      }
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "remember",
        scope,
        ownerId,
        senderAgentId,
        epoch: this.#epoch(scope, ownerId),
        ...(memoryId ? { memoryId } : {}),
        text,
        sourceTurnId: params.turnId,
        ...(memoryId ? { expectedUpdatedAt: current?.updatedAt ?? null } : {}),
        ...(sourceSelection ? { expectedSelectionRevision: sourceSelection.revision } : {}),
        ...(duplicate && duplicateSelection
          ? { duplicate: { memoryId: duplicate.id, expectedRevision: duplicateSelection.revision } }
          : {}),
        inclusion,
      });
      return openBotToolResult({
        status: "staged",
        memoryId: memoryId ?? null,
        inclusion,
        ...(inclusion !== intendedInclusion ? { note: sourceText("error.backend.memoryEssentialBudget") } : {}),
      });
    }

    if (params.tool === "forget_memory") {
      const args = params.arguments;
      if (
        !isRecord(args) ||
        !isString(args.memoryId) ||
        args.memoryId.length === 0 ||
        args.memoryId.length > INPUT_LIMITS.identifier
      ) {
        return openBotToolFailure("memoryId is required.");
      }
      const current = store.get(ownerId, args.memoryId);
      if (!current) return openBotToolFailure(notInScope(scope));
      const selection = store.getSelection(ownerId, current.id);
      if (selection?.userControlled)
        return openBotToolFailure(sourceText("error.backend.memorySelectionUserControlled"));
      this.#stage(params.turnId, {
        callId: params.callId,
        type: "forget",
        scope,
        ownerId,
        senderAgentId,
        epoch: this.#epoch(scope, ownerId),
        memoryId: current.id,
        expectedUpdatedAt: current.updatedAt,
        expectedSelectionRevision: selection?.revision ?? -1,
      });
      return openBotToolResult({ status: "staged", memoryId: current.id });
    }

    return null;
  }

  /**
   * Commits a turn's staged mutations, or discards them when the turn did not complete. Answers the
   * memories that the commit saved, updated and forgot, by agent. A mutation that the commit skipped
   * is not in it.
   */
  finishTurn(turnId: string, status: string): Map<string, ConversationMemoryChange[]> {
    const pending = this.#pending.get(turnId) ?? [];
    this.#pending.delete(turnId);
    const changes = new Map<string, ConversationMemoryChange[]>();
    if (status !== "completed" || pending.length === 0) return changes;

    const affectedAgents = new Set<string>();
    let userChanged = false;
    const createdMemories = new Set<string>();
    const ownRevisions = new Map<string, Map<number, number>>();
    const revisionAfterOwnChanges = (mutation: PendingMemoryMutation, memoryId: string, revision: number): number => {
      const changes = ownRevisions.get(`${epochKey(mutation.scope, mutation.ownerId)}:${memoryId}`);
      let next = revision;
      while (changes?.has(next)) next = changes.get(next) ?? next;
      return next;
    };
    for (const mutation of pending) {
      if (mutation.epoch !== this.#epoch(mutation.scope, mutation.ownerId)) continue;
      const store = this.#store(mutation.scope);
      const before = this.#storedState(mutation);
      const previousSelections = store.listSelections(mutation.ownerId);
      const previousMemory =
        mutation.type === "selection" || !mutation.memoryId ? null : store.get(mutation.ownerId, mutation.memoryId);
      const previousIds =
        mutation.type === "remember" && !mutation.memoryId
          ? new Set(store.list(mutation.ownerId).map((memory) => memory.id))
          : null;
      try {
        if (mutation.type === "selection")
          store.setInclusions(
            mutation.ownerId,
            mutation.changes.map((change) => ({
              ...change,
              expectedRevision: revisionAfterOwnChanges(mutation, change.memoryId, change.expectedRevision),
            })),
            "agent",
          );
        else if (mutation.type === "remember")
          this.#commitRemember(
            {
              ...mutation,
              ...(mutation.duplicate
                ? {
                    duplicate: {
                      ...mutation.duplicate,
                      expectedRevision: revisionAfterOwnChanges(
                        mutation,
                        mutation.duplicate.memoryId,
                        mutation.duplicate.expectedRevision,
                      ),
                    },
                  }
                : {}),
              ...(mutation.memoryId && mutation.expectedSelectionRevision !== undefined
                ? {
                    expectedSelectionRevision: revisionAfterOwnChanges(
                      mutation,
                      mutation.memoryId,
                      mutation.expectedSelectionRevision,
                    ),
                  }
                : {}),
            },
            createdMemories,
          );
        else if (
          !store.getSelection(mutation.ownerId, mutation.memoryId)?.userControlled &&
          store.getSelection(mutation.ownerId, mutation.memoryId)?.revision ===
            revisionAfterOwnChanges(mutation, mutation.memoryId, mutation.expectedSelectionRevision)
        )
          store.delete(mutation.ownerId, mutation.memoryId, mutation.expectedUpdatedAt);
      } catch (error) {
        this.#emitError("memory_commit_failed", error, mutation.senderAgentId);
        continue;
      }
      for (const selection of store.listSelections(mutation.ownerId)) {
        const previous = previousSelections.find((entry) => entry.memoryId === selection.memoryId);
        if (!previous) {
          createdMemories.add(selection.memoryId);
          continue;
        }
        if (previous.revision === selection.revision) continue;
        const key = `${epochKey(mutation.scope, mutation.ownerId)}:${selection.memoryId}`;
        const revisions = ownRevisions.get(key) ?? new Map<number, number>();
        revisions.set(previous.revision, selection.revision);
        ownRevisions.set(key, revisions);
      }
      if (this.#storedState(mutation) === before) continue;
      if (mutation.scope === "user") userChanged = true;
      else affectedAgents.add(mutation.ownerId);
      const committed = changes.get(mutation.senderAgentId) ?? [];
      committed.push(...this.#committedChanges(mutation, previousMemory, previousIds));
      changes.set(mutation.senderAgentId, committed);
    }
    for (const agentId of affectedAgents) this.stateChanged(agentId);
    if (userChanged) this.userStateChanged();
    return changes;
  }

  /** What one committed mutation did to the memory texts. A change of inclusion only is not shown. */
  #committedChanges(
    mutation: PendingMemoryMutation,
    previous: AgentMemory | null,
    previousIds: ReadonlySet<string> | null,
  ): ConversationMemoryChange[] {
    if (mutation.type === "selection") return [];
    const store = this.#store(mutation.scope);
    if (mutation.type === "forget") {
      if (!previous || store.get(mutation.ownerId, mutation.memoryId)) return [];
      return [{ memoryId: previous.id, action: "forgotten", text: previous.text }];
    }
    if (previous) {
      const current = store.get(mutation.ownerId, previous.id);
      if (!current || current.text === previous.text) return [];
      return [{ memoryId: current.id, action: "updated", text: current.text, previousText: previous.text }];
    }
    return store
      .list(mutation.ownerId)
      .filter((memory) => !previousIds?.has(memory.id))
      .map((memory) => ({ memoryId: memory.id, action: "saved" as const, text: memory.text }));
  }

  /** Reserve prompt space for this turn's staged changes, without making them visible to search. */
  #plannedContext(scope: MemoryScope, agentId: string, turnId: string, exceptCallId: string) {
    const store = this.#store(scope);
    const all = new Map<string, Pick<AgentMemory, "id" | "text" | "origin">>(
      store.list(agentId).map((memory) => [memory.id, memory]),
    );
    const selected = new Map<string, Pick<AgentMemory, "id" | "text" | "origin">>(
      this.#withInclusion(scope, agentId, "essential").map((memory) => [memory.id, memory]),
    );
    for (const pending of this.#pending.get(turnId) ?? []) {
      if (
        pending.scope !== scope ||
        pending.ownerId !== agentId ||
        pending.callId === exceptCallId ||
        pending.epoch !== this.#epoch(scope, agentId)
      )
        continue;
      if (pending.type === "selection") {
        for (const change of pending.changes) {
          const memory = all.get(change.memoryId);
          if (change.inclusion === "essential" && memory) selected.set(memory.id, memory);
          else selected.delete(change.memoryId);
        }
      } else if (pending.type === "forget") {
        selected.delete(pending.memoryId);
        all.delete(pending.memoryId);
      } else {
        const duplicate = [...all].find(([, memory]) => memory.text === pending.text && memory.id !== pending.memoryId);
        const key = duplicate?.[0] ?? pending.memoryId ?? `pending:${pending.callId}`;
        if (duplicate && pending.memoryId) {
          selected.delete(pending.memoryId);
          all.delete(pending.memoryId);
        }
        const memory = duplicate?.[1] ?? {
          id: pending.memoryId ?? "00000000-0000-0000-0000-000000000000",
          text: pending.text,
          origin: "automatic" as const,
        };
        all.set(key, memory);
        if (pending.inclusion === "essential") selected.set(key, memory);
        else selected.delete(key);
      }
    }
    return { all, essential: selected };
  }

  #storedState(mutation: PendingMemoryMutation): string {
    const store = this.#store(mutation.scope);
    return JSON.stringify({
      memories: store.list(mutation.ownerId),
      selection: store.listSelections(mutation.ownerId),
    });
  }

  #commitRemember(mutation: Extract<PendingMemoryMutation, { type: "remember" }>, createdMemories: Set<string>): void {
    const store = this.#store(mutation.scope);
    store.withMemoryTransaction(() => {
      const duplicate = store
        .list(mutation.ownerId)
        .find((memory) => memory.id !== mutation.memoryId && memory.text === mutation.text);
      const duplicateSelection = duplicate ? store.getSelection(mutation.ownerId, duplicate.id) : null;
      if (mutation.duplicate) {
        if (
          duplicate?.id !== mutation.duplicate.memoryId ||
          duplicateSelection?.revision !== mutation.duplicate.expectedRevision
        )
          return;
      } else if (duplicate && !createdMemories.has(duplicate.id)) return;
      if (duplicateSelection?.userControlled && duplicateSelection.inclusion !== mutation.inclusion) return;
      if (mutation.memoryId) {
        const current = store.get(mutation.ownerId, mutation.memoryId);
        const selection = store.getSelection(mutation.ownerId, mutation.memoryId);
        if (
          !current ||
          !selection ||
          selection.revision !== mutation.expectedSelectionRevision ||
          (duplicate && selection.userControlled)
        )
          return;
        // An explicit move to searchable can make room for a longer corrected text.
        if (mutation.inclusion === "searchable" && selection.inclusion === "essential") {
          store.setInclusions(
            mutation.ownerId,
            [{ memoryId: current.id, inclusion: "searchable", expectedRevision: selection.revision }],
            "agent",
          );
        }
      }
      const memory = store.saveAutomatic({
        agentId: mutation.ownerId,
        ...(mutation.memoryId ? { memoryId: mutation.memoryId } : {}),
        text: mutation.text,
        sourceTurnId: mutation.sourceTurnId,
      });
      if (!memory) return;
      const selection = store.getSelection(mutation.ownerId, memory.id);
      if (!selection || selection.inclusion === mutation.inclusion || selection.userControlled) return;
      const next = [...this.#withInclusion(mutation.scope, mutation.ownerId, "essential"), memory];
      // Another turn may have used the remaining budget. Keep the saved text searchable.
      if (mutation.inclusion === "essential" && store.essentialBytes(next) > store.budgetBytes) return;
      store.setInclusions(
        mutation.ownerId,
        [{ memoryId: memory.id, inclusion: mutation.inclusion, expectedRevision: selection.revision }],
        "agent",
      );
    });
  }

  clearPending(): void {
    this.#pending.clear();
  }

  /**
   * A memory change invalidates the developer instructions the provider was started with, so every
   * thread of the agent is unloaded and the next turn on each of them rebuilds them.
   */
  stateChanged(agentId: string): void {
    const agent = this.#conversation.requireKnownAgent(agentId);
    this.#conversation.unloadAgentThreads(agent.id);
    this.#emit({ type: "memories-changed", agentId });
  }

  /** A user-memory change invalidates the instructions of every agent, as `stateChanged` does for one. */
  userStateChanged(): void {
    for (const agentId of this.#listAgentIds()) this.#conversation.unloadAgentThreads(agentId);
    this.#emit({ type: "user-memories-changed" });
  }

  /**
   * The agent's memories, by id, once this turn's staged changes commit, replayed in staging order
   * as `finishTurn` applies them. A staged change that commit would skip, such as a forget of a
   * memory the same turn already updated, is skipped here too.
   *
   * Another turn of the agent, such as a channel turn beside its chat, commits apart: before this
   * one, after it, or never. So its new memories hold a place, and its forgets and updates free none.
   * A memory that another turn changes counts, but this turn can neither fold into it nor remove it.
   * A null text never matches.
   */
  #projectedMemories(
    scope: MemoryScope,
    agentId: string,
    turnId: string,
    exceptCallId: string,
  ): Map<string, { text: string | null; updatedAt: string | null }> {
    const epoch = this.#epoch(scope, agentId);
    const counts = (mutation: PendingMemoryMutation) =>
      mutation.scope === scope &&
      mutation.ownerId === agentId &&
      mutation.epoch === epoch &&
      mutation.callId !== exceptCallId;
    const others = [...this.#pending]
      .filter(([pendingTurnId]) => pendingTurnId !== turnId)
      .flatMap(([, pending]) => pending.filter(counts));
    const changedElsewhere = new Set(others.flatMap((mutation) => (mutation.memoryId ? [mutation.memoryId] : [])));
    const memories = new Map<string, { text: string | null; updatedAt: string | null }>(
      this.#store(scope)
        .list(agentId)
        .map((memory) => [
          memory.id,
          changedElsewhere.has(memory.id)
            ? { text: null, updatedAt: null }
            : { text: normalizeMemoryText(memory.text), updatedAt: memory.updatedAt },
        ]),
    );
    for (const mutation of (this.#pending.get(turnId) ?? []).filter(counts)) {
      if (mutation.type === "selection") continue;
      if (mutation.type === "forget") {
        if (memories.get(mutation.memoryId)?.updatedAt === mutation.expectedUpdatedAt)
          memories.delete(mutation.memoryId);
        continue;
      }
      const text = normalizeMemoryText(mutation.text);
      const same = [...memories].find(([, memory]) => memory.text === text)?.[0];
      if (!mutation.memoryId) {
        if (same === undefined) memories.set(`staged:${mutation.callId}`, { text, updatedAt: null });
        continue;
      }
      const current = memories.get(mutation.memoryId);
      if (
        !current ||
        changedElsewhere.has(mutation.memoryId) ||
        (current.updatedAt !== null &&
          mutation.expectedUpdatedAt !== undefined &&
          current.updatedAt !== mutation.expectedUpdatedAt)
      )
        continue;
      // An update to the text of another memory folds the two into one.
      if (same !== undefined && same !== mutation.memoryId) memories.delete(mutation.memoryId);
      else memories.set(mutation.memoryId, { text, updatedAt: null });
    }
    for (const mutation of others) {
      if (mutation.type === "remember" && !mutation.memoryId)
        memories.set(`reserved:${mutation.callId}`, { text: null, updatedAt: null });
    }
    return memories;
  }

  /** A step of the turn's activity, so the chat shows that the agent looked in its memory. */
  #emitRecallProgress(params: DynamicToolCallParams, agentId: string, count: number): void {
    this.#emit({
      type: "turn-progress",
      agentId,
      threadId: this.#conversation.publicThreadId(agentId, params.threadId),
      turnId: params.turnId,
      detail: sourceText("status.agent.memoriesSearched", { count }),
    });
  }

  #stage(turnId: string, mutation: PendingMemoryMutation): void {
    const pending = this.#pending.get(turnId) ?? [];
    if (!pending.some((candidate) => candidate.callId === mutation.callId)) pending.push(mutation);
    this.#pending.set(turnId, pending);
  }

  #epoch(scope: MemoryScope, ownerId: string): number {
    return this.#epochs.get(epochKey(scope, ownerId)) ?? 0;
  }
}

const MEMORY_TOOLS = new Set(["search_memories", "list_memories", "set_memory_inclusion", "remember", "forget_memory"]);

function epochKey(scope: MemoryScope, ownerId: string): string {
  return `${scope}:${ownerId}`;
}

/** The optional `scope` argument of a memory tool. Omitted, the agent's own memories. Null when invalid. */
function toolScope(args: unknown): MemoryScope | null {
  const scope = isRecord(args) ? args.scope : undefined;
  if (scope === undefined) return "agent";
  return scope === "agent" || scope === "user" ? scope : null;
}

function notInScope(scope: MemoryScope) {
  return scope === "user" ? "This memory is not a user memory." : "This memory does not belong to the current agent.";
}

/** Redaction can expand text, so bound the final provider payload as well as the store result. */
function memoryRecallResult(
  result: AgentMemorySearchResult | AgentMemoryListPage,
  redact: (value: string) => string,
): { response: OpenBotToolResponse; count: number } {
  while (
    Buffer.byteLength(redact(JSON.stringify(result)), "utf8") > AGENT_MEMORY_CONTEXT_BUDGET_BYTES &&
    result.memories.length > 0
  ) {
    result.memories.pop();
    result.hasMore = true;
    if ("nextCursor" in result) result.nextCursor = result.memories.at(-1)?.id ?? null;
  }
  return {
    response: { success: true, contentItems: [{ type: "inputText", text: redact(JSON.stringify(result)) }] },
    count: result.memories.length,
  };
}
