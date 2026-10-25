/**
 * Settings > Providers > Delegation tiers: one card for each tier, with the provider, the model and
 * the effort that a lead agent gives an agent it creates for a task of that difficulty.
 */

import { ProviderLogo } from "@openbot/brand";
import {
  type AgentModelOption,
  type AgentProviderId,
  type AgentReasoningEffort,
  agentProviderName,
  DELEGATION_TIER_IDS,
  type DelegationTier,
  type DelegationTierId,
  type DelegationTiers,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsSection,
} from "@openbot/ui";
import { For, Show } from "solid-js";
import { useText } from "../../text";

/** The tiers of this computer. `value` is null until main answers. */
export interface ProviderDelegationTiers {
  value: DelegationTiers | null;
  /** The models that this computer lists now, which a tier can name. */
  models: readonly AgentModelOption[];
  pending: boolean;
  /** A load or a save that failed. */
  error: string | null;
  onChange: (tiers: DelegationTiers) => void;
}

const TIER_TEXT = {
  fast: { title: "provider.tiers.fast", hint: "provider.tiers.fastHint" },
  balanced: { title: "provider.tiers.balanced", hint: "provider.tiers.balancedHint" },
  deep: { title: "provider.tiers.deep", hint: "provider.tiers.deepHint" },
} as const satisfies Record<DelegationTierId, { title: AppTextKey; hint: AppTextKey }>;

const EFFORT_TEXT = {
  low: "provider.effort.low",
  medium: "provider.effort.medium",
  high: "provider.effort.high",
  xhigh: "provider.effort.xhigh",
  max: "provider.effort.max",
} as const satisfies Record<AgentReasoningEffort, AppTextKey>;

/** The value of the "not set" and "model default" choices. No provider, model or effort has this id. */
const NONE = "";

interface Choice {
  id: string;
  name: string;
}

/** How many tiers name a model, for the list row. */
export function setDelegationTierCount(tiers: DelegationTiers | null): number {
  return tiers ? DELEGATION_TIER_IDS.filter((id) => tiers[id].provider && tiers[id].model).length : 0;
}

