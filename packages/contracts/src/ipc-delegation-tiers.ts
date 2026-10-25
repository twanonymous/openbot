/**
 * Delegation tiers: the models that a lead agent may give to the agents it creates, by how hard the
 * task is. The user sets a provider, a model and an effort for each tier in Settings > Providers. A
 * lead names a tier in `create_agent`, `update_profile` or `update_agents`, and OpenBot checks the
 * tier's model against the listed models as it checks a named model.
 *
 * This computer only: no Team API route carries the tiers. Not `fastServiceTier`, which is a
 * provider's fast mode of one model.
 */

import { type AgentProviderId, isAgentProvider } from "./agent-providers";
import { INPUT_LIMITS } from "./input-limits";
import { type AgentReasoningEffort, isAgentModel, isReasoningEffort } from "./ipc-agent-identity";
import { isBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

export const DELEGATION_TIER_IDS = ["fast", "balanced", "deep"] as const;
export type DelegationTierId = (typeof DELEGATION_TIER_IDS)[number];

/** A label that the user gives a tier. The tier id stays the name that agents use. */
export const DELEGATION_TIER_LABEL_LIMIT = 40;

/** One tier. A tier with no provider or no model is not set, and a lead cannot use it. */
export interface DelegationTier {
  provider: AgentProviderId | null;
  model: string | null;
  /** Null uses the model's default effort. */
  reasoningEffort: AgentReasoningEffort | null;
  label?: string;
}

export type DelegationTiers = Record<DelegationTierId, DelegationTier>;

const UNSET_TIER: DelegationTier = { provider: null, model: null, reasoningEffort: null };

export const DEFAULT_DELEGATION_TIERS: DelegationTiers = {
  fast: { ...UNSET_TIER },
  balanced: { ...UNSET_TIER },
  deep: { ...UNSET_TIER },
};

/**
 * When a lead uses each tier. Agents read this in `list_models` and in the tool descriptions, so it
 * is English prompt text, not interface text.
 */
export const DELEGATION_TIER_HINTS: Readonly<Record<DelegationTierId, string>> = {
  fast: "Quick lookups, formatting, renames and other small, clear tasks.",
  balanced: "Normal coding, reviews and research.",
  deep: "Hard reasoning, architecture, difficult bugs and plans that span many files.",
};

export function isDelegationTierId(value: unknown): value is DelegationTierId {
  return isOneOf(DELEGATION_TIER_IDS, value);
}

/** Whether a lead can use the tier: it names a provider and a model. */
export function isDelegationTierSet(
  tier: DelegationTier,
): tier is DelegationTier & { provider: AgentProviderId; model: string } {
  return tier.provider !== null && tier.model !== null;
}

function decodeTier(value: unknown): DelegationTier | null {
  if (!isDynamicRecord(value)) return null;
  const provider = value.provider ?? null;
  const model = value.model ?? null;
  const reasoningEffort = value.reasoningEffort ?? null;
  if (provider !== null && !isAgentProvider(provider)) return null;
  if (model !== null && !(isAgentModel(model) && isBoundedString(model, INPUT_LIMITS.modelName))) return null;
  if (reasoningEffort !== null && !isReasoningEffort(reasoningEffort)) return null;
  // A model without its provider, or a provider without a model, is half a choice: it is not set.
  const set = provider !== null && model !== null;
  const tier: DelegationTier = {
    provider: set ? provider : null,
    model: set ? model : null,
    reasoningEffort: set ? reasoningEffort : null,
  };
  if (value.label !== undefined) {
    if (!isBoundedString(value.label, DELEGATION_TIER_LABEL_LIMIT)) return null;
    const label = value.label.trim();
    if (label) tier.label = label;
  }
  return tier;
}

/**
 * The tiers in a saved file or an IPC payload. An unknown tier id is dropped and a missing one is not
 * set; a tier with a value that is not valid fails the whole decode, so a bad payload changes nothing.
 */
export function decodeDelegationTiers(value: unknown): DelegationTiers {
  if (!isDynamicRecord(value)) throw new Error("Invalid delegation tiers.");
  const tiers: DelegationTiers = {
    fast: { ...UNSET_TIER },
    balanced: { ...UNSET_TIER },
    deep: { ...UNSET_TIER },
  };
  for (const id of DELEGATION_TIER_IDS) {
    if (value[id] === undefined) continue;
    const tier = decodeTier(value[id]);
    if (!tier) throw new Error("Invalid delegation tiers.");
    tiers[id] = tier;
  }
  return tiers;
}
