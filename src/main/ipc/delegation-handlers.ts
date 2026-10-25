// The delegation tiers of this computer. No Team API route reaches these.

import { decodeDelegationTiers } from "@openbot/contracts/ipc";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { DelegationTierStore } from "../delegation-tier-store";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";

export function delegationIpcHandlers(tiers: DelegationTierStore): Pick<IpcGroupHandlers, "delegation"> {
  return {
    delegation: {
      getTiers: handler(() => tiers.get()),
      setTiers: payloadHandler(decodeDelegationTiers, (next) => runCauseEffect(tiers.set(next))),
    },
  };
}
