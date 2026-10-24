import { describe, expect, it } from "@effect/vitest";

import { DEFAULT_KIN_PROFILES } from "./defaults.ts";
import {
  parseProfileDocument,
  profileFromInline,
  serializeProfileDocument,
} from "./profileDocument.ts";

describe("profile documents", () => {
  it("ships the five roles and keeps reviewers blind", () => {
    expect(DEFAULT_KIN_PROFILES.map((profile) => profile.name)).toEqual([
      "main",
      "implementer",
      "reviewer",
      "researcher",
      "archivist",
    ]);
    const reviewer = DEFAULT_KIN_PROFILES.find((profile) => profile.name === "reviewer");
    expect(reviewer?.crownable).toBe(false);
    expect(reviewer?.seesWills).toBe(false);
    expect(reviewer?.tools.lineage).not.toContain("will");
    expect(reviewer?.tools.lineage).not.toContain("crown");
  });

  it("round-trips frontmatter and treats an omitted reviewer as blind", () => {
    const parsed = parseProfileDocument(
      `---
name: reviewer
role: reviewer
---
Judge the diff.
`,
      "project",
      "/repo/.kin/agents/reviewer.md",
    );
    expect(parsed.profile.crownable).toBe(false);
    expect(parsed.profile.seesWills).toBe(false);
    expect(parsed.profile.provider).toBe("inherit");
    expect(
      parseProfileDocument(serializeProfileDocument(parsed.profile), "project").profile.body,
    ).toBe("Judge the diff.");
  });

  it("saves an inline profile under a stable ad-hoc name", () => {
    const first = profileFromInline({ prompt: "Look at the failing test only." });
    const second = profileFromInline({ prompt: "Look at the failing test only." });
    expect(first.fileName).toBe(second.fileName);
    expect(first.profile.name).toBe(first.fileName);
    expect(first.fileName.startsWith("adhoc-")).toBe(true);
    const again = parseProfileDocument(serializeProfileDocument(first.profile), "adhoc");
    expect(again.profile.name).toBe(first.fileName);
  });
});
