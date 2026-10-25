import {
  DELEGATION_TIER_HINTS,
  DELEGATION_TIER_IDS,
  type DelegationTierId,
  type DelegationTiers,
  isDelegationTierSet,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { AgentSettingsRefused } from "./agent-settings-refused";
import type { ModelRequest } from "./model-tools";

/** A tool request that can name a delegation tier in place of a provider and a model. */
export interface TieredModelRequest extends ModelRequest {
  tier?: DelegationTierId | undefined;
}

/**
 * The provider, model and effort that a request names, with its tier replaced by the tier's model.
 * A tier and a provider or model in one request are an error, as is a tier that the user has not
 * set. An effort in the request wins over the tier's effort. The caller still checks the result with
 * `requestedToolModel`, so a tier whose model the provider no longer lists is an error too.
 */
export function resolveTierRequest(request: TieredModelRequest, tiers: DelegationTiers): ModelRequest {
  const { tier: id, ...rest } = request;
  if (id === undefined) return rest;
  if (request.provider !== undefined || request.model !== undefined) {
    throw new AgentSettingsRefused(sourceText("error.agent.tierWithModel"));
  }
  const tier = tiers[id];
  if (!isDelegationTierSet(tier)) throw new AgentSettingsRefused(sourceText("error.agent.tierNotSet", { tier: id }));
  const reasoningEffort = request.reasoningEffort ?? tier.reasoningEffort ?? undefined;
  return {
    provider: tier.provider,
    model: tier.model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** The tiers that `list_models` shows: each one the user set, with when to use it. */
export function delegationTiersPayload(tiers: DelegationTiers) {
  return DELEGATION_TIER_IDS.flatMap((id) => {
    const tier = tiers[id];
    if (!isDelegationTierSet(tier)) return [];
    return [
      {
        tier: id,
        ...(tier.label ? { label: tier.label } : {}),
        useFor: DELEGATION_TIER_HINTS[id],
        provider: tier.provider,
        model: tier.model,
        ...(tier.reasoningEffort ? { reasoningEffort: tier.reasoningEffort } : {}),
      },
    ];
  });
}
