import { describe, expect, it } from "@effect/vitest";

import {
  checkFeatureMap,
  type Feature,
  type FeatureMap,
  type Inventory,
  loadFeatureMap,
  phoneProofGap,
  readInventory,
} from "./featureMap.ts";

const PHONE_PROOF_GAP = 105;

describe("Kin feature map", () => {
  it("lists every route, pane, phone screen and agent tool, and every proof exists", () => {
    expect(checkFeatureMap(loadFeatureMap(), readInventory())).toEqual([]);
  });

  it("counts the features reached on the phone with no proof under apps/mobile", () => {
    // Lower this as phone proofs land; a new phone feature without one raises it.
    expect(phoneProofGap(loadFeatureMap()).length).toBe(PHONE_PROOF_GAP);
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
    rpcs: new Set(["kin.work.deals", "kin.org.pause"]),
    calledRpcs: new Set(["kin.work.deals"]),
  };
  const pauseUnlisted = { "rpc:kin.org.pause": "no client offers the stop switch yet" };
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
      { features: [{ ...base, ...feature }, others], unlisted: { ...pauseUnlisted, ...unlisted } },
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
    [
      { roles: { ...base.roles, lead: "none", member: "both" } },
      "member reaches it on web, but lead",
    ],
    [
      { roles: { ...base.roles, lead: "web", member: "both" } },
      "member reaches it on phone, but lead",
    ],
  ] satisfies ReadonlyArray<[Partial<Feature>, string]>)(
    "catches a broken map: %j",
    (feature, problem) => {
      expect(check(feature).join("\n")).toContain(problem);
    },
  );

  it("asks a reason for every RPC no client calls, and drops it once one does", () => {
    const map = { features: [base, others] };
    const rpcCheck = (unlisted: Record<string, string>) =>
      checkFeatureMap({ ...map, unlisted }, inventory, (path) => path === "proof.ts");
    expect(rpcCheck({})).toEqual([
      'RPC "kin.org.pause" has no client caller; list it under unlisted with why',
    ]);
    expect(rpcCheck({ ...pauseUnlisted, "rpc:kin.work.deals": "unused" })).toEqual([
      'unlisted: a client calls "kin.work.deals" now; remove it',
    ]);
    expect(rpcCheck({ ...pauseUnlisted, "rpc:kin.gone": "removed" })).toEqual([
      'unlisted: "rpc:kin.gone" is not in the code; remove it',
    ]);
  });

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
