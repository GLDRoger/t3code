import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinAdviseEffort,
  kinAgentPageCan,
  kinAgentUsageLine,
  kinEffortOffAdvice,
  kinWithMediumEffort,
} from "./kinAgentPage.ts";

describe("kinAgentPageCan", () => {
  it.each([
    ["owner", { access: "owner" as const }, "full", true],
    ["co-owner", { access: "co_owner" as const }, "full", true],
    ["project lead", { access: "member" as const, leadsAProject: true }, "short", false],
    ["member", { access: "member" as const }, "short", false],
    ["not yet known", { access: null }, "short", false],
  ])("%s", (_who, viewer, card, edits) => {
    const can = kinAgentPageCan(viewer);
    expect(can.card).toBe(card);
    for (const what of ["edit", "model", "character", "access", "pause", "remove"] as const)
      expect(can[what]).toBe(edits);
  });
});

describe("kinAgentUsageLine", () => {
  it.each([
    [{ turns: 0, tokens: 0 }, "No replies yet this month."],
    [{ turns: 1, tokens: 900 }, "1 reply this month, about 900 tokens."],
    [{ turns: 3, tokens: 0 }, "3 replies this month."],
    [{ turns: 12, tokens: 1_240_000 }, "12 replies this month, about 1.2M tokens."],
  ])("%j", (used, line) => {
    expect(kinAgentUsageLine(used as never)).toBe(line);
  });
});

describe("Kin's effort advice", () => {
  // Any provider's reasoning control: Codex calls it reasoningEffort, Claude effort.
  const reasoning: ProviderOptionDescriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: ["low", "medium", "high", "xhigh"].map((id) => ({
      id,
      label: id,
      ...(id === "high" ? { isDefault: true } : {}),
    })),
  };
  const models = [{ slug: "invented-model", capabilities: { optionDescriptors: [reasoning] } }];
  const at = (effort?: string) => ({
    instanceId: ProviderInstanceId.make("invented"),
    model: "invented-model",
    ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
  });

  it("lists Medium and High first, marked, and keeps every other level selectable", () => {
    const advised = kinAdviseEffort(reasoning);
    expect(advised.type === "select" ? advised.options : []).toEqual([
      { id: "medium", label: "medium", description: "Recommended" },
      { id: "high", label: "high", isDefault: true, description: "Recommended" },
      { id: "low", label: "low" },
      { id: "xhigh", label: "xhigh" },
    ]);
  });

  it.each([
    ["low", true],
    ["medium", false],
    ["high", false],
    ["xhigh", true],
    [undefined, false],
  ])("flags %s: %s", (effort, off) => {
    expect(kinEffortOffAdvice(at(effort), models)).toBe(off);
  });

  it("starts a freshly picked model at Medium, and leaves a chosen effort alone", () => {
    expect(kinWithMediumEffort(at(), models)).toEqual(at("medium"));
    expect(kinWithMediumEffort(at("xhigh"), models)).toEqual(at("xhigh"));
    expect(kinWithMediumEffort(at(), [])).toEqual(at());
  });
});
