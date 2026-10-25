// Magpie (github.com/yetone/magpie) is a local LLM gateway. OpenBot finds it, reads its model list
// and, when the user turns this on, starts `magpie serve` and stops it again on quit.
//
// Magpie keeps its port in its own settings file. The file can be missing, and its shape is not a
// released contract, so the parser reads only a numeric `port` at the top level or under `server`
// or `gateway`, and falls back to the default port.

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAGPIE_API_KEY, MAGPIE_DEFAULT_PORT } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";
import { resolveAgentCommand } from "../backend/acp-agent-command";
import { PreferenceStore } from "./preference-file";

/** A gateway on this computer answers at once. */
const HEALTH_TIMEOUT_MS = 1_500;
const MODELS_TIMEOUT_MS = 5_000;
/** How long a started gateway has to answer before OpenBot stops waiting for it. */
const START_WAIT_MS = 10_000;
const START_POLL_MS = 250;

export class MagpieGatewayFailure extends Schema.TaggedError<MagpieGatewayFailure>()("MagpieGatewayFailure", {
  message: Schema.String,
}) {}

// --- Port --------------------------------------------------------------------------------------

export interface MagpieSettingsLocation {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** The settings files to read, in order. The first one that names a valid port wins. */
export function magpieSettingsPaths(location: MagpieSettingsLocation): string[] {
  const paths = [join(location.home, ".config", "magpie", "settings.json")];
  if (location.platform === "win32") {
    const appData = location.env.APPDATA?.trim();
    if (appData) paths.push(join(appData, "magpie", "settings.json"));
    const profile = location.env.USERPROFILE?.trim();
    if (profile && profile !== location.home) paths.push(join(profile, ".config", "magpie", "settings.json"));
  }
  return [...new Set(paths)];
}

function validPort(value: unknown): number | null {
  const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** The port in a Magpie settings text, or null when the text names none. */
export function parseMagpiePort(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isDynamicRecord(parsed)) return null;
  const top = validPort(parsed.port);
  if (top !== null) return top;
  for (const key of ["server", "gateway"]) {
    const section = parsed[key];
    if (isDynamicRecord(section)) {
      const port = validPort(section.port);
      if (port !== null) return port;
    }
  }
  return null;
}

export const resolveMagpiePort = Effect.fn("MagpieGateway.resolvePort")(function* (
  location: MagpieSettingsLocation,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
) {
  for (const path of magpieSettingsPaths(location)) {
    const text = yield* Effect.tryPromise(() => read(path)).pipe(Effect.catch(() => Effect.succeed(null)));
    const port = text === null ? null : parseMagpiePort(text);
    if (port !== null) return port;
  }
  return MAGPIE_DEFAULT_PORT;
});

/** The gateway's root address. Its OpenAI-compatible API is under `/v1`. */
export function magpieOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// --- Health and models -------------------------------------------------------------------------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return "?";
  }
}

function withTimeout<A>(origin: string, timeoutMs: number, request: (signal: AbortSignal) => Promise<A>) {
  const host = hostOf(origin);
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    (controller) =>
      Effect.tryPromise({
        try: () => request(controller.signal),
        catch: () => new MagpieGatewayFailure({ message: sourceText("error.provider.discoveryUnreachable", { host }) }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(new MagpieGatewayFailure({ message: sourceText("error.provider.discoveryTimeout", { host }) })),
        }),
      ),
    (controller) => Effect.sync(() => controller.abort()),
  );
}

/** Whether a gateway answers `GET /api/hello` at the origin. Never fails. */
export const checkMagpieHealth = Effect.fn("MagpieGateway.checkHealth")(function* (
  fetchFn: FetchLike,
  origin: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
) {
  return yield* withTimeout(origin, timeoutMs, async (signal) => {
    const response = await fetchFn(`${origin}/api/hello`, { method: "GET", redirect: "manual", signal });
    await response.body?.cancel();
    return response.ok;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
});

/** One model or routing group that the gateway lists. */
export interface MagpieModel {
  id: string;
  /** A routing group that the gateway sends to one of several models. */
  group: boolean;
  /** Reasoning levels the gateway accepts for this id, when it lists them. */
  reasoningLevels: string[];
}

const MAX_MODELS = 256;
const MAX_ID_LENGTH = 200;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isString)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.length <= 32);
}

function reasoningLevels(entry: DynamicRecord): string[] {
  for (const key of ["reasoning_levels", "reasoningLevels", "reasoning_efforts", "reasoning_effort_levels"]) {
    const levels = stringList(entry[key]);
    if (levels.length > 0) return [...new Set(levels)];
  }
  const reasoning = entry.reasoning;
  if (isDynamicRecord(reasoning)) {
    const levels = stringList(reasoning.levels ?? reasoning.efforts);
    if (levels.length > 0) return [...new Set(levels)];
  }
  return [];
}

function isGroup(entry: DynamicRecord): boolean {
  return (
    entry.object === "group" ||
    entry.type === "group" ||
    entry.object === "routing_group" ||
    entry.type === "routing_group" ||
    Array.isArray(entry.models) ||
    Array.isArray(entry.members)
  );
}

/** The usable entries of a `/v1/models` body. Unknown entries are skipped, ids are not repeated. */
export function parseMagpieModels(body: unknown): MagpieModel[] {
  const entries = isDynamicRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const models: MagpieModel[] = [];
  for (const entry of entries) {
    if (models.length >= MAX_MODELS) break;
    if (!isDynamicRecord(entry) || !isString(entry.id)) continue;
    const id = entry.id.trim();
    if (!id || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, group: isGroup(entry), reasoningLevels: reasoningLevels(entry) });
  }
  return models;
}

export const listMagpieModels = Effect.fn("MagpieGateway.listModels")(function* (
  fetchFn: FetchLike,
  origin: string,
  timeoutMs = MODELS_TIMEOUT_MS,
) {
  const body = yield* withTimeout(origin, timeoutMs, async (signal) => {
    const response = await fetchFn(`${origin}/v1/models`, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${MAGPIE_API_KEY}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  });
  return parseMagpieModels(body);
});

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

function defaultLocation(): MagpieSettingsLocation {
  return { platform: process.platform, home: homedir(), env: process.env };
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
    return resolveMagpiePort(this.#deps.location ?? defaultLocation(), this.#deps.readSettings).pipe(
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
