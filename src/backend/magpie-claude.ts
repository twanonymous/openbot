// The `magpie` provider runs in Claude Code, pointed at the Magpie gateway on this computer. Magpie
// serves an Anthropic-compatible `/v1/messages` for every model it routes, Claude or not, so the
// Claude client runs it with a few changes, which this file holds: the environment of each query, and
// the model list from the gateway.
//
// The process must never use the user's Claude account. It gets a Claude Code folder of its own, and
// no Anthropic key, OAuth token or cloud-provider switch from the shell or from the Claude provider.

import { MAGPIE_API_KEY } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { type MagpieModel, magpieSessionId } from "./magpie";

/**
 * Variables that would give the process a credential, an endpoint or a model other than Magpie's.
 * They are removed from the inherited environment before the Magpie values are set.
 */
const ANTHROPIC_ACCOUNT_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_UNIX_SOCKET",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CONFIG_DIR",
  // The 1 hour cache is an Anthropic price choice of the Claude provider. Magpie decides for itself.
  "ENABLE_PROMPT_CACHING_1H",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
] as const;

export interface MagpieQueryEnvironmentInput {
  /** The gateway root, such as `http://127.0.0.1:3425`. */
  origin: string;
  /** OpenBot's thread id. Only its hash leaves the computer. */
  threadId: string;
  /** The model of the thread. Background requests of the CLI use it too. Null: the CLI's own choice. */
  model: string | null;
  /** The Claude Code folder of the provider, apart from the user's own. */
  configDirectory: string;
}

/**
 * The environment of one Claude Code process for Magpie: the inherited one without any Anthropic
 * credential, plus the gateway, the app key and the thread's session header.
 */
export function magpieQueryEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  input: MagpieQueryEnvironmentInput,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !isAnthropicAccountVariable(name)) environment[name] = value;
  }
  // Claude Code names its small model "haiku" and its subagent models "sonnet" and "opus". The
  // gateway can refuse a Claude id, so each of these is the thread's model.
  const model = input.model?.trim();
  const models: Record<string, string> = model
    ? {
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_SMALL_FAST_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
      }
    : {};
  return {
    ...environment,
    ...models,
    CLAUDE_CONFIG_DIR: input.configDirectory,
    ANTHROPIC_BASE_URL: input.origin,
    // Sent as `Authorization: Bearer`. The app key is a public name, not a secret.
    ANTHROPIC_AUTH_TOKEN: MAGPIE_API_KEY,
    ANTHROPIC_CUSTOM_HEADERS: `X-Magpie-Session: ${magpieSessionId(input.threadId)}`,
    // No telemetry, error reports or update checks to Anthropic: the provider is the gateway.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function isAnthropicAccountVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return ANTHROPIC_ACCOUNT_VARIABLES.some((variable) => variable === upper);
}

/** The efforts that Claude Code takes, in its own order. */
const CLAUDE_CODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

export interface MagpieModelOption {
  model: string;
  displayName: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  reasoningEffortConfigurable: boolean;
}

/** The efforts of a model that Claude Code can send, or null when the effort is not configurable. */
export function magpieModelEfforts(
  model: MagpieModel,
): { supported: ClaudeCodeEffort[]; defaultEffort: ClaudeCodeEffort } | null {
  const supported = CLAUDE_CODE_EFFORTS.filter((effort) =>
    model.reasoningLevels.some((level) => level.toLowerCase() === effort),
  );
  const first = supported[0];
  if (first === undefined) return null;
  return { supported, defaultEffort: supported.includes("high") ? "high" : first };
}

/**
 * The gateway's models as OpenBot lists them. The first `auto/` routing group comes first, else the
 * gateway's first model, because a provider with no fixed default model starts on its first one.
 */
export function magpieModelOptions(models: readonly MagpieModel[]): MagpieModelOption[] {
  const preferred = models.findIndex((model) => model.id.startsWith("auto/"));
  const ordered = preferred > 0 ? [models[preferred], ...models.filter((_, index) => index !== preferred)] : models;
  return ordered.flatMap((model) => {
    if (!model) return [];
    const efforts = magpieModelEfforts(model);
    return [
      {
        model: model.id,
        displayName: model.name ?? model.id,
        defaultReasoningEffort: efforts?.defaultEffort ?? "none",
        supportedReasoningEfforts: (efforts?.supported ?? []).map((reasoningEffort) => ({ reasoningEffort })),
        reasoningEffortConfigurable: efforts !== null,
      },
    ];
  });
}

/**
 * The text of a failed Magpie turn. Claude Code says "Invalid API key · Please run /login" or names
 * a refused connection, which point at an Anthropic account the provider does not have, so those
 * say how to start or allow the gateway instead. Other texts come from the gateway and stay.
 */
export function magpieFailureText(text: string): string {
  if (/\b40[13]\b|invalid api key|please run \/login|authentication_error|permission_error/iu.test(text))
    return sourceText("error.provider.magpieRefused");
  if (/ECONNREFUSED|ECONNRESET|connection (error|refused)|unable to connect|fetch failed|socket hang up/iu.test(text))
    return sourceText("error.provider.magpieNotRunning");
  return text;
}
