import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { matchModel } from "./agentUpdate.ts";
import { chooseLeadModels, leadModelProblem, nonClaudeLeadModel } from "./leadModels.ts";

const settings = Schema.decodeSync(ServerSettings)({
  providerInstances: {
    kinVerifyScript: {
      driver: "acpRegistry",
      config: { source: "local", commandPath: "node", commandArgs: ["script-agent.ts"] },
    },
    codex: { driver: "codex" },
  },
});
const on = (instanceId: string) => ({
  strong: { instanceId: ProviderInstanceId.make(instanceId), model: "m" },
  cheap: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "m" },
});

describe("nonClaudeLeadModel", () => {
  it.each([
    ["Claude, anywhere", "claudeAgent", false, false],
    ["the scripted agent, off a dev server", "kinVerifyScript", false, true],
    ["the scripted agent, on a dev server", "kinVerifyScript", true, false],
    ["another ACP or Codex instance, even on a dev server", "codex", true, true],
  ] as const)("%s", (_name, instanceId, devServer, refused) => {
    expect(nonClaudeLeadModel(settings, on(instanceId), devServer) !== undefined).toBe(refused);
  });
});

const claude = (models: ReadonlyArray<string>, enabled = true) =>
  ({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: "claudeAgent",
    enabled,
    installed: true,
    models: models.map((slug) => ({
      slug,
      name: slug.replace("claude-", "Claude ").replace(/-/g, " "),
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "default", label: "Default", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    })),
  }) as unknown as ServerProvider;
const pick = (model: string) => ({ instanceId: ProviderInstanceId.make("claudeAgent"), model });
const both = (strong: string, cheap = "claude-haiku-4-5") => ({
  strong: pick(strong),
  cheap: pick(cheap),
});

describe("chooseLeadModels", () => {
  const providers = [claude(["claude-sonnet-4-6", "claude-haiku-4-5"])];
  const problemOf = (models: ReturnType<typeof both>) =>
    leadModelProblem(settings, providers, models);
  it("runs on the agent's own models when the host offers them", () => {
    const own = both("claude-sonnet-4-6");
    assert.deepStrictEqual(chooseLeadModels({ own, companyDefault: null, problemOf }), {
      models: own,
      note: null,
    });
  });
  it("falls back to the company default and says why when its model is gone", () => {
    const chosen = chooseLeadModels({
      own: both("claude-opus-3"),
      companyDefault: both("claude-sonnet-4-6"),
      problemOf,
    });
    assert.strictEqual(chosen.models.strong.model, "claude-sonnet-4-6");
    assert.match(chosen.note ?? "", /claude-opus-3 isn't offered.*company default/);
  });
  it("keeps its own when the default can't run either, so the turn is refused as before", () => {
    const chosen = chooseLeadModels({
      own: both("claude-opus-3"),
      companyDefault: both("claude-opus-2"),
      problemOf,
    });
    assert.strictEqual(chosen.models.strong.model, "claude-opus-3");
  });
  it("treats a switched-off Claude as unavailable", () => {
    assert.match(
      leadModelProblem(
        settings,
        [claude(["claude-sonnet-4-6"], false)],
        both("claude-sonnet-4-6"),
      ) ?? "",
      /isn't available/,
    );
  });
});

describe("matchModel", () => {
  const providers = [claude(["claude-opus-4-6", "claude-sonnet-4-6"])];
  const current = pick("claude-opus-4-6");
  it("finds a model by the owner's words, with an effort it has", () => {
    assert.deepStrictEqual(matchModel(providers, "Sonnet", undefined, current), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
    assert.deepStrictEqual(matchModel(providers, "sonnet", "High", current), {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "high" }],
    });
  });
  it("says what it has when the words name nothing offered", () => {
    assert.match(String(matchModel(providers, "gpt", undefined, current)), /no Claude model/);
    assert.match(String(matchModel(providers, "sonnet", "turbo", current)), /no turbo effort/);
  });
});
