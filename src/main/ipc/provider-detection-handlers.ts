import { Effect } from "effect";

// Local model servers, the model list of one endpoint, and where the scan looks. This computer only:
// no Team API route reaches these.

import { runCauseEffect } from "../../backend/effect-boundary";
import type { MagpieGateway, MagpiePreferenceStore } from "../magpie-gateway";
import type { ProviderDetection } from "../provider-detection";
import type { ProviderDetectionSettingsStore } from "../provider-detection-settings-store";
import { handler, type IpcGroupHandlers, payloadHandler } from "./define-ipc-group";
import { parseDiscoverModels, parseProviderDetectionSettings } from "./provider-detection-inputs";

export interface ProviderDetectionIpcDependencies {
  detection: ProviderDetection;
  settings: Pick<ProviderDetectionSettingsStore, "get" | "set">;
  magpie: { gateway: Pick<MagpieGateway, "status" | "ensureStarted">; preference: MagpiePreferenceStore };
}

function parseAutoStart(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid auto-start value.");
  return value;
}

export function providerDetectionIpcHandlers({
  detection,
  settings,
  magpie,
}: ProviderDetectionIpcDependencies): Pick<IpcGroupHandlers, "providerDetection"> {
  return {
    providerDetection: {
      scanModelServers: handler(() => Effect.runPromise(detection.scanModelServers())),
      scanAgents: handler(() => Effect.runPromise(detection.scanAgents())),
      discoverModels: payloadHandler(parseDiscoverModels, (input) =>
        Effect.runPromise(detection.discoverModels(input)),
      ),
      getSettings: handler(() => settings.get()),
      setSettings: payloadHandler(parseProviderDetectionSettings, (next) => runCauseEffect(settings.set(next))),
      getMagpie: handler(() =>
        Effect.runPromise(
          magpie.gateway.status().pipe(Effect.map((status) => ({ ...status, ...magpie.preference.get() }))),
        ),
      ),
      // Turning auto-start on also starts the gateway now, when nothing answers.
      setMagpieAutoStart: payloadHandler(parseAutoStart, async (autoStart) => {
        await runCauseEffect(magpie.preference.set({ autoStart }));
        const status = await Effect.runPromise(autoStart ? magpie.gateway.ensureStarted() : magpie.gateway.status());
        return { ...status, autoStart };
      }),
    },
  };
}
