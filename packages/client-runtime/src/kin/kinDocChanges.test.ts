import { describe, expect, it } from "vite-plus/test";

import { kinDocChanges, kinDocWordRuns, type KinDocChange } from "./kinDocChanges.ts";

// An invented plan only.
const before = [
  "# Invented launch plan",
  "",
  "Intro for the invented launch.",
  "",
  "## Pricing",
  "",
  "Starter costs **10** invented credits a month.",
  "",
  "| Plan | Price | Seats |",
  "| --- | --- | --- |",
  "| Starter | 10 | 3 |",
  "| Team | 40 | 10 |",
  "",
  "## Timeline",
  "",
  "- Design freeze on the 3rd",
  "- Launch on the 10th",
  "",
  "## Risks",
  "",
  "None yet.",
].join("\n");

const shown = (body: string) =>
  kinDocChanges(before, body).parts.flatMap((part): ReadonlyArray<KinDocChange> =>
    part.type === "shown" ? [part.change] : [],
  );
const marked = (runs: ReadonlyArray<{ text: string; mark: string }>) =>
  runs.filter((run) => run.mark !== "same").map((run) => `${run.mark}:${run.text}`);

describe("what changed in a doc", () => {
  it("marks the words that changed inside a paragraph, not the whole line", () => {
    expect(kinDocWordRuns("Launch on the 10th.", "Launch on the 14th of December.")).toEqual([
      { text: "Launch on the ", mark: "same" },
      { text: "10th.", mark: "removed" },
      { text: "14th of December.", mark: "added" },
    ]);
    const changes = shown(before.replace("**10** invented credits", "**12** invented credits"));
    const edit = changes.find((change) => change.type === "text");
    // Formatting marks are not words: the reader sees 10 become 12.
    expect(edit).toMatchObject({ block: "paragraph" });
    expect(edit?.type === "text" ? marked(edit.runs) : []).toEqual(["removed:10", "added:12"]);
  });

  it("marks changed table cells and whole rows that came or went", () => {
    const after = before
      .replace("| Team | 40 | 10 |", "| Team | 45 | 10 |\n| Scale | 90 | 50 |")
      .replace("| Starter | 10 | 3 |\n", "");
    const table = shown(after).find((change) => change.type === "table");
    expect(table?.type === "table" ? table.rows.map((row) => row.mark) : []).toEqual([
      "removed",
      "changed",
      "added",
    ]);
    expect(table?.type === "table" ? table.rows[1]!.cells.map((cell) => marked(cell)) : []).toEqual(
      [[], ["removed:40", "added:45"], []],
    );
  });

  it("marks list items one by one and rewords a heading in place", () => {
    const after = before
      .replace("- Launch on the 10th", "- Launch on the 14th\n- Review a week later")
      .replace("## Risks", "## Open risks");
    const changes = shown(after);
    const list = changes.find((change) => change.type === "list");
    expect(list?.type === "list" ? list.items.map((item) => item.mark) : []).toEqual([
      "same",
      "changed",
      "added",
    ]);
    expect(changes.find((change) => change.type === "text")).toMatchObject({
      block: "heading",
      level: 2,
      runs: [
        { text: "Risks", mark: "removed" },
        { text: "Open risks", mark: "added" },
      ],
    });
  });

  it("folds long added or removed sections and long unchanged stretches, each with a name", () => {
    const section = [
      "## Appendix",
      ...Array.from({ length: 8 }, (_, index) => `Invented appendix paragraph ${index + 1}.`),
    ].join("\n\n");
    const added = kinDocChanges(before, `${before}\n\n${section}`);
    expect(added.identical).toBe(false);
    expect(
      added.parts.map((part) => (part.type === "folded" ? part.label : part.change.type)),
    ).toEqual(["8 paragraphs unchanged", "block", "Added section: Appendix"]);
    const removed = kinDocChanges(`${before}\n\n${section}`, before);
    expect(removed.parts.at(-1)).toMatchObject({
      type: "folded",
      mark: "removed",
      label: "Removed section: Appendix",
    });
    // A short addition is simply shown, marked, with the paragraph before it for its place.
    const short = kinDocChanges(before, `${before}\n\nOne more line.`);
    expect(short.parts.slice(-2)).toMatchObject([
      { type: "shown", change: { type: "block", mark: "same", markdown: "None yet." } },
      { type: "shown", change: { type: "block", mark: "added", markdown: "One more line." } },
    ]);
  });

  it("says two versions read the same when only blank lines differ", () => {
    expect(kinDocChanges(before, before.replace(/\n\n/g, "\n\n\n")).identical).toBe(true);
    expect(kinDocChanges("", "").parts).toEqual([]);
  });

  it("keeps a fenced block whole and compares it line by line", () => {
    const code = (line: string) => ["Run it:", "", "```sh", "vp i", line, "```"].join("\n");
    const change = kinDocChanges(code("vp run dev"), code("vp run dev --share")).parts.at(-1);
    expect(change).toMatchObject({
      type: "shown",
      change: {
        type: "code",
        lines: [
          { text: "```sh", mark: "same" },
          { text: "vp i", mark: "same" },
          { text: "vp run dev", mark: "removed" },
          { text: "vp run dev --share", mark: "added" },
          { text: "```", mark: "same" },
        ],
      },
    });
  });
});
