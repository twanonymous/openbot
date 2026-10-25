import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyOnlyProviderId } from "@openbot/contracts/agent-providers";
import { MAGPIE_API_KEY } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import type { MagpieGatewayInfo } from "./magpie";
import type { PiMcpExtension } from "./pi-mcp";
import { type ProviderClientOperationError, providerCall } from "./provider-client-effects";

// Each extension takes the key from the environment and removes it before a tool can start a child
// process. The key is never written to the extension file. Pi runs an extension again when it
// switches sessions, so the key stays in a process slot for those later runs. Pi reads an apiKey
// that starts with `$` or `!` as an environment reference or a shell command, so the key is escaped
// to stay a literal. A header value reads `$` in the same way, but not a `!` after the start.
const readKey = (provider: KeyOnlyProviderId, variable: string) => `
  const slot = Symbol.for("openbot.pi.${provider}ApiKey");
  globalThis[slot] ??= process.env.${variable};
  delete process.env.${variable};
  const key = globalThis[slot];
  if (!key) return;
  const literal = key.replaceAll("$", "$$$$");
  const apiKey = literal.replace(/^!/, "$$!");`;

const KEY_EXTENSIONS = {
  // Inception serves Mercury through OpenAI chat completions. Pi has no built-in Inception provider,
  // so this extension registers one for this process only.
  inception: {
    variable: "OPENBOT_PI_INCEPTION_API_KEY",
    source: `export default function (pi) {${readKey("inception", "OPENBOT_PI_INCEPTION_API_KEY")}
  const levels = { off: "instant", minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
  const model = (id, name, contextWindow, maxTokens, cost) => ({
    id, name, reasoning: true, input: ["text"], contextWindow, maxTokens, cost, thinkingLevelMap: levels,
  });
  pi.registerProvider("inception", {
    baseUrl: "https://api.inceptionlabs.ai/v1",
    api: "openai-completions",
    apiKey,
    models: [
      model("mercury-3", "Mercury 3", 1000000, 131072, { input: 0.1, output: 0.35, cacheRead: 0.01, cacheWrite: 0 }),
      model("mercury-2.5", "Mercury 2.5", 260000, 65536, { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0 }),
      model("mercury-2", "Mercury 2", 128000, 50000, { input: 0.25, output: 0.75, cacheRead: 0.025, cacheWrite: 0 }),
    ],
  });
}
`,
  },
  // Pi has a built-in DeepSeek provider. A registration with only the key keeps its models, endpoint
  // and thinking levels, which Pi updates (checked in Pi 1.4.0). Pi prefers a DeepSeek key that
  // `/login` stored in auth.json to this apiKey, but the Authorization header replaces either one.
  deepseek: {
    variable: "OPENBOT_PI_DEEPSEEK_API_KEY",
    source: `export default function (pi) {${readKey("deepseek", "OPENBOT_PI_DEEPSEEK_API_KEY")}
  pi.registerProvider("deepseek", { apiKey, headers: { Authorization: "Bearer " + literal } });
}
`,
  },
} as const satisfies Record<KeyOnlyProviderId, { variable: string; source: string }>;

/** Owns one temporary, key-free extension file that gives a key-only provider its key in Pi. */
export const createPiKeyExtension = Effect.fn("PiKeyProviders.createExtension")(function* (
  provider: KeyOnlyProviderId,
  key: string,
  directory?: string,
) {
  const { variable, source } = KEY_EXTENSIONS[provider];
  const root = directory ?? tmpdir();
  yield* providerCall(() => mkdir(root, { recursive: true, mode: 0o700 }));
  const folder = yield* providerCall(() => mkdtemp(join(root, "openbot-pi-")));
  const path = join(folder, `${provider}.mjs`);
  yield* providerCall(() => writeFile(path, source, { mode: 0o600 })).pipe(
    Effect.onError(() => providerCall(() => rm(folder, { recursive: true, force: true })).pipe(Effect.orDie)),
  );
  return {
    path,
    environment: { [variable]: key },
    secrets: [key],
    close: () => providerCall(() => rm(folder, { recursive: true, force: true })),
  } satisfies PiMcpExtension;
});

