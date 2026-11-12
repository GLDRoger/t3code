import { assert, describe, it } from "@effect/vitest";

import { applyOperations, outlineOf, sectionsOf } from "./docBody.ts";

const body = [
  "Before any heading.",
  "",
  "# Invented plan",
  "",
  "```md",
  "# not a heading inside a fence",
  "```",
  "",
  "## Notes",
  "",
  "First notes.",
  "",
  "## Notes",
  "",
  "Second notes, the same phrase twice: twice.",
  "",
].join("\n");

describe("doc sections", () => {
  it("reads headings outside code fences, with unique ids and `top` for the text before them", () => {
    assert.deepStrictEqual(
      outlineOf(body).map(({ id, title, level }) => [id, title, level]),
      [
        ["top", "", 0],
        ["invented-plan", "Invented plan", 1],
        ["notes", "Notes", 2],
        ["notes-2", "Notes", 2],
      ],
    );
    assert.include(sectionsOf(body)[1]!.text, "# not a heading inside a fence");
  });

  it.each([
    { find: "twice", reason: "appears 2 times" },
    { find: "thrice", reason: "not in the doc" },
  ])("refuses a phrase that does not match exactly once: $find", ({ find, reason }) => {
    const applied = applyOperations(body, "Invented plan", [
      { op: "replace_phrase", find, replace: "x" },
    ]);
    assert.strictEqual(applied._tag, "refused");
    if (applied._tag === "refused") assert.include(applied.error.message, reason);
  });

  it("removes a section given empty text and keeps a heading the new text leaves out", () => {
    const [, , first, second] = sectionsOf(body);
    const applied = applyOperations(body, "Invented plan", [
      { op: "replace_section", section: "notes", hash: first!.hash, text: "Rewritten notes." },
      { op: "replace_section", section: "notes-2", hash: second!.hash, text: "" },
    ]);
    assert.strictEqual(applied._tag, "applied");
    if (applied._tag === "applied")
      assert.isTrue(applied.body.endsWith("```\n\n## Notes\n\nRewritten notes.\n"));
  });
});
