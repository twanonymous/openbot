import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isHostOnlyProvider, isKeyOnlyProvider, isLocalOnlyProvider } from "@openbot/contracts/agent-providers";
import { MAGPIE_API_KEY } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createPiMagpieExtension, magpieSessionId } from "./pi-key-providers";

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  delete process.env.OPENBOT_PI_MAGPIE;
  Reflect.deleteProperty(globalThis, Symbol.for("openbot.pi.magpie"));
});

interface Registration {
  name: string;
  config: {
    baseUrl: string;
    apiKey: string;
    headers: Record<string, string>;
    models: { id: string; reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }[];
  };
}

async function runExtension(path: string, environment: Record<string, string>): Promise<Registration[]> {
  Object.assign(process.env, environment);
  const registrations: Registration[] = [];
  const module: { default: (pi: unknown) => void } = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const pi = {
    registerProvider: (name: string, config: Registration["config"]) => registrations.push({ name, config }),
  };
  module.default(pi);
  // Pi runs an extension again when it switches sessions.
  module.default(pi);
  return registrations;
}

describe("Magpie Pi extension", () => {
  it("registers the gateway's models with the app key, and names the thread after setSession", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-magpie-test-"));
    folders.push(directory);
    const extension = await Effect.runPromise(
      createPiMagpieExtension(
        {
          baseUrl: "http://127.0.0.1:4100/v1",
          models: [
            { id: "claude-sonnet", group: false, reasoningLevels: ["none", "low", "high"] },
            { id: "fast", group: true, reasoningLevels: [] },
          ],
        },
        directory,
      ),
    );
    expect(extension.secrets).toEqual([]);
    expect(await readFile(extension.path, "utf8")).not.toContain("127.0.0.1:4100");

    const before = await runExtension(extension.path, extension.environment);
    expect(before[0]?.name).toBe("magpie");
    expect(before[0]?.config.baseUrl).toBe("http://127.0.0.1:4100/v1");
    expect(before[0]?.config.apiKey).toBe(MAGPIE_API_KEY);
    expect(before[0]?.config.headers).toEqual({});
    expect(before[1]?.config.models.map((model) => model.id)).toEqual(["claude-sonnet", "fast"]);
    // The environment value is read once, then removed before any tool runs.
    expect(process.env.OPENBOT_PI_MAGPIE).toBeUndefined();

    const sonnet = before[0]?.config.models[0];
    expect(sonnet?.reasoning).toBe(true);
    expect(sonnet?.thinkingLevelMap).toMatchObject({ off: "none", low: "low", medium: null, high: "high" });
    expect(before[0]?.config.models[1]?.reasoning).toBe(false);

    await Effect.runPromise(extension.setSession("/home/u/.pi/sessions/one.jsonl"));
    const after = await runExtension(extension.path, {});
    expect(after[0]?.config.headers).toEqual({
      "X-Magpie-Session": magpieSessionId("/home/u/.pi/sessions/one.jsonl"),
    });
    await Effect.runPromise(extension.close());
  });

  it("names a session without its path, the same way each time", () => {
    const id = magpieSessionId("/home/u/.pi/sessions/one.jsonl");
    expect(id).toMatch(/^openbot-[0-9a-f]{32}$/);
    expect(id).toBe(magpieSessionId("/home/u/.pi/sessions/one.jsonl"));
    expect(id).not.toBe(magpieSessionId("/home/u/.pi/sessions/two.jsonl"));
  });
});

describe("Magpie provider", () => {
  it("is local-only and host-only, but has no key", () => {
    expect(isLocalOnlyProvider("magpie")).toBe(true);
    expect(isHostOnlyProvider("magpie")).toBe(true);
    expect(isKeyOnlyProvider("magpie")).toBe(false);
  });
});
