import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { matchModel } from "./agentUpdate.ts";
import {
  chooseLeadModel,
  helperModelRefusal,
  kinHelperProviders,
  leadModelProblem,
  leadProviderProblem,
} from "./leadModels.ts";

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

describe("leadProviderProblem", () => {
  it.each([
    ["Claude, anywhere", "claudeAgent", false, false, false],
    ["the scripted agent, off a dev server", "kinVerifyScript", false, false, true],
    ["the scripted agent, on a dev server", "kinVerifyScript", true, false, false],
    ["another ACP or Codex instance, even on a dev server", "codex", true, false, true],
    ["Codex, with the host's switch on", "codex", false, true, false],
    ["another ACP instance, even with the switch on", "kinVerifyScript", false, true, true],
  ] as const)("%s", (_name, instanceId, devServer, codex, refused) => {
    expect(
      leadProviderProblem({ ...settings, kinNonClaudeAgents: codex }, on(instanceId), devServer) !==
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

const host = Schema.decodeSync(ServerSettings)({
  providerModelPreferences: {
    claudeAgent: {
      hiddenModels: ["invented-moth", "invented-wren"],
      refusedAt: { "invented-wren": 1_795_424_400_000 },
    },
  },
});

describe("helperModelRefusal", () => {
  const model = (slug: string, name: string, extra: object = {}) => ({
    slug,
    name,
    isCustom: false,
    ...extra,
  });
  const provider = (instanceId: string, driver: string, models: ReadonlyArray<object>) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver,
      enabled: true,
      installed: true,
      models,
    }) as unknown as ServerProvider;
  const providers = [
    provider("claudeAgent", "claudeAgent", [
      model("invented-quill", "Invented Quill", { aliases: ["quill"] }),
      model("invented-ember", "Invented Ember", { isLegacy: true }),
      model("invented-moth", "Invented Moth"),
      model("invented-wren", "Invented Wren"),
    ]),
    provider("codex", "codex", [model("invented-lark", "Invented Lark")]),
  ];
  const own = ProviderInstanceId.make("claudeAgent");
  const refusal = (
    target: Parameters<typeof helperModelRefusal>[0]["target"],
    known: ReadonlyArray<ServerProvider> | null = providers,
  ) =>
    helperModelRefusal({
      settings: host,
      providers: known,
      devServer: false,
      callerInstanceId: own,
      target,
    });
  const ALLOWED = "invented-quill (Invented Quill), invented-ember (Invented Ember) on claudeAgent";

  it.each([
    ["no target", undefined],
    ["no model named", { isolation: "worktree" } as never],
    ["its own provider, no model", { providerInstanceId: own }],
    ["a listed model", { model: "invented-quill" }],
    ["a listed older model", { model: "invented-ember" }],
    ["an alias the provider lists", { model: "quill" }],
  ] as const)("starts the task on %s", (_name, target) => {
    assert.isUndefined(refusal(target));
  });

  it.each([
    [
      "an id the provider doesn't list",
      { model: "invented-sparrow" },
      "claudeAgent doesn't offer it",
    ],
    [
      "a model the owner hid",
      { model: "invented-moth" },
      "it's switched off in this server's model list",
    ],
    [
      "a model this server's provider refused",
      { model: "invented-wren" },
      "this server's provider refused it on 2026-11-23",
    ],
    [
      "a listed model on a provider agents may not use",
      { providerInstanceId: ProviderInstanceId.make("codex"), model: "invented-lark" },
      "Kin's agents don't run on codex",
    ],
    [
      "another provider with no model named",
      { providerInstanceId: ProviderInstanceId.make("codex") },
      "Kin's agents don't run on codex",
    ],
    [
      "a provider this server doesn't have",
      { providerInstanceId: ProviderInstanceId.make("claudeSpare"), model: "invented-quill" },
      "Kin's agents don't run on claudeSpare",
    ],
  ] as const)("refuses %s, naming what it may use", (_name, target, why) => {
    const text = refusal(target) ?? "";
    assert.include(text, why);
    assert.include(text, ALLOWED);
    const offered = text.split("Models you may use")[1] ?? "";
    assert.notInclude(offered, "invented-moth");
    assert.notInclude(offered, "invented-wren");
    assert.notInclude(offered, "invented-lark");
    assert.include(text, "leave target.model and target.providerInstanceId out");
  });

  it("says the exact refusal an agent reads", () => {
    assert.strictEqual(
      refusal({ model: "invented-sparrow" }),
      `Kin didn't start this task on invented-sparrow: claudeAgent doesn't offer it. Nothing started, and no one was told. Models you may use, as target.model with its target.providerInstanceId: ${ALLOWED}. Or leave target.model and target.providerInstanceId out, and it runs on your own model.`,
    );
  });

  it("refuses a named model while the providers can't be read, and runs one named none", () => {
    for (const known of [null, [provider("claudeAgent", "claudeAgent", [])]]) {
      const text = refusal({ model: "invented-quill" }, known) ?? "";
      assert.include(text, "Kin can't read claudeAgent's model list right now");
      assert.include(text, "runs on your own model");
      assert.isUndefined(refusal(undefined, known));
      assert.isUndefined(refusal({ providerInstanceId: own }, known));
    }
  });

  it("offers orchestrator_capabilities only what a helper may run on", () => {
    assert.deepStrictEqual(
      kinHelperProviders(host, providers).map((one) => [
        one.instanceId,
        one.models.map((listed) => listed.slug),
      ]),
      [["claudeAgent", ["invented-quill", "invented-ember"]]],
    );
    assert.deepStrictEqual(
      kinHelperProviders({ ...host, kinNonClaudeAgents: true }, providers).map(
        (one) => one.instanceId,
      ),
      ["claudeAgent", "codex"],
    );
  });
});
