// Magpie (github.com/yetone/magpie) is a local LLM gateway. These reads are shared by main, which
// finds and starts the gateway, and by the Claude client, which runs the `magpie` provider through
// the gateway's Anthropic-compatible API.
//
// Magpie keeps its port in its own settings file. The file can be missing, and its shape is not a
// released contract, so the parser reads only a numeric `port` at the top level or under `server`
// or `gateway`, and falls back to the default port.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAGPIE_API_KEY, MAGPIE_DEFAULT_PORT } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema } from "effect";

/** A gateway on this computer answers at once. */
const HEALTH_TIMEOUT_MS = 1_500;
const MODELS_TIMEOUT_MS = 5_000;

export class MagpieGatewayFailure extends Schema.TaggedError<MagpieGatewayFailure>()("MagpieGatewayFailure", {
  message: Schema.String,
}) {}

export function defaultMagpieLocation(): MagpieSettingsLocation {
  return { platform: process.platform, home: homedir(), env: process.env };
}

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
  /** The name that the gateway shows, when it gives one. */
  name?: string;
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

function displayName(entry: DynamicRecord): string | null {
  for (const key of ["display_name", "magpie_label", "name"]) {
    const value = entry[key];
    if (isString(value) && value.trim() && value.trim().length <= MAX_ID_LENGTH) return value.trim();
  }
  return null;
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
    const name = displayName(entry);
    models.push({ id, ...(name ? { name } : {}), group: isGroup(entry), reasoningLevels: reasoningLevels(entry) });
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

/** The gateway origin on this computer, read at each use, so a port change needs no restart. */
export const magpieGatewayOrigin = Effect.fn("MagpieGateway.origin")(function* (
  location: MagpieSettingsLocation = defaultMagpieLocation(),
) {
  return magpieOrigin(yield* resolveMagpiePort(location));
});

/**
 * The `X-Magpie-Session` value of a thread: stable for the thread, so Magpie routes the requests of
 * one thread together, and a hash, so the gateway does not see OpenBot's own id.
 */
export function magpieSessionId(threadId: string): string {
  return `openbot-${createHash("sha256").update(threadId).digest("hex").slice(0, 32)}`;
}
