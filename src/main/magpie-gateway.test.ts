import { EventEmitter } from "node:events";
import { join } from "node:path";
import { MAGPIE_API_KEY, MAGPIE_DEFAULT_PORT } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  checkMagpieHealth,
  type FetchLike,
  listMagpieModels,
  magpieSettingsPaths,
  parseMagpieModels,
  parseMagpiePort,
  resolveMagpiePort,
} from "../backend/magpie";
import { MagpieGateway, type MagpieProcess, shouldStartMagpie } from "./magpie-gateway";
import { scanTargets } from "./provider-detection";
import { isPeerHiddenProvider } from "./team-api/provider-visibility";

const posix = { platform: "linux" as const, home: "/home/u", env: {} };
const windows = {
  platform: "win32" as const,
  home: "C:\\Users\\u",
  env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", USERPROFILE: "C:\\Users\\u" },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Magpie port", () => {
  it("reads a top-level port, a nested port, and refuses invalid values", () => {
    expect(parseMagpiePort('{"port": 4000}')).toBe(4000);
    expect(parseMagpiePort('{"server": {"port": 4001}}')).toBe(4001);
    expect(parseMagpiePort('{"gateway": {"port": "4002"}}')).toBe(4002);
    expect(parseMagpiePort('{"port": 70000}')).toBeNull();
    expect(parseMagpiePort('{"port": 3.5}')).toBeNull();
    expect(parseMagpiePort("not json")).toBeNull();
    expect(parseMagpiePort("[]")).toBeNull();
  });

  it("looks in the APPDATA folder on Windows as well", () => {
    expect(magpieSettingsPaths(posix)).toEqual([join("/home/u", ".config", "magpie", "settings.json")]);
    expect(magpieSettingsPaths(windows)).toEqual([
      join("C:\\Users\\u", ".config", "magpie", "settings.json"),
      join("C:\\Users\\u\\AppData\\Roaming", "magpie", "settings.json"),
    ]);
  });

  it("uses the first file that names a port, and the default port without one", async () => {
    const files: Record<string, string> = {
      [join("C:\\Users\\u\\AppData\\Roaming", "magpie", "settings.json")]: '{"port": 5000}',
    };
    const read = async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    };
    expect(await Effect.runPromise(resolveMagpiePort(windows, read))).toBe(5000);
    expect(await Effect.runPromise(resolveMagpiePort(posix, read))).toBe(MAGPIE_DEFAULT_PORT);
  });
});

