import { describe, expect, it } from "@effect/vitest";

import { isCliLoadedMarkdown } from "./nativeMd.ts";

describe("isCliLoadedMarkdown", () => {
  it("skips the files Claude Code and Codex already load", () => {
    expect(
      isCliLoadedMarkdown({
        provider: "claudeAgent",
        filePath: "/repo/CLAUDE.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(true);
    expect(
      isCliLoadedMarkdown({
        provider: "claudeAgent",
        filePath: "/home/kin/.claude/CLAUDE.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(true);
    expect(
      isCliLoadedMarkdown({
        provider: "claudeAgent",
        filePath: "/repo/.kin/md/notes.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(false);
    expect(
      isCliLoadedMarkdown({
        provider: "codex",
        filePath: "/repo/AGENTS.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(true);
    expect(
      isCliLoadedMarkdown({
        provider: "codex",
        filePath: "/home/kin/.codex/AGENTS.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(true);
    expect(
      isCliLoadedMarkdown({
        provider: "grok",
        filePath: "/repo/AGENTS.md",
        homeDirectory: "/home/kin",
      }),
    ).toBe(false);
  });
});
