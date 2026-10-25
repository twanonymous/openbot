import type { AgentMemory } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { USER_MEMORY_OWNER } from "../user-memory-schema";
import type { MemoryScope } from "./agent-memories";
import { relevantMemoriesBlock } from "./developer-instructions";

/** The memories recall reads: committed searchable matches of a word search, best first. */
export interface RecallSource {
  recall(scope: MemoryScope, ownerId: string, query: string, limit: number): AgentMemory[];
}

/** At most this many memories, and this many bytes of memory text, go with one message. */
export const RECALL_LIMIT = 5;
export const RECALL_BUDGET_BYTES = 1536;
/** The provider sessions whose sent memories recall keeps. The oldest goes first. */
const REMEMBERED_THREADS = 256;
/** The search takes up to 256 characters of words. */
const QUERY_LENGTH = 256;

// Words so common that a match on them says nothing. Only English: a word in another language that is
// this common is usually short, and short words are dropped anyway.
const STOP_WORDS = new Set(
  (
    "the and for are but not you your yours all any can had has have her him his how its was were what when " +
    "where which who whom why will with would should could this that these those there their them they then " +
    "than from into onto about after before just also some such only very more most other our ours out own " +
    "please thanks thank does did done doing been being here let lets get got make made want need like know"
  ).split(" "),
);

/** The words of a message that a memory search can match, most of the message first. */
export function recallQuery(text: string): string | null {
  const words: string[] = [];
  let length = 0;
  const seen = new Set<string>();
  for (const match of text.slice(0, 4000).matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const word = match[0];
    const key = word.toLowerCase();
    // A CJK word has no spaces, so the tokenizer keeps a whole phrase as one word; two characters are a word.
    const short = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(word)
      ? word.length < 2
      : word.length < 3;
    if (short || STOP_WORDS.has(key) || seen.has(key)) continue;
    if (length + word.length + 1 > QUERY_LENGTH) break;
    seen.add(key);
    words.push(word);
    length += word.length + 1;
  }
  return words.length > 0 ? words.join(" ") : null;
}

/**
 * Finds the saved memories that fit an incoming message, so the agent reads them without a
 * search_memories call. Only searchable memories: the essential ones are in the prompt already. A
 * word search, no model call. A memory goes once per provider session; a new session, such as one
 * after a handoff, can get it again.
 */
export class MemoryRecall {
  readonly #source: RecallSource;
  readonly #sent = new Map<string, Set<string>>();

  constructor(source: RecallSource) {
    this.#source = source;
  }

  /** The block to send before the message, or null when no new memory fits it. */
  block(agentId: string, providerThreadId: string, text: string): string | null {
    const query = recallQuery(text);
    if (!query) return null;
    const sent = this.#sent.get(providerThreadId) ?? new Set<string>();
    const fresh = (scope: MemoryScope, ownerId: string) =>
      this.#source
        .recall(scope, ownerId, query, RECALL_LIMIT + sent.size)
        .filter((memory) => !sent.has(memory.id))
        .map((memory) => ({ id: memory.id, scope, text: redactText(memory.text) }));
    const agent = fresh("agent", agentId);
    const user = fresh("user", USER_MEMORY_OWNER);
    // Best first from each scope, by turns, so neither scope fills the block alone.
    const ranked = Array.from({ length: Math.max(agent.length, user.length) }, (_, index) =>
      [agent[index], user[index]].filter((entry) => entry !== undefined),
    ).flat();
    const selected: typeof ranked = [];
    let bytes = 0;
    for (const memory of ranked) {
      if (selected.length >= RECALL_LIMIT) break;
      const size = Buffer.byteLength(memory.text, "utf8");
      if (bytes + size > RECALL_BUDGET_BYTES) continue;
      selected.push(memory);
      bytes += size;
    }
    if (selected.length === 0) return null;
    for (const memory of selected) sent.add(memory.id);
    this.#sent.delete(providerThreadId);
    this.#sent.set(providerThreadId, sent);
    for (const threadId of this.#sent.keys()) {
      if (this.#sent.size <= REMEMBERED_THREADS) break;
      this.#sent.delete(threadId);
    }
    return relevantMemoriesBlock(selected);
  }
}
