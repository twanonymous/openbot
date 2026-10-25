import { DEFAULT_DELEGATION_TIERS, type DelegationTiers, decodeDelegationTiers } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * The delegation tiers of this computer (see `ipc-delegation-tiers.ts`). A lead agent reads them at
 * each `create_agent`, `update_profile` or `update_agents` call, so a change applies at once. A file
 * that is missing or not valid reads as no tier set.
 */
export type DelegationTierStore = PreferenceStore<DelegationTiers>;

export function createDelegationTierStore(path: string): DelegationTierStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_DELEGATION_TIERS,
    decode: (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
      try {
        return decodeDelegationTiers(parsed);
      } catch {
        return null;
      }
    },
  });
}