function ChoiceSelect(props: {
  label: string;
  choices: Choice[];
  value: string;
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  logo?: ((id: string) => AgentProviderId | null) | undefined;
  onChange: (id: string) => void;
}) {
  const selected = () => props.choices.find((choice) => choice.id === props.value) ?? props.choices[0] ?? null;
  const label = (choice: Choice) => (
    <span class="provider-settings-select-option">
      <Show when={props.logo?.(choice.id)}>
        {(provider) => <ProviderLogo provider={provider()} class="provider-picker-logo" />}
      </Show>
      {choice.name}
    </span>
  );
  return (
    <Select<Choice>
      class="provider-settings-select"
      options={props.choices}
      optionValue="id"
      optionTextValue="name"
      value={selected()}
      disabled={props.disabled}
      placement="bottom-end"
      // The select also reports the value that it shows, which is not a choice of the user.
      onChange={(choice) => {
        if (choice && choice.id !== props.value) props.onChange(choice.id);
      }}
      itemComponent={(item) => <SelectItem item={item.item}>{label(item.item.rawValue)}</SelectItem>}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue<Choice>>
          {(state) => {
            const choice = state.selectedOption();
            return choice ? label(choice) : "";
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent mount={props.menuMount} />
    </Select>
  );
}

function TierCard(props: {
  id: DelegationTierId;
  tiers: DelegationTiers;
  models: readonly AgentModelOption[];
  disabled: boolean;
  menuMount: HTMLElement | undefined;
  onChange: (tier: DelegationTier) => void;
}) {
  const { t } = useText();
  const tier = () => props.tiers[props.id];
  const title = () => t(TIER_TEXT[props.id].title);
  const providers = (): Choice[] => {
    const ids = [...new Set(props.models.map((model) => model.provider))];
    const current = tier().provider;
    if (current && !ids.includes(current)) ids.push(current);
    return [{ id: NONE, name: t("provider.tiers.notSet") }, ...ids.map((id) => ({ id, name: agentProviderName(id) }))];
  };
  const providerModels = () => props.models.filter((model) => model.provider === tier().provider);
  const models = (): Choice[] => {
    const choices = providerModels().map((model) => ({ id: model.id, name: model.name }));
    const current = tier().model;
    // A saved model that the provider no longer lists stays visible, so the user sees what to fix.
    if (current && !choices.some((choice) => choice.id === current)) choices.push({ id: current, name: current });
    return choices;
  };
  const selectedModel = () => providerModels().find((model) => model.id === tier().model);
  const efforts = (): Choice[] => [
    { id: NONE, name: t("provider.tiers.defaultEffort") },
    ...(selectedModel()?.supportedReasoningEfforts ?? []).map((effort) => ({
      id: effort,
      name: t(EFFORT_TEXT[effort]),
    })),
  ];
  const chooseProvider = (id: string) => {
    const provider = props.models.find((model) => model.provider === id)?.provider ?? null;
    const first = provider ? props.models.find((model) => model.provider === provider) : undefined;
    props.onChange({
      ...tier(),
      provider: first ? provider : null,
      model: first?.id ?? null,
      reasoningEffort: null,
    });
  };
  const chooseModel = (id: string) => {
    const model = providerModels().find((candidate) => candidate.id === id);
    if (!model) return;
    const effort = tier().reasoningEffort;
    props.onChange({
      ...tier(),
      model: model.id,
      reasoningEffort: effort && model.supportedReasoningEfforts.includes(effort) ? effort : null,
    });
  };
  const chooseEffort = (id: string) => {
    const effort = selectedModel()?.supportedReasoningEfforts.find((candidate) => candidate === id) ?? null;
    props.onChange({ ...tier(), reasoningEffort: effort });
  };
  return (
    <SettingsSection title={title()}>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("provider.tiers.provider")}</ItemTitle>
            <ItemDescription>{t(TIER_TEXT[props.id].hint)}</ItemDescription>
          </ItemContent>
          <ItemActions>
            <ChoiceSelect
              label={t("provider.tiers.providerLabel", { tier: title() })}
              choices={providers()}
              value={tier().provider ?? NONE}
              disabled={props.disabled}
              menuMount={props.menuMount}
              logo={(id) => props.models.find((model) => model.provider === id)?.provider ?? null}
              onChange={chooseProvider}
            />
          </ItemActions>
        </Item>
        <Show when={tier().provider}>
          <Item class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{t("provider.tiers.model")}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <ChoiceSelect
                label={t("provider.tiers.modelLabel", { tier: title() })}
                choices={models()}
                value={tier().model ?? NONE}
                disabled={props.disabled}
                menuMount={props.menuMount}
                onChange={chooseModel}
              />
            </ItemActions>
          </Item>
          <Show when={(selectedModel()?.supportedReasoningEfforts.length ?? 0) > 0}>
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemTitle>{t("provider.tiers.effort")}</ItemTitle>
              </ItemContent>
              <ItemActions>
                <ChoiceSelect
                  label={t("provider.tiers.effortLabel", { tier: title() })}
                  choices={efforts()}
                  value={tier().reasoningEffort ?? NONE}
                  disabled={props.disabled}
                  menuMount={props.menuMount}
                  onChange={chooseEffort}
                />
              </ItemActions>
            </Item>
          </Show>
        </Show>
      </ItemGroup>
    </SettingsSection>
  );
}

export function DelegationTiersPage(props: {
  tiers: ProviderDelegationTiers;
  disabled: boolean | undefined;
  menuMount: HTMLElement | undefined;
}) {
  const { t } = useText();
  return (
    <>
      <ItemGroup class="settings-modal-card">
        <Item class="settings-modal-row">
          <ItemContent>
            <ItemTitle>{t("provider.tiers.title")}</ItemTitle>
            <Show
              when={props.tiers.error}
              fallback={<ItemDescription>{t("provider.tiers.description")}</ItemDescription>}
            >
              {(message) => (
                <ItemDescription class="provider-settings-error" role="alert">
                  {message()}
                </ItemDescription>
              )}
            </Show>
          </ItemContent>
        </Item>
      </ItemGroup>
      <Show when={props.tiers.value}>
        {(tiers) => (
          <For each={[...DELEGATION_TIER_IDS]}>
            {(id) => (
              <TierCard
                id={id}
                tiers={tiers()}
                models={props.tiers.models}
                disabled={Boolean(props.disabled || props.tiers.pending)}
                menuMount={props.menuMount}
                onChange={(tier) => props.tiers.onChange({ ...tiers(), [id]: tier })}
              />
            )}
          </For>
        )}
      </Show>
    </>
  );
}
