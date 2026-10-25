// Finds, starts and stops the Magpie gateway (see `../backend/magpie.ts`). When the user turns this
// on, OpenBot starts `magpie serve` and stops it again on quit, but only a gateway that it started.

import { execFile, spawn } from "node:child_process";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { resolveAgentCommand } from "../backend/acp-agent-command";
import {
  checkMagpieHealth,
  defaultMagpieLocation,
  type FetchLike,
  listMagpieModels,
  type MagpieGatewayFailure,
  type MagpieModel,
  type MagpieSettingsLocation,
  magpieOrigin,
  resolveMagpiePort,
} from "../backend/magpie";
import { PreferenceStore } from "./preference-file";

/** How long a started gateway has to answer before OpenBot stops waiting for it. */
const START_WAIT_MS = 10_000;
const START_POLL_MS = 250;

// --- Start and stop ----------------------------------------------------------------------------

export interface MagpieStartDecisionInput {
  autoStart: boolean;
  healthy: boolean;
  executable: string | null;
  /** A process that OpenBot started and that has not exited. */
  alreadyStarted: boolean;
}

/** OpenBot starts `magpie serve` only when the user asked for it and nothing answers yet. */
export function shouldStartMagpie(input: MagpieStartDecisionInput): boolean {
  return input.autoStart && !input.healthy && input.executable !== null && !input.alreadyStarted;
}

/** A `.cmd` or `.bat` launcher (npm writes these on Windows) runs only through the shell. */
function needsShell(executable: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

export interface MagpieAutoStartPreference {
  autoStart: boolean;
}

export const DEFAULT_MAGPIE_PREFERENCE: MagpieAutoStartPreference = { autoStart: false };

export type MagpiePreferenceStore = PreferenceStore<MagpieAutoStartPreference>;

export function createMagpiePreferenceStore(path: string): MagpiePreferenceStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_MAGPIE_PREFERENCE,
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && typeof parsed.autoStart === "boolean"
        ? { autoStart: parsed.autoStart }
        : null,
  });
}

/** The part of a child process that the gateway uses. `ChildProcess` has it. */
export interface MagpieProcess {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  once(event: "exit" | "error", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface MagpieGatewayDependencies {
  preference: { get(): MagpieAutoStartPreference };
  fetch?: FetchLike;
  location?: MagpieSettingsLocation;
  readSettings?: (path: string) => Promise<string>;
  findExecutable?: () => Effect.Effect<string | null>;
  spawnServe?: (executable: string) => MagpieProcess;
  killProcess?: (child: MagpieProcess) => void;
  platform?: NodeJS.Platform;
}

export interface MagpieGatewayStatus {
  origin: string;
  running: boolean;
  startedByOpenBot: boolean;
}

/** Finds, starts and stops the gateway. One instance lives in main. */
export class MagpieGateway {
  readonly #deps: MagpieGatewayDependencies;
  readonly #platform: NodeJS.Platform;
  #child: MagpieProcess | null = null;

  constructor(dependencies: MagpieGatewayDependencies) {
    this.#deps = dependencies;
    this.#platform = dependencies.platform ?? process.platform;
  }

  #fetch(): FetchLike {
    return this.#deps.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The gateway's root address, from its settings file each time: the user can change the port. */
  origin(): Effect.Effect<string> {
    return resolveMagpiePort(this.#deps.location ?? defaultMagpieLocation(), this.#deps.readSettings).pipe(
      Effect.map(magpieOrigin),
    );
  }

  /** The OpenAI-compatible base URL, as the local server scan and the Pi extension use it. */
  baseUrl(): Effect.Effect<string> {
    return this.origin().pipe(Effect.map((origin) => `${origin}/v1`));
  }

  status(): Effect.Effect<MagpieGatewayStatus> {
    return Effect.gen({ self: this }, function* () {
      const origin = yield* this.origin();
      const running = yield* checkMagpieHealth(this.#fetch(), origin);
      return { origin, running, startedByOpenBot: this.#child !== null };
    });
  }

  models(): Effect.Effect<MagpieModel[], MagpieGatewayFailure> {
    return Effect.gen({ self: this }, function* () {
      return yield* listMagpieModels(this.#fetch(), yield* this.origin());
    });
  }

  #findExecutable(): Effect.Effect<string | null> {
    if (this.#deps.findExecutable) return this.#deps.findExecutable();
    return resolveAgentCommand("magpie").pipe(Effect.catch(() => Effect.succeed(null)));
  }

  #spawn(executable: string): MagpieProcess {
    if (this.#deps.spawnServe) return this.#deps.spawnServe(executable);
    return spawn(executable, ["serve"], {
      stdio: "ignore",
      windowsHide: true,
      shell: needsShell(executable, this.#platform),
    });
  }

  /**
   * Starts `magpie serve` when the user turned auto-start on, no gateway answers and a `magpie`
   * command is on PATH. Resolves with the status after the start; a gateway that does not answer in
   * time is left running and shows as not running.
   */
  ensureStarted(): Effect.Effect<MagpieGatewayStatus> {
    return Effect.gen({ self: this }, function* () {
      const before = yield* this.status();
      const autoStart = this.#deps.preference.get().autoStart;
      if (!autoStart || before.running || this.#child) return before;
      const executable = yield* this.#findExecutable();
      if (!shouldStartMagpie({ autoStart, healthy: before.running, executable, alreadyStarted: this.#child !== null }))
        return before;
      if (executable === null) return before;
      const child = yield* Effect.try(() => this.#spawn(executable)).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!child) return before;
      this.#child = child;
      child.once("error", () => {
        if (this.#child === child) this.#child = null;
      });
      child.once("exit", () => {
        if (this.#child === child) this.#child = null;
      });
      const deadline = Date.now() + START_WAIT_MS;
      while (Date.now() < deadline && this.#child === child) {
        if (yield* checkMagpieHealth(this.#fetch(), before.origin)) break;
        yield* Effect.sleep(START_POLL_MS);
      }
      return yield* this.status();
    });
  }

  /** Stops the gateway only when OpenBot started it. A gateway the user started keeps running. */
  stop(): Effect.Effect<void> {
    return Effect.sync(() => {
      const child = this.#child;
      this.#child = null;
      if (!child || child.exitCode !== null) return;
      if (this.#deps.killProcess) {
        this.#deps.killProcess(child);
        return;
      }
      if (this.#platform === "win32" && child.pid !== undefined) {
        // `shell: true` puts cmd.exe between OpenBot and Magpie, so the whole tree must end.
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
        return;
      }
      child.kill("SIGTERM");
    });
  }
}
