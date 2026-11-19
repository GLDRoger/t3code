import { assert, describe, it } from "@effect/vitest";

import {
  addedLines,
  checkInstructions,
  checkProductName,
  checkSharedCopy,
  checkMigrations,
  checkSurvival,
  kinSentences,
  migrationIds,
  supersededIn,
} from "./kin-branch-checks.ts";

const loader = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => `  "${id}": ${id.split("_")[1]},`).join("\n");
const instructions = (version: number, body: string) =>
  `export const instructions = \`instructions-version: ${version}\n${body}\`;\n`;
const line = (n: number) => `const invented${n} = makeSomethingLongEnough(${n}, "value");`;

describe("kin branch checks", () => {
  it("numbers new migrations after the base's highest, with no gap and no repeat", () => {
    const base = migrationIds(loader("87_TeamWork", "88_MoneyRecords"));
    assert.deepStrictEqual(
      checkMigrations(base, migrationIds(loader("87_TeamWork", "88_MoneyRecords", "89_Next"))),
      [],
    );
    // 106 taken while the base was at 88: hosts that run 106 first would skip 89 to 105.
    assert.include(
      checkMigrations(
        base,
        migrationIds(loader("87_TeamWork", "88_MoneyRecords", "106_ChatThreads")),
      )[0],
      "must be 89",
    );
    assert.include(
      checkMigrations(base, migrationIds(loader("87_TeamWork", "88_MoneyRecords", "88_Other")))[0],
      "used twice",
    );
  });

  it("moves the instructions version exactly when their text changes", () => {
    const was = instructions(43, "Old.");
    assert.deepStrictEqual(
      checkInstructions({ mergeBase: was, tip: was, head: instructions(44, "New.") }),
      [],
    );
    assert.deepStrictEqual(checkInstructions({ mergeBase: was, tip: was, head: was }), []);
    // The text changed on 43 after another branch had already taken 43.
    assert.include(
      checkInstructions({
        mergeBase: instructions(42, "Old."),
        tip: was,
        head: instructions(43, "New."),
      })[0],
      "44",
    );
    assert.include(
      checkInstructions({ mergeBase: was, tip: was, head: instructions(44, "Old.") })[0],
      "unchanged",
    );
    // A release range holds merged PRs, each of which went up by one: up to one more per PR.
    const release = { mergeBase: was, tip: was, mergedPrs: 3 };
    assert.deepStrictEqual(checkInstructions({ ...release, head: instructions(46, "New.") }), []);
    assert.include(
      checkInstructions({ ...release, head: instructions(48, "New.") })[0],
      "44 to 47",
    );
    assert.include(
      checkInstructions({ ...release, head: instructions(43, "New.") })[0],
      "44 to 47",
    );
  });

  it("refuses a branch that drops most of a merged PR's lines unless it says it supersedes it", () => {
    const added = Array.from({ length: 12 }, (_, n) => line(n));
    const diff = ["+++ b/app/one.ts", ...added.map((text) => `+${text}`), "+short"].join("\n");
    const files = addedLines(diff);
    assert.strictEqual(files.get("app/one.ts")?.size, 12);
    const merged = [{ pr: 330, files }];
    const tip = () => added.join("\n");
    // A merge that dropped the files a PR had just added.
    const reverted = checkSurvival({ merged, tip, head: () => undefined, superseded: new Set() });
    assert.include(reverted[0], "removes 12 of the 12 lines #330 added");
    const said = checkSurvival({
      merged,
      tip,
      head: () => undefined,
      superseded: supersededIn("Supersedes: #330"),
    });
    assert.deepStrictEqual(said, []);
    // A rename edits lines in place; that keeps the work.
    const renamed = added.map((text) => text.replace("value", "values"));
    assert.deepStrictEqual(
      checkSurvival({ merged, tip, head: () => renamed.join("\n"), superseded: new Set() }),
      [],
    );
  });

  it("refuses a sentence of four or more words typed into both Kin clients", () => {
    const web = `
      // Comments are not copy: Couldn't load the rates.
      export const Rates = (props: { host: string }) => (
        <p className="text-xs text-muted-foreground flex-1 min-w-0">
          Couldn't load the rates. This visual asks to load from <b>{props.host}</b>.
        </p>
      );
      const done = "Saved.";
      const label = \`Open the chat with \${props.host}\`;
    `;
    const phone = `
      const title = "Couldn't load the rates";
      const fragment = \`\${host}\${unicode === null ? "" : \`(shown as \${unicode})\`}\\n\\nThis visual asks to load from it.\`;
      const done = "Saved.";
      const label = \`Open the chat with \${title}\`;
    `;
    assert.deepStrictEqual(kinSentences(web).toSorted(), [
      "Couldn't load the rates.",
      "Open the chat with",
      "This visual asks to load from",
    ]);
    const said = checkSharedCopy(new Map([["web.tsx", web]]), new Map([["phone.tsx", phone]]));
    // The same words with different punctuation, and short words, are left alone.
    assert.deepStrictEqual(
      said.map((problem) => problem.split('"')[1]),
      ["Open the chat with"],
    );
  });

  it("refuses a Kin file that calls the product T3 Kin", () => {
    const problems = checkProductName(
      new Map([
        [
          "kin/Welcome.tsx",
          'const title = "Welcome to Kin";\nconst body = "Open T3 Kin to start.";',
        ],
        ["kin/Host.ts", 'const note = "Runs on a T3 server, as T3 Kinds do.";'],
      ]),
    );
    assert.deepStrictEqual(problems, [
      'kin name: kin/Welcome.tsx:2 says "T3 Kin"; the product is called Kin.',
    ]);
  });
});
