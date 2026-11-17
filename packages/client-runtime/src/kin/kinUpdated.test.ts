import { describe, expect, it } from "@effect/vitest";

import { kinUpdatedAction, type KinUpdatedAction } from "./kinUpdated.ts";

type Input = Parameters<typeof kinUpdatedAction>[0];

const page = "https://kin.example/assets/index-aaa.js";
const base: Input = {
  dev: false,
  pageBuild: page,
  serverBuild: "assets/index-bbb.js",
  busy: false,
  hidden: false,
  noticeShown: false,
  reloadedFor: null,
};

describe("an open page and the build its server serves", () => {
  it.each<[string, Partial<Input>, KinUpdatedAction]>([
    ["same build", { serverBuild: "assets/index-aaa.js" }, "none"],
    ["a server that states no build", { serverBuild: undefined }, "none"],
    ["a page that can't name its build", { pageBuild: null }, "none"],
    ["dev, even when they differ", { dev: true }, "none"],
    ["dev with a draft", { dev: true, busy: true }, "none"],
    ["newer build, idle and visible", {}, "reload"],
    ["newer build, idle and hidden", { hidden: true }, "reload"],
    ["newer build, a draft or an open form", { busy: true }, "notice"],
    ["newer build, a draft in a hidden tab", { busy: true, hidden: true }, "notice"],
    ["after the notice, still busy", { noticeShown: true, busy: true }, "notice"],
    ["after the notice, idle but on screen", { noticeShown: true }, "notice"],
    ["after the notice, idle and hidden", { noticeShown: true, hidden: true }, "reload"],
    ["already reloaded for this build", { reloadedFor: "assets/index-bbb.js" }, "notice"],
    ["reloaded for an older build", { reloadedFor: "assets/index-aaa.js" }, "reload"],
  ])("%s", (_name, change, action) => {
    expect(kinUpdatedAction({ ...base, ...change })).toBe(action);
  });
});
