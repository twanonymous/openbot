import { isHostOnlyProvider, isKeyOnlyProvider, isLocalOnlyProvider } from "@openbot/contracts/agent-providers";
import { MAGPIE_API_KEY } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeAgentClient } from "./claude-client";
import { type FetchLike, magpieSessionId, parseMagpieModels } from "./magpie";
import { magpieFailureText, magpieModelOptions, magpieQueryEnvironment } from "./magpie-claude";

// The shape of a real Magpie 0.1.1551 `/v1/models` answer, cut to four entries.
const MODELS_FIXTURE = {
  object: "list",
  data: [
    {
      id: "codex/gpt-6-sol",
      object: "model",
      display_name: "GPT-6 Sol",
      magpie_label: "Codex · GPT-6 Sol",
      context_window: 400_000,
      max_output_tokens: 128_000,
      reasoning_levels: ["low", "high", "max"],
      supported_reasoning_levels: ["low", "high", "max"],
    },
    {
      id: "auto/deepseek-v4.1-flash",
      object: "model",
      display_name: "DeepSeek V4.1 Flash",
      magpie_label: "Auto · DeepSeek V4.1 Flash",
      context_window: 128_000,
      max_output_tokens: 32_000,
      reasoning_levels: ["low", "high", "max"],
      supported_reasoning_levels: ["low", "high", "max"],
    },
    {
      id: "claude/claude-opus-5-5",
      object: "model",
      magpie_label: "Claude · Opus 5.5",
      context_window: 200_000,
      max_output_tokens: 64_000,
      reasoning_levels: ["low", "high", "max"],
    },
    { id: "local/plain", object: "model", context_window: 32_000, max_output_tokens: 4_096 },
  ],
};

const ACCOUNT_VARIABLES = {
  ANTHROPIC_API_KEY: "sk-ant-user-secret",
  ANTHROPIC_AUTH_TOKEN: "user-token",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-user-secret",
  CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
  ENABLE_PROMPT_CACHING_1H: "1",
};

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

function setEnvironment(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    process.env[name] = value;
  }
}

describe("Magpie query environment", () => {
  const input = {
    origin: "http://127.0.0.1:3425",
    threadId: "4f1c7b9e-2a33-4d0e-9b1a-6c2d8e0f1a2b",
    model: "auto/deepseek-v4.1-flash",
    configDirectory: "/data/provider-state/magpie-claude",
  };

  it("points Claude Code at the gateway with the app key and the thread's hashed session", () => {
    const environment = magpieQueryEnvironment({ PATH: "/usr/bin", HOME: "/home/u" }, input);
    expect(environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3425");
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(MAGPIE_API_KEY);
    expect(environment.ANTHROPIC_CUSTOM_HEADERS).toBe(`X-Magpie-Session: ${magpieSessionId(input.threadId)}`);
    expect(environment.ANTHROPIC_CUSTOM_HEADERS).not.toContain(input.threadId);
    expect(environment.CLAUDE_CONFIG_DIR).toBe(input.configDirectory);
    expect(environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(environment.PATH).toBe("/usr/bin");
    for (const name of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ])
      expect(environment[name]).toBe("auto/deepseek-v4.1-flash");
  });

  it("drops every Anthropic credential, endpoint and cache choice it inherits", () => {
    const environment = magpieQueryEnvironment(
      // Windows names variables in any case.
      { PATH: "/usr/bin", ...ACCOUNT_VARIABLES, anthropic_api_key: "lower-case-secret" },
      { ...input, model: null },
    );
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.anthropic_api_key).toBeUndefined();
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environment.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(environment.ENABLE_PROMPT_CACHING_1H).toBeUndefined();
    expect(environment.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe(MAGPIE_API_KEY);
    expect(environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:3425");
    expect(environment.CLAUDE_CONFIG_DIR).toBe(input.configDirectory);
    expect(JSON.stringify(environment)).not.toMatch(/secret|user-token|claude-work/);
  });

  it("names a session by a stable hash of the thread", () => {
    const id = magpieSessionId(input.threadId);
    expect(id).toMatch(/^openbot-[0-9a-f]{32}$/);
    expect(id).toBe(magpieSessionId(input.threadId));
    expect(id).not.toBe(magpieSessionId("another-thread"));
  });

  it("gives the query that a Magpie client starts no credential from the shell", async () => {
    setEnvironment(ACCOUNT_VARIABLES);
    const environments: Record<string, string | undefined>[] = [];
    const client = new ClaudeAgentClient(
      { executable: "claude", version: "2.1.310", source: "system" },
      (params) => {
        environments.push({ ...params.options?.env });
        return idleQuery();
      },
      undefined,
      5_000,
      () => [],
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ CLAUDE_CONFIG_DIR: input.configDirectory }),
      undefined,
      () => "sk-ant-saved-key",
      { origin: () => Effect.succeed(input.origin), configDirectory: input.configDirectory },
    );
    expect(client.provider).toBe("magpie");
    client.start();
    try {
      await Effect.runPromise(
        client.request(
          "thread/start",
          { cwd: process.cwd(), model: "auto/deepseek-v4.1-flash", profileGeneration: true },
          (value) => value,
        ),
      );
    } finally {
      await Effect.runPromise(client.stop());
    }
    const environment = environments[0];
    expect(environment?.ANTHROPIC_BASE_URL).toBe(input.origin);
    expect(environment?.ANTHROPIC_AUTH_TOKEN).toBe(MAGPIE_API_KEY);
    expect(environment?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(environment?.CLAUDE_CONFIG_DIR).toBe(input.configDirectory);
    expect(environment?.ANTHROPIC_SMALL_FAST_MODEL).toBe("auto/deepseek-v4.1-flash");
    expect(environment?.ANTHROPIC_CUSTOM_HEADERS).toMatch(/^X-Magpie-Session: openbot-[0-9a-f]{32}$/);
    expect(JSON.stringify(environment)).not.toMatch(/secret|sk-ant|user-token|claude-work/);
  });
});

describe("Magpie models", () => {
  it("lists the gateway's models with their names, the auto group first", () => {
    const options = magpieModelOptions(parseMagpieModels(MODELS_FIXTURE));
    expect(options.map((option) => option.model)).toEqual([
      "auto/deepseek-v4.1-flash",
      "codex/gpt-6-sol",
      "claude/claude-opus-5-5",
      "local/plain",
    ]);
    expect(options.map((option) => option.displayName)).toEqual([
      "DeepSeek V4.1 Flash",
      "GPT-6 Sol",
      "Claude · Opus 5.5",
      "local/plain",
    ]);
  });

  it("maps reasoning levels onto Claude Code efforts, and none to a fixed effort", () => {
    const [auto, , , plain] = magpieModelOptions(parseMagpieModels(MODELS_FIXTURE));
    expect(auto?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low" },
      { reasoningEffort: "high" },
      { reasoningEffort: "max" },
    ]);
    expect(auto?.defaultReasoningEffort).toBe("high");
    expect(auto?.reasoningEffortConfigurable).toBe(true);
    expect(plain?.supportedReasoningEfforts).toEqual([]);
    expect(plain?.reasoningEffortConfigurable).toBe(false);
  });

  it("keeps the gateway's first model first when no auto group is listed", () => {
    const options = magpieModelOptions(
      parseMagpieModels({ data: [{ id: "codex/gpt-6-sol" }, { id: "claude/claude-opus-5-5" }] }),
    );
    expect(options[0]?.model).toBe("codex/gpt-6-sol");
  });

  it("reads the model list from the gateway, not from Claude Code", async () => {
    const requests: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      requests.push(url);
      return new Response(JSON.stringify(MODELS_FIXTURE), { status: 200 });
    };
    const client = magpieClient(fetchFn, () => {
      throw new Error("Claude Code must not start for a Magpie model list.");
    });
    client.start();
    const list = await Effect.runPromise(client.request("model/list", {}, (value) => value));
    expect(requests).toEqual(["http://127.0.0.1:3425/v1/models"]);
    expect(JSON.stringify(list)).toContain('"model":"auto/deepseek-v4.1-flash"');
    await Effect.runPromise(client.stop());
  });
});

