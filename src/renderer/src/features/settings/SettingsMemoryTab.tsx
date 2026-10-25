import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SettingsSection,
  SwitchField,
  toast,
} from "@openbot/ui";
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { useI18n } from "../../i18n-context";
import { AgentMemoriesModal } from "../conversation/AgentMemoriesModal";
import { userMemoriesPort } from "../conversation/memories-port";

interface SettingsMemoryTabProps {
  /** The tab is on screen. It reads the memories and the setting each time it shows. */
  visible: boolean;
}

/**
 * What every agent knows about the user, and whether OpenBot keeps facts before a conversation's
 * context is lost. The memories open in the same dialog as an agent's own memories. Both stay on this
 * computer.
 */
export function SettingsMemoryTab(props: SettingsMemoryTabProps) {
  const i18n = useI18n();
  const api = window.openbot.userMemories;
  const port = createMemo(() => userMemoriesPort(i18n.t("settings.memory.ownerLabel")));
  const [open, setOpen] = createSignal(false);
  const [count, setCount] = createSignal<number | null>(null);
  const [capture, setCapture] = createSignal<boolean | null>(null);
  const [savingCapture, setSavingCapture] = createSignal(false);

  async function load(): Promise<void> {
    const [memories, preference] = await Promise.all([
      api.list().catch(() => null),
      api.getCapture().catch(() => null),
    ]);
    setCount(memories?.length ?? null);
    if (preference) setCapture(preference.enabled);
  }

  createEffect(
    () => props.visible,
    (visible) => {
      if (!visible) return;
      void untrack(() => load());
      return window.openbot.agent.onEvent((event) => {
        if (event.type === "user-memories-changed") void load();
      });
    },
  );

  async function changeCapture(enabled: boolean): Promise<void> {
    const previous = capture();
    setCapture(enabled);
    setSavingCapture(true);
    try {
      setCapture((await api.setCapture({ enabled })).enabled);
    } catch {
      setCapture(previous);
      toast.error(i18n.t("settings.memory.capture.saveFailed"), {
        report: { operation: "settings", source: "system", cause_code: "unknown" },
      });
    } finally {
      setSavingCapture(false);
    }
  }

  return (
    <>
      <SettingsSection title={i18n.t("settings.memory.about.section")}>
        <ItemGroup class="settings-modal-card">
          <Item data-settings-row="settings.memory.about.title">
            <ItemContent>
              <ItemTitle>{i18n.t("settings.memory.about.title")}</ItemTitle>
              <ItemDescription>
                {i18n.t("settings.memory.about.description")}
                {count() === null ? "" : ` ${i18n.t("settings.memory.about.count", { count: count() ?? 0 })}`}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
                {i18n.t("settings.memory.about.manage")}
              </Button>
            </ItemActions>
          </Item>
          <SwitchField
            data-settings-row="settings.memory.capture.title"
            checked={capture() ?? true}
            disabled={capture() === null || savingCapture()}
            onChange={(checked) => void changeCapture(checked)}
            label={i18n.t("settings.memory.capture.title")}
            description={i18n.t("settings.memory.capture.description")}
          />
        </ItemGroup>
      </SettingsSection>
      <AgentMemoriesModal port={port()} open={open()} onOpenChange={setOpen} onCountChange={setCount} />
    </>
  );
}
