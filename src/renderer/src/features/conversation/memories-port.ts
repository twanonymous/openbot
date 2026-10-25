// The seam that lets one memories modal serve an agent, a channel, and the user memories that every
// agent shares.
//
// Everything the modal renders is owner-agnostic; only the five calls, the event filter and three
// words of copy are not. They live here, so `AgentMemoriesModal` names no owner at all.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentMemorySelectionState,
  MemoryEntry,
  OpenBotDesktopApi,
  SetAgentMemoryInclusionInput,
} from "@openbot/contracts/ipc";

export interface MemoriesPort {
  ownerId: string;
  /** The name the modal shows the user, such as `Chief` or `Project Falcon`. */
  ownerLabel: string;
  /** The word the modal reads in its sentences: "This agent has no saved memories yet." */
  ownerNoun: "agent" | "channel" | "user";
  /** Null when another computer holds the cap: its host refuses a memory past it. */
  limit: number | null;
  list: () => Promise<MemoryEntry[]>;
  selection?: {
    read: () => Promise<AgentMemorySelectionState | null>;
    set: (changes: SetAgentMemoryInclusionInput["changes"]) => Promise<AgentMemorySelectionState>;
  };
  create: (text: string) => Promise<void>;
  update: (memoryId: string, text: string) => Promise<void>;
  remove: (memoryId: string) => Promise<void>;
  clear: () => Promise<void>;
  /** Returns the unsubscribe function. The owner-id filter belongs to the port, not the modal. */
  subscribe: (reload: () => void) => () => void;
}

export function agentMemoriesPort(agentId: string, agentName: string, limit: number | null): MemoriesPort {
  return {
    ownerId: agentId,
    ownerLabel: agentName,
    ownerNoun: "agent",
    limit,
    list: () => window.openbot.agent.listMemories(agentId),
    selection: {
      read: () => window.openbot.agent.getMemorySelection(agentId),
      set: (changes) => window.openbot.agent.setMemoryInclusion({ agentId, changes }),
    },
    create: async (text) => {
      await window.openbot.agent.createMemory({ agentId, text });
    },
    update: async (memoryId, text) => {
      await window.openbot.agent.updateMemory({ agentId, memoryId, text });
    },
    remove: (memoryId) => window.openbot.agent.deleteMemory({ agentId, memoryId }),
    clear: () => window.openbot.agent.clearMemories(agentId),
    subscribe: (reload) =>
      window.openbot.agent.onEvent((event) => {
        if (event.type === "memories-changed" && event.agentId === agentId) reload();
      }),
  };
}

/**
 * The user memories: what every agent of this computer knows about the user. Local only, so the
 * calls go to this computer whichever server is selected.
 */
export function userMemoriesPort(
  ownerLabel: string,
  api: OpenBotDesktopApi["userMemories"] = window.openbot.userMemories,
  onEvent: OpenBotDesktopApi["agent"]["onEvent"] = window.openbot.agent.onEvent,
): MemoriesPort {
  return {
    ownerId: "user",
    ownerLabel,
    ownerNoun: "user",
    limit: INPUT_LIMITS.userMemories,
    list: () => api.list(),
    selection: {
      read: () => api.getSelection(),
      set: (changes) => api.setInclusion({ changes }),
    },
    create: async (text) => {
      await api.create(text);
    },
    update: async (memoryId, text) => {
      await api.update({ memoryId, text });
    },
    remove: (memoryId) => api.delete(memoryId),
    clear: () => api.clear(),
    subscribe: (reload) =>
      onEvent((event) => {
        if (event.type === "user-memories-changed") reload();
      }),
  };
}

/** The host calls a channel's memories make. The desktop sends them through preload. */
export type ChannelMemoriesApi = Pick<
  OpenBotDesktopApi["agent"],
  | "listChannelMemories"
  | "createChannelMemory"
  | "updateChannelMemory"
  | "deleteChannelMemory"
  | "clearChannelMemories"
  | "onEvent"
>;

export function channelMemoriesPort(
  channelId: string,
  channelName: string,
  api: ChannelMemoriesApi = window.openbot.agent,
): MemoriesPort {
  return {
    ownerId: channelId,
    ownerLabel: channelName,
    ownerNoun: "channel",
    limit: INPUT_LIMITS.channelMemories,
    list: () => api.listChannelMemories(channelId),
    create: async (text) => {
      await api.createChannelMemory({ channelId, text });
    },
    update: async (memoryId, text) => {
      await api.updateChannelMemory({ channelId, memoryId, text });
    },
    remove: (memoryId) => api.deleteChannelMemory({ channelId, memoryId }),
    clear: () => api.clearChannelMemories(channelId),
    subscribe: (reload) =>
      api.onEvent((event) => {
        if (event.type === "channel-memories-changed" && event.channelId === channelId) reload();
      }),
  };
}