describe("Magpie availability", () => {
  it("is ready while /api/hello answers, and signed out when it does not", async () => {
    let up = true;
    const fetchFn: FetchLike = async (url) => {
      if (!up) throw new Error("connect ECONNREFUSED 127.0.0.1:3425");
      expect(url).toBe("http://127.0.0.1:3425/api/hello");
      return new Response('{"name":"magpie","version":"0.1.1551"}', { status: 200 });
    };
    const client = magpieClient(fetchFn, () => {
      throw new Error("Claude Code must not start for a Magpie account check.");
    });
    client.start();
    expect(await Effect.runPromise(client.request("account/read", {}, (value) => value))).toEqual({
      account: { type: "magpie", email: null, planType: null },
      requiresOpenaiAuth: false,
    });
    up = false;
    expect(await Effect.runPromise(client.request("account/read", {}, (value) => value))).toEqual({
      account: null,
      requiresOpenaiAuth: false,
    });
    expect(await Effect.runPromise(client.request("account/rateLimits/read", {}, (value) => value))).toEqual({
      rateLimits: null,
      rateLimitsByLimitId: null,
    });
    await Effect.runPromise(client.stop());
  });

  it("says how to start or allow the gateway when a turn fails on it", () => {
    expect(magpieFailureText("API Error: Connection error. (ECONNREFUSED)")).toBe(
      sourceText("error.provider.magpieNotRunning"),
    );
    expect(magpieFailureText("Invalid API key · Please run /login")).toBe(sourceText("error.provider.magpieRefused"));
    expect(magpieFailureText("Model overloaded")).toBe("Model overloaded");
  });

  it("is local-only and host-only, but has no key", () => {
    expect(isLocalOnlyProvider("magpie")).toBe(true);
    expect(isHostOnlyProvider("magpie")).toBe(true);
    expect(isKeyOnlyProvider("magpie")).toBe(false);
  });
});

function magpieClient(fetchFn: FetchLike, createQuery: () => never): ClaudeAgentClient {
  return new ClaudeAgentClient(
    { executable: "claude", version: "2.1.310", source: "system" },
    createQuery,
    undefined,
    5_000,
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { origin: () => Effect.succeed("http://127.0.0.1:3425"), configDirectory: "/data/magpie-claude", fetch: fetchFn },
  );
}

/** A query that sends nothing until it is closed. */
function idleQuery() {
  let close = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = () => {
      resolve();
      return undefined;
    };
  });
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<never>> => {
        await closed;
        return { done: true, value: undefined };
      },
    }),
    interrupt: async () => undefined,
    supportedModels: async () => [],
    setModel: async () => undefined,
    applyFlagSettings: async () => undefined,
    close: () => close(),
  };
}
