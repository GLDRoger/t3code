import { describe, expect, it } from "@effect/vitest";

import {
  checkFeatureMap,
  type Feature,
  type FeatureMap,
  type Inventory,
  loadFeatureMap,
  readInventory,
} from "./featureMap.ts";

describe("Kin feature map", () => {
  it("lists every route, pane, phone screen and agent tool, and every proof exists", () => {
    expect(checkFeatureMap(loadFeatureMap(), readInventory())).toEqual([]);
  });

  const inventory: Inventory = {
    webRoutes: new Map([
      ["tasks", "tasks.tsx"],
      ["settings", "settings.tsx"],
    ]),
    webParams: new Set(["task", "list"]),
    phoneScreens: new Map([
      ["KinWorkItem", "sheet"],
      ["KinWorkAssign", "sheet"],
      ["KinWork", "page"],
      ["SettingsKin", "page"],
    ]),
    tools: new Set(["record_assign", "record_get"]),
  };
  const base: Feature = {
    id: "tasks-assign",
    name: "Give a task to someone",
    tab: "tasks",
    web: ["tasks", "?task", "sheet:Give it to"],
    phone: ["tab:tasks", "KinWorkItem", "KinWorkAssign"],
    roles: { owner: "both", co_owner: "both", lead: "both", member: "none" },
    form: true,
    tools: ["record_assign", "record_get"],
    proof: ["proof.ts"],
  };
  const others: Feature = {
    ...base,
    id: "others",
    web: ["settings", "?list"],
    phone: ["tab:chats", "SettingsKin", "KinWork"],
    form: false,
    tools: [],
  };
  const check = (feature: Partial<Feature>, unlisted?: FeatureMap["unlisted"]) =>
    checkFeatureMap(
      { features: [{ ...base, ...feature }, others], ...(unlisted ? { unlisted } : {}) },
      inventory,
      (path) => path === "proof.ts",
    );

  it("holds for a map that follows the rules", () => {
    expect(check({})).toEqual([]);
  });

  it.each([
    [{ tools: ["record_get"] }, 'agent tool "record_assign" is in no feature'],
    [{ proof: ["gone.ts"] }, "proof file gone.ts is missing"],
    [{ phone: ["tab:tasks", "KinWorkItem"] }, 'phone screen "KinWorkAssign" is in no feature'],
    [
      { phone: ["tab:tasks", "KinWorkItem", "KinWorkAssign", "KinNope"] },
      'no phone screen "KinNope"',
    ],
    [{ web: ["tasks", "?list"] }, "a form that is not a sheet"],
    [
      { phone: ["tab:tasks", "KinWorkItem", "KinWorkAssign", "KinWork"] },
      "opens a page from a sheet",
    ],
    [{ web: ["tasks", "?task", "sheet:A", "sheet:B", "sheet:C"] }, "4 levels deep (at most 3)"],
    [{ depth_reason: "deep on purpose" }, "depth_reason given, but its paths keep the rule"],
    [{ roles: { ...base.roles, member: "web" }, web: undefined }, "member reaches it on web"],
  ] satisfies ReadonlyArray<[Partial<Feature>, string]>)(
    "catches a broken map: %j",
    (feature, problem) => {
      expect(check(feature).join("\n")).toContain(problem);
    },
  );

  it("accepts a stated reason for depth and an explained unlisted entry", () => {
    expect(
      check({
        web: ["tasks", "?task", "sheet:A", "sheet:B", "sheet:C"],
        depth_reason: "the calendar sits inside the due menu",
      }),
    ).toEqual([]);
    expect(
      check({ tools: ["record_get"] }, { "tool:record_assign": "reached only by agents" }),
    ).toEqual([]);
  });
});
