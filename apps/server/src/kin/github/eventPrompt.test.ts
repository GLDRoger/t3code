import type { KinGithubTrigger } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { TRIAGE_SEAT_INSTRUCTIONS, TRIAGE_TOOLS } from "../lead/outsideTriage.ts";
import { githubTriggerText } from "./eventPrompt.ts";

const REPO = "tidewater/app";
const issue = (kind: "triage" | "triage_reply", inside: boolean): KinGithubTrigger => ({
  key: `${kind}:${REPO}#14`,
  kind,
  item: "issue",
  number: 14,
  url: `https://github.com/${REPO}/issues/14`,
  title: "Digest emails go out at 3 a.m.",
  author: inside ? "zoya-tidewater" : "stranger-one",
  association: inside ? "MEMBER" : "NONE",
  inside,
  text: "The digest arrives at 3 a.m.",
});
const toolsNamed = (text: string) => new Set(text.match(/\bkin_[a-z_]+\b/g) ?? []);

describe("a triage turn's words", () => {
  it.each([
    ["a new issue", issue("triage", true)],
    ["a reply", issue("triage_reply", true)],
  ])("inside, %s posts with kin_github_comment and ends with kin_skip", (_name, trigger) => {
    const text = githubTriggerText(REPO, trigger);
    expect(text).toContain("kin_github_comment");
    expect(text).toContain("end with kin_skip");
    expect(text).not.toContain("NO_REPLY");
    expect(text).not.toContain("delegate_task");
    expect(text).not.toContain("gh issue comment");
  });

  it.each([
    ["a new issue", issue("triage", false)],
    ["a reply", issue("triage_reply", false)],
  ])("outside, %s names only the seat's tools", (_name, trigger) => {
    const text = githubTriggerText(REPO, trigger);
    expect(toolsNamed(text)).toEqual(TRIAGE_TOOLS);
    expect(toolsNamed(TRIAGE_SEAT_INSTRUCTIONS)).toEqual(TRIAGE_TOOLS);
    expect(text).not.toContain("NO_REPLY");
    expect(text).not.toMatch(/\bgh /);
  });
});

const pull = {
  ...issue("triage", true),
  kind: "review",
  item: "pull",
  pull: {
    files: 1,
    additions: 1,
    deletions: 0,
    headRef: "fix-digest",
    baseRef: "main",
    fork: false,
    ownersOwn: false,
    diff: "+fixed",
  },
} satisfies KinGithubTrigger;

it("only suggests gh or running tests when the owner authored the wake", () => {
  const writer = githubTriggerText(REPO, pull);
  expect(writer).toContain("This turn has no shell");
  expect(writer).toContain("Its diff is below.");
  expect(writer).toContain("kin_github_review");
  expect(writer).toContain("REQUEST_CHANGES");
  expect(writer).not.toMatch(/\bgh |run the tests/);

  const owner = githubTriggerText(REPO, {
    ...pull,
    author: "rhea",
    ownerAuthored: true,
    pull: { ...pull.pull, ownersOwn: true },
  });
  expect(owner).toContain("check it out and run the tests when that is quick");
  expect(owner).toContain("gh pr review");
});

it.each([
  ["pull call", { ...pull, kind: "call" }],
  ["pull label", { ...pull, kind: "label" }],
  ["issue call", { ...issue("triage", true), kind: "call" }],
  ["issue label", { ...issue("triage", true), kind: "label" }],
  ["checks", { ...pull, kind: "checks", failing: ["lint"] }],
  ["triage", issue("triage", true)],
  ["triage reply", issue("triage_reply", true)],
] satisfies ReadonlyArray<readonly [string, KinGithubTrigger]>)(
  "%s from a writer receives no shell instructions",
  (_name, trigger) => {
    const text = githubTriggerText(REPO, trigger);
    expect(text).toContain("This turn has no shell");
    expect(text).not.toMatch(/\bgh |Read with your shell|delegate_task|run the tests/);
  },
);
