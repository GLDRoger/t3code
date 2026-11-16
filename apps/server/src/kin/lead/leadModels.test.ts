import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { nonClaudeLeadModel } from "./leadModels.ts";

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