describe("Magpie health and models", () => {
  it("is healthy only when /api/hello answers OK", async () => {
    const ok: FetchLike = async (url) => {
      expect(url).toBe("http://127.0.0.1:3425/api/hello");
      return new Response("hi");
    };
    expect(await Effect.runPromise(checkMagpieHealth(ok, "http://127.0.0.1:3425"))).toBe(true);
    const refused: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await Effect.runPromise(checkMagpieHealth(refused, "http://127.0.0.1:3425"))).toBe(false);
    const error: FetchLike = async () => new Response("", { status: 500 });
    expect(await Effect.runPromise(checkMagpieHealth(error, "http://127.0.0.1:3425"))).toBe(false);
  });

  it("sends the app key and parses models, groups and reasoning levels", async () => {
    const fetchFn = vi.fn<FetchLike>(async () =>
      jsonResponse({
        object: "list",
        data: [
          { id: "claude-sonnet", object: "model", reasoning_levels: ["low", "high"] },
          { id: "fast", object: "group", models: ["a", "b"] },
          { id: "claude-sonnet" },
          { id: "" },
          { name: "no id" },
          "junk",
        ],
      }),
    );
    const models = await Effect.runPromise(listMagpieModels(fetchFn, "http://127.0.0.1:3425"));
    expect(models).toEqual([
      { id: "claude-sonnet", group: false, reasoningLevels: ["low", "high"] },
      { id: "fast", group: true, reasoningLevels: [] },
    ]);
    const init = fetchFn.mock.calls[0]?.[1];
    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3425/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${MAGPIE_API_KEY}`);
  });

  it("fails on a refused list", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ error: "no" }, 401);
    const exit = await Effect.runPromiseExit(listMagpieModels(fetchFn, "http://127.0.0.1:3425"));
    expect(exit._tag).toBe("Failure");
  });

  it("accepts a bare array and nested reasoning levels", () => {
    expect(parseMagpieModels([{ id: "m", reasoning: { levels: ["medium"] } }])).toEqual([
      { id: "m", group: false, reasoningLevels: ["medium"] },
    ]);
    expect(parseMagpieModels(null)).toEqual([]);
  });
});

describe("Magpie start", () => {
  it("starts only when asked, not running, found on PATH and not started already", () => {
    const base = { autoStart: true, healthy: false, executable: "/usr/bin/magpie", alreadyStarted: false };
    expect(shouldStartMagpie(base)).toBe(true);
    expect(shouldStartMagpie({ ...base, autoStart: false })).toBe(false);
    expect(shouldStartMagpie({ ...base, healthy: true })).toBe(false);
    expect(shouldStartMagpie({ ...base, executable: null })).toBe(false);
    expect(shouldStartMagpie({ ...base, alreadyStarted: true })).toBe(false);
  });

  function fakeChild(): MagpieProcess {
    const emitter = new EventEmitter();
    return {
      pid: 42,
      exitCode: null,
      once: (event, listener) => emitter.once(event, listener),
      kill: () => true,
    };
  }

  it("spawns `magpie serve` and stops only the process it started", async () => {
    let up = false;
    const child = fakeChild();
    const spawnServe = vi.fn(() => {
      up = true;
      return child;
    });
    const killProcess = vi.fn();
    const gateway = new MagpieGateway({
      preference: { get: () => ({ autoStart: true }) },
      location: posix,
      readSettings: async () => {
        throw new Error("ENOENT");
      },
      fetch: async () => new Response("", { status: up ? 200 : 503 }),
      findExecutable: () => Effect.succeed("/usr/bin/magpie"),
      spawnServe,
      killProcess,
    });
    const status = await Effect.runPromise(gateway.ensureStarted());
    expect(spawnServe).toHaveBeenCalledWith("/usr/bin/magpie");
    expect(status).toEqual({ origin: "http://127.0.0.1:3425", running: true, startedByOpenBot: true });
    await Effect.runPromise(gateway.ensureStarted());
    expect(spawnServe).toHaveBeenCalledTimes(1);
    await Effect.runPromise(gateway.stop());
    expect(killProcess).toHaveBeenCalledWith(child);
  });

  it("does not spawn or stop a gateway the user started", async () => {
    const spawnServe = vi.fn(fakeChild);
    const killProcess = vi.fn();
    const gateway = new MagpieGateway({
      preference: { get: () => ({ autoStart: true }) },
      location: posix,
      readSettings: async () => '{"port": 4100}',
      fetch: async () => new Response("hi"),
      findExecutable: () => Effect.succeed("/usr/bin/magpie"),
      spawnServe,
      killProcess,
    });
    const status = await Effect.runPromise(gateway.ensureStarted());
    expect(status.origin).toBe("http://127.0.0.1:4100");
    expect(spawnServe).not.toHaveBeenCalled();
    await Effect.runPromise(gateway.stop());
    expect(killProcess).not.toHaveBeenCalled();
  });
});

describe("Magpie in the local server scan", () => {
  it("probes the Magpie address from its settings file with the app key", () => {
    const targets = scanTargets([], "http://127.0.0.1:4100/v1");
    expect(targets.find((target) => target.id === "magpie")).toEqual({
      id: "magpie",
      name: "Magpie",
      baseUrl: "http://127.0.0.1:4100/v1",
      apiKey: MAGPIE_API_KEY,
    });
    expect(targets.find((target) => target.id === "ollama")?.apiKey).toBeUndefined();
  });
});

describe("Magpie and Team API peers", () => {
  it("hides the magpie provider from peers on every protocol", () => {
    for (const protocol of [1, 7, 8, 9]) expect(isPeerHiddenProvider("magpie", protocol)).toBe(true);
  });
});