const MAGPIE_VARIABLE = "OPENBOT_PI_MAGPIE";

// Magpie is a gateway on this computer. Pi has no Magpie provider, so this extension registers one
// with the gateway's address and models, which OpenBot reads before each spawn. The app key is a
// public name, not a secret. Pi runs an extension again when it switches sessions: each run reads the
// session file again, so `X-Magpie-Session` names the thread that the process runs. Magpie routes
// the requests of one session together.
const MAGPIE_SOURCE = `import { readFileSync } from "node:fs";
export default function (pi) {
  const slot = Symbol.for("openbot.pi.magpie");
  globalThis[slot] ??= process.env.${MAGPIE_VARIABLE};
  delete process.env.${MAGPIE_VARIABLE};
  let config;
  try {
    config = JSON.parse(globalThis[slot] ?? "");
  } catch {
    return;
  }
  if (!config || !Array.isArray(config.models) || config.models.length === 0) return;
  let session = "";
  try {
    session = readFileSync(config.sessionFile, "utf8").trim();
  } catch {}
  const piLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const model = (entry) => {
    const levels = Array.isArray(entry.levels) ? entry.levels : [];
    const thinkingLevelMap = Object.fromEntries(
      piLevels.map((level) => {
        if (level === "off") return [level, levels.includes("none") ? "none" : levels.includes("off") ? "off" : null];
        return [level, levels.includes(level) ? level : null];
      }),
    );
    return {
      id: entry.id,
      name: entry.id,
      reasoning: levels.length > 0,
      input: ["text"],
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(levels.length > 0 ? { thinkingLevelMap } : {}),
    };
  };
  pi.registerProvider("magpie", {
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: "${MAGPIE_API_KEY}",
    headers: session ? { "X-Magpie-Session": session } : {},
    models: config.models.map(model),
  });
}
`;

/** The `X-Magpie-Session` value of a Pi session file: stable for the thread, and no path. */
export function magpieSessionId(sessionFile: string): string {
  return `openbot-${createHash("sha256").update(sessionFile).digest("hex").slice(0, 32)}`;
}

export interface PiMagpieExtension extends PiMcpExtension {
  /** Names the thread for the next run of the extension: at the start or at a session switch. */
  setSession(sessionFile: string): Effect.Effect<void, ProviderClientOperationError>;
}

/** Owns one temporary extension that registers the `magpie` provider in Pi for one process. */
export const createPiMagpieExtension = Effect.fn("PiKeyProviders.createMagpieExtension")(function* (
  gateway: MagpieGatewayInfo,
  directory?: string,
) {
  const root = directory ?? tmpdir();
  yield* providerCall(() => mkdir(root, { recursive: true, mode: 0o700 }));
  const folder = yield* providerCall(() => mkdtemp(join(root, "openbot-pi-")));
  const path = join(folder, "magpie.mjs");
  const sessionFile = join(folder, "session");
  yield* providerCall(async () => {
    await writeFile(path, MAGPIE_SOURCE, { mode: 0o600 });
    await writeFile(sessionFile, "", { mode: 0o600 });
  }).pipe(Effect.onError(() => providerCall(() => rm(folder, { recursive: true, force: true })).pipe(Effect.orDie)));
  const config = {
    baseUrl: gateway.baseUrl,
    sessionFile,
    models: gateway.models.map((model) => ({ id: model.id, levels: model.reasoningLevels })),
  };
  return {
    path,
    environment: { [MAGPIE_VARIABLE]: JSON.stringify(config) },
    secrets: [],
    setSession: (session: string) =>
      providerCall(() => writeFile(sessionFile, magpieSessionId(session), { mode: 0o600 })),
    close: () => providerCall(() => rm(folder, { recursive: true, force: true })),
  } satisfies PiMagpieExtension;
});
