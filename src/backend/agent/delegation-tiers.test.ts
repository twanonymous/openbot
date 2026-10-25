import {
  type AgentModelOption,
  DEFAULT_DELEGATION_TIERS,
  type DelegationTiers,
  decodeDelegationTiers,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { describe, expect, it } from "vitest";
import { delegationTiersPayload, resolveTierRequest } from "./delegation-tiers";
import { requestedToolModel } from "./model-tools";
import { createAgentToolSchema, updateAgentsToolSchema, updateProfileToolSchema } from "./profile-tools";

const tiers: DelegationTiers = {
  fast: { provider: "codex", model: "gpt-mini", reasoningEffort: "low", label: "Quick" },
  balanced: { provider: "claude", model: "sonnet", reasoningEffort: null },
  deep: { provider: null, model: null, reasoningEffort: null },
};

function model(provider: AgentModelOption["provider"], id: string): AgentModelOption {
  return {
    provider,
    id,
    name: id,
    description: "",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
  };
}

const models = [model("codex", "gpt-mini"), model("claude", "sonnet")];

describe("delegation tiers", () => {
  it("replaces a tier with its provider, model and effort", () => {
    expect(resolveTierRequest({ tier: "fast" }, tiers)).toEqual({
      provider: "codex",
      model: "gpt-mini",
      reasoningEffort: "low",
    });
    expect(resolveTierRequest({ tier: "balanced" }, tiers)).toEqual({ provider: "claude", model: "sonnet" });
  });

  it("lets the request's effort win over the tier's", () => {
    expect(resolveTierRequest({ tier: "fast", reasoningEffort: "high" }, tiers).reasoningEffort).toBe("high");
  });

  it("passes a request with no tier through", () => {
    expect(resolveTierRequest({ provider: "claude", model: "sonnet" }, tiers)).toEqual({
      provider: "claude",
      model: "sonnet",
    });
  });

  it("refuses a tier with a provider or a model, and a tier that is not set", () => {
    expect(() => resolveTierRequest({ tier: "fast", model: "sonnet" }, tiers)).toThrow(
      sourceText("error.agent.tierWithModel"),
    );
    expect(() => resolveTierRequest({ tier: "fast", provider: "claude" }, tiers)).toThrow(
      sourceText("error.agent.tierWithModel"),
    );
    expect(() => resolveTierRequest({ tier: "deep" }, tiers)).toThrow(
      sourceText("error.agent.tierNotSet", { tier: "deep" }),
    );
    expect(() => resolveTierRequest({ tier: "fast" }, DEFAULT_DELEGATION_TIERS)).toThrow();
  });

  it("checks the tier's model against the listed models", () => {
    expect(requestedToolModel(resolveTierRequest({ tier: "balanced" }, tiers), models)?.id).toBe("sonnet");
    const stale: DelegationTiers = { ...tiers, balanced: { provider: "claude", model: "gone", reasoningEffort: null } };
    expect(() => requestedToolModel(resolveTierRequest({ tier: "balanced" }, stale), models)).toThrow();
  });

  it("shows only the tiers that are set in list_models", () => {
    const payload = delegationTiersPayload(tiers);
    expect(payload.map((row) => row.tier)).toEqual(["fast", "balanced"]);
    expect(payload[0]).toMatchObject({ label: "Quick", provider: "codex", model: "gpt-mini", reasoningEffort: "low" });
    expect(payload[0]?.useFor).toMatch(/lookups/);
    expect(delegationTiersPayload(DEFAULT_DELEGATION_TIERS)).toEqual([]);
  });

  it("accepts tier in the tool schemas", () => {
    expect(createAgentToolSchema.parse({ name: "A", description: "", initialMessage: "Go", tier: "deep" }).tier).toBe(
      "deep",
    );
    expect(updateProfileToolSchema.parse({ agentId: "a", tier: "fast" }).tier).toBe("fast");
    expect(updateAgentsToolSchema.parse({ agentIds: ["a"], tier: "balanced" }).tier).toBe("balanced");
    expect(() =>
      createAgentToolSchema.parse({ name: "A", description: "", initialMessage: "Go", tier: "huge" }),
    ).toThrow();
  });
});

describe("decodeDelegationTiers", () => {
  it("reads set tiers, clears half choices and drops unknown tiers", () => {
    expect(
      decodeDelegationTiers({
        version: 1,
        fast: { provider: "codex", model: "gpt-mini", reasoningEffort: "low", label: "  Quick " },
        balanced: { provider: "claude", model: null, reasoningEffort: "high" },
        huge: { provider: "codex", model: "x" },
      }),
    ).toEqual({
      fast: { provider: "codex", model: "gpt-mini", reasoningEffort: "low", label: "Quick" },
      balanced: { provider: null, model: null, reasoningEffort: null },
      deep: { provider: null, model: null, reasoningEffort: null },
    });
  });

  it("refuses values that are not valid", () => {
    expect(() => decodeDelegationTiers(null)).toThrow();
    expect(() => decodeDelegationTiers({ fast: { provider: "nope", model: "x", reasoningEffort: null } })).toThrow();
    expect(() => decodeDelegationTiers({ fast: { provider: "codex", model: "x", reasoningEffort: "huge" } })).toThrow();
    expect(() =>
      decodeDelegationTiers({ fast: { provider: "codex", model: "x", reasoningEffort: null, label: "x".repeat(41) } }),
    ).toThrow();
  });
});
