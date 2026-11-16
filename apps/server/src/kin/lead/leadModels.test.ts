import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { matchModel } from "./agentUpdate.ts";
import { chooseLeadModel, leadModelProblem, nonClaudeLeadModel } from "./leadModels.ts";

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
  instanceId: ProviderInstanceId.make(instanceId),
  model: "m",
});

describe("nonClaudeLeadModel", () => {
  it.each([
    ["Claude, anywhere", "claudeAgent", false, false, false],
    ["the scripted agent, off a dev server", "kinVerifyScript", false, false, true],
    ["the scripted agent, on a dev server", "kinVerifyScript", true, false, false],
    ["another ACP or Codex instance, even on a dev server", "codex", true, false, true],
    ["Codex, with the host's switch on", "codex", false, true, false],
    ["another ACP instance, even with the switch on", "kinVerifyScript", false, true, true],
  ] as const)("%s", (_name, instanceId, devServer, codex, refused) => {
    expect(
      nonClaudeLeadModel({ ...settings, kinNonClaudeAgents: codex }, on(instanceId), devServer) !==
        undefined,
    ).toBe(refused);
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

describe("chooseLeadModel", () => {
  const providers = [claude(["claude-sonnet-4-6", "claude-haiku-4-5"])];
  const problemOf = (model: ReturnType<typeof pick>) =>
    leadModelProblem(settings, providers, model);
  it("runs on the agent's own model when the host offers it", () => {
    const own = pick("claude-sonnet-4-6");
    assert.deepStrictEqual(chooseLeadModel({ own, companyDefault: null, problemOf }), {
      model: own,
      note: null,
    });
  });
  it("falls back to the company default and says why when its model is gone", () => {
    const chosen = chooseLeadModel({
      own: pick("claude-opus-3"),
      companyDefault: pick("claude-sonnet-4-6"),
      problemOf,
    });
    assert.strictEqual(chosen.model.model, "claude-sonnet-4-6");
    assert.match(chosen.note ?? "", /claude-opus-3 isn't offered.*company default/);
  });
  it("keeps its own when the default can't run either, so the turn is refused as before", () => {
    const chosen = chooseLeadModel({
      own: pick("claude-opus-3"),
      companyDefault: pick("claude-opus-2"),
      problemOf,
    });
    assert.strictEqual(chosen.model.model, "claude-opus-3");
  });
  it("treats a switched-off Claude as unavailable", () => {
    assert.match(
      leadModelProblem(
        settings,
        [claude(["claude-sonnet-4-6"], false)],
        pick("claude-sonnet-4-6"),
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
  it("finds a Codex model, with its reasoning effort, only with the host's switch on", () => {
    const codex = {
      ...claude(["gpt-6-astra"]),
      instanceId: ProviderInstanceId.make("codex"),
      driver: "codex",
      models: claude(["gpt-6-astra"]).models.map((model) => ({
        ...model,
        name: "GPT-6 Astra",
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      })),
    } as unknown as ServerProvider;
    assert.match(String(matchModel([...providers, codex], "astra", "high", current)), /no Claude/);
    assert.deepStrictEqual(matchModel([...providers, codex], "astra", "high", current, true), {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });
  it("says what it has when the words name nothing offered", () => {
    assert.match(
      String(matchModel(providers, "gpt", undefined, current)),
      /no Claude model called gpt/,
    );
    assert.match(String(matchModel(providers, "sonnet", "turbo", current)), /no turbo effort/);
  });
});
