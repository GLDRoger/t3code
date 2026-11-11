import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";
import { fingerprint } from "../memory/sensitivity.ts";
import { keepLabels } from "./labels.ts";

const orgId = KinOrgId.make("fixture-org");
const claim = (id: string, fields: Record<string, unknown> = {}) =>
  fixtureItem({ id, kind: "claim", due: null, title: `Invented ${id}`, ...fields });
const base = new Map([
  ["claims/owners.md", claim("owners", { sensitive: true })],
  ["claims/team.md", claim("team", { sensitive: false })],
  ["claims/second.md", claim("second", { sensitive: false })],
  ["claims/legacy.md", claim("legacy")],
  ["claims/untouched.md", claim("untouched")],
  ["claims/priced.md", claim("priced", { title: "Invented retainer of $4,000" })],
  ["claims/held.md", claim("held", { sensitive: false })],
  // No label in its file, but an earlier night already decided the team can know it.
  ["claims/sorted.md", claim("sorted")],
]);

it.effect.each([
  {
    name: "a merge takes the most sensitive label of what went into it",
    tree: [
      ["claims/owners.md", claim("owners", { sensitive: true, superseded_by: "team" })],
      ["claims/team.md", claim("team", { sensitive: false, links: ["merged"] })],
    ],
    sensitive: { "claims/team.md": true },
  },
  {
    name: "a merge the dream only reported counts too, and so does an unlabelled source",
    tree: [["claims/second.md", claim("second", { sensitive: false, links: ["merged"] })]],
    merges: [{ into: "second", from: ["legacy"] }],
    sensitive: { "claims/second.md": true },
  },
  {
    name: "two things the team can know merge unmarked, and the merged words are only suggested",
    tree: [
      ["claims/second.md", claim("second", { sensitive: false, superseded_by: "team" })],
      ["claims/team.md", claim("team", { sensitive: false, links: ["merged"] })],
    ],
    sensitive: { "claims/team.md": false },
    suggested: ["team"],
  },
  {
    name: "a dream never unmarks an item or one the owner asked to keep",
    tree: [
      ["claims/owners.md", claim("owners", { sensitive: false })],
      ["claims/held.md", claim("held", { sensitive: false, links: ["edited"] })],
      ["claims/sorted.md", claim("sorted", { links: ["edited"] })],
    ],
    sensitive: { "claims/owners.md": true, "claims/held.md": true, "claims/sorted.md": false },
    suggested: ["sorted"],
  },
  {
    name: "it may label what nobody had, except money and access, and the rest becomes the owner's",
    tree: [
      ["claims/legacy.md", claim("legacy", { sensitive: false })],
      [
        "claims/priced.md",
        claim("priced", { title: "Invented retainer of $4,000", sensitive: false }),
      ],
      ["claims/new.md", claim("new")],
    ],
    sensitive: {
      "claims/legacy.md": false,
      "claims/priced.md": true,
      "claims/new.md": true,
      "claims/untouched.md": true,
    },
  },
  {
    name: "a label it dropped comes back",
    tree: [["claims/team.md", claim("team", { links: ["edited"] })]],
    sensitive: { "claims/team.md": false },
    suggested: ["team"],
  },
  {
    name: "what it writes or rewords for the team is only suggested, and an untouched label isn't",
    tree: [
      ["claims/team.md", claim("team", { sensitive: false, title: "Invented reworded team" })],
      ["claims/second.md", claim("second", { sensitive: false, superseded_by: "team" })],
      ["claims/fresh.md", claim("fresh", { sensitive: false })],
    ],
    sensitive: { "claims/team.md": false, "claims/fresh.md": false },
    suggested: ["team", "fresh"],
  },
  {
    name: "money said only in its quote keeps an item the owner's",
    tree: [
      [
        "claims/quoted.md",
        claim("quoted", { sensitive: false, quote: "Invented retainer of $4,000 a month" }),
      ],
    ],
    sensitive: { "claims/quoted.md": true },
  },
] as const)("keepLabels: $name", (row) =>
  Effect.gen(function* () {
    const tree = new Map([...base, ...row.tree]);
    const touched = new Map([...tree].filter(([path, text]) => base.get(path) !== text));
    const { changes, classified, suggested } = yield* keepLabels({
      orgId,
      base,
      tree,
      changes: touched,
      merges: "merges" in row ? row.merges : [],
      labels: { held: new Set(["held"]), classified: new Map([["sorted", false]]) },
    });
    // An item's label is its file's when the dream touched it, else what is recorded for it.
    const label = (path: string) =>
      /^sensitive: (true|false)$/m.exec(changes.get(path) ?? "")?.[1] ??
      String(classified.get(path.slice("claims/".length, -".md".length))?.sensitive);
    for (const [path, sensitive] of Object.entries(row.sensitive))
      assert.strictEqual(label(path), String(sensitive), path);
    // Only label lines change, only in files the dream touched, and every item that had no
    // label anywhere ends the night with one.
    assert.sameMembers([...changes.keys()], [...touched.keys()]);
    for (const [path, text] of changes)
      assert.strictEqual(
        text.replace(/^sensitive: .*\n/m, ""),
        (tree.get(path) ?? "").replace(/^sensitive: .*\n/m, ""),
        path,
      );
    assert.sameMembers([...classified.keys()], ["legacy", "untouched", "priced"]);
    // A suggestion is of the words the dream left, never a model-reported merge's.
    assert.sameMembers([...suggested.keys()], "suggested" in row ? [...row.suggested] : []);
    for (const [id, content] of suggested) {
      const path = `claims/${id}.md`;
      const parsed = yield* parseFrontMatter(orgId, path, changes.get(path) ?? "");
      assert.strictEqual(content, fingerprint({ head: parsed.frontMatter, body: parsed.body }));
    }
  }),
);
