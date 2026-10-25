import {
  type AgentModelOption,
  type DelegationTiers,
  isAgentModelOption,
  type MagpieGatewaySettings,
} from "@openbot/contracts/ipc";
import type {
  ProviderDelegationTiers,
  ProviderMagpieGateway,
} from "@openbot/ui/features/settings/ProviderSettingsPage";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore } from "solid-js";

/**
 * The delegation tiers of this computer, for Settings > Providers. Main holds them; the models are
 * the ones this computer lists now. Undefined while `enabled` is false, as for a joined server.
 */
export function createProviderDelegationTiers(enabled: () => boolean): () => ProviderDelegationTiers | undefined {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    value: DelegationTiers | null;
    models: AgentModelOption[];
    pending: boolean;
    error: string | null;
  }>({ value: null, models: [], pending: false, error: null });

  createEffect(enabled, (on) => {
    if (!on) return;
    Promise.all([window.openbot.delegation.getTiers(), window.openbot.agent.listModels()]).then(
      ([tiers, models]) =>
        setState((draft) => {
          draft.value = tiers;
          // A model of a provider that this build does not know cannot be a tier's model.
          draft.models = models.filter(isAgentModelOption);
          draft.error = null;
        }),
      (error: unknown) =>
        setState((draft) => {
          draft.error = errorMessage(error, t("provider.tiers.loadFailed"));
        }),
    );
  });

  async function save(tiers: DelegationTiers): Promise<void> {
    if (state.pending) return;
    setState((draft) => {
      draft.pending = true;
      draft.error = null;
    });
    try {
      const next = await window.openbot.delegation.setTiers(tiers);
      setState((draft) => {
        draft.value = next;
      });
    } catch (error) {
      setState((draft) => {
        draft.error = errorMessage(error, t("provider.tiers.saveFailed"));
      });
    } finally {
      setState((draft) => {
        draft.pending = false;
      });
    }
  }

  const tiers: ProviderDelegationTiers = {
    get value() {
      return state.value;
    },
    get models() {
      return state.models;
    },
    get pending() {
      return state.pending;
    },
    get error() {
      return state.error;
    },
    onChange: (next) => void save(next),
  };
  return () => (enabled() ? tiers : undefined);
}

/** The Magpie gateway of this computer, for the Magpie page. Undefined while `enabled` is false. */
export function createProviderMagpieGateway(enabled: () => boolean): () => ProviderMagpieGateway | undefined {
  const [state, setState] = createStore<{ value: MagpieGatewaySettings | null; pending: boolean }>({
    value: null,
    pending: false,
  });

  createEffect(enabled, (on) => {
    if (!on) return;
    window.openbot.providerDetection.getMagpie().then(
      (value) =>
        setState((draft) => {
          draft.value = value;
        }),
      () => undefined,
    );
  });

  async function setAutoStart(autoStart: boolean): Promise<void> {
    if (state.pending) return;
    setState((draft) => {
      draft.pending = true;
    });
    try {
      const value = await window.openbot.providerDetection.setMagpieAutoStart(autoStart);
      setState((draft) => {
        draft.value = value;
      });
    } finally {
      setState((draft) => {
        draft.pending = false;
      });
    }
  }

  const magpie: ProviderMagpieGateway = {
    get value() {
      return state.value;
    },
    get pending() {
      return state.pending;
    },
    onAutoStartChange: (autoStart) => void setAutoStart(autoStart).catch(() => undefined),
  };
  return () => (enabled() ? magpie : undefined);
}
