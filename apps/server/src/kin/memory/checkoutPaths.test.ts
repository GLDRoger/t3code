import { expect, it } from "@effect/vitest";

import { isCheckoutPath } from "./checkoutPaths.ts";

it.each([
  ["rules.md", true],
  ["INDEX.md", true],
  ["deferrals/def-001.md", true],
  ["people/demo_owner.md", true],
  ["journal/2026/11-01.md", true],
  ["README.md", false],
  ["deferrals/notes.txt", false],
  ["scratch/a.md", false],
  ["journal/x\\..\\..\\..\\.claude\\CLAUDE.md", false],
  ["journal/x\\..\\..\\CLAUDE.md", false],
  ["deferrals/c:stream.md", false],
  ["deferrals/a\tb.md", false],
  ["deferrals//a.md", false],
  ["deferrals/.hidden.md", false],
  ["journal/../rules.md", false],
  ["journal/.claude/commands/x.md", false],
  ["deferrals/AGENTſ.md", false],
  ["deferrals/CLAUDE.md", false],
  ["deferrals/claude.local.md", false],
  ["journal/2026/AGENTS.md", false],
  ["journal/agents.override.md", false],
  ["claims/Agent.md", false],
  ["decisions/GEMINI.md", false],
  ["journal/skills/x/SKILL.md", false],
])("isCheckoutPath(%j) is %s", (path, kept) => {
  expect(isCheckoutPath(path)).toBe(kept);
});
