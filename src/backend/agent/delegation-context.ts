// The delegator context: a short excerpt of the conversation of the agent that delegates a task, which
// the agent that does the task reads before the request. `create_agent` sends it by default and
// `send_message` only when the caller asks (`includeContext`).
//
// The excerpt lives in memory only, keyed by the message it goes with: no released delivery shape or
// stored row changes. A delivery that starts after OpenBot restarts has no excerpt, as before.

import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import type { QueueDelivery } from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";
import { renderHandoffMessage } from "./delivery-content";
import type { readHandoffHistory } from "./handoff-history";

/** The whole excerpt, so a delegated prompt stays small. */
export const DELEGATION_CONTEXT_CHARACTERS = 6_000;
const DELEGATION_MESSAGE_CHARACTERS = 1_500;
/** Excerpts kept for messages that have not started yet. The oldest goes first. */
const KEPT_CONTEXTS = 200;

export interface DelegatorContext {
  senderAgentId: string;
  excerpt: string;
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n[... omitted ...]\n";
  const length = Math.max(0, limit - marker.length);
  return `${text.slice(0, Math.ceil(length / 2))}${marker}${text.slice(-Math.floor(length / 2))}`;
}

/**
 * The newest messages of the delegator's conversation, oldest first, up to `budget` characters.
 * Secrets are redacted. Null when the conversation has no message.
 */
export function renderDelegationHandoff(
  history: Pick<ReturnType<typeof readHandoffHistory>, "recent">,
  names: ReadonlyMap<string, string>,
  budget = DELEGATION_CONTEXT_CHARACTERS,
): string | null {
  const kept = new Map<string, string>();
  let size = 0;
  // Newest first, so a long chat keeps its end.
  for (const row of history.recent) {
    const text = cut(redactText(renderHandoffMessage(row.message, names)), DELEGATION_MESSAGE_CHARACTERS);
    if (size + text.length + 2 > budget) break;
    kept.set(row.message.id, text);
    size += text.length + 2;
  }
  if (!kept.size) return null;
  return sortConversationMessages(history.recent.map((row) => row.message))
    .flatMap((message) => (kept.has(message.id) ? [kept.get(message.id)] : []))
    .join("\n\n");
}

/** The excerpts that wait for their delivery to start. One instance lives in the agent service. */
export class DelegationContexts {
  readonly #byMessage = new Map<string, DelegatorContext>();
  readonly #byNewAgent = new Map<string, DelegatorContext>();

  #keep(map: Map<string, DelegatorContext>, key: string, context: DelegatorContext): void {
    map.delete(key);
    map.set(key, context);
    while (map.size > KEPT_CONTEXTS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /** For a `send_message` message to each of its recipients. */
  setForMessage(messageId: string, context: DelegatorContext): void {
    this.#keep(this.#byMessage, messageId, context);
  }

  /** For the first message of an agent that `create_agent` makes. */
  setForNewAgent(agentId: string, context: DelegatorContext): void {
    this.#keep(this.#byNewAgent, agentId, context);
  }

  /**
   * The excerpt of a delivery. A message's excerpt stays for a retry; a new agent's excerpt goes with
   * its first delivery only.
   */
  forDelivery(delivery: Pick<QueueDelivery, "messageId" | "recipientAgentId">): DelegatorContext | null {
    const message = this.#byMessage.get(delivery.messageId);
    if (message) return message;
    const created = this.#byNewAgent.get(delivery.recipientAgentId);
    if (!created) return null;
    this.#byNewAgent.delete(delivery.recipientAgentId);
    this.#keep(this.#byMessage, delivery.messageId, created);
    return created;
  }
}
