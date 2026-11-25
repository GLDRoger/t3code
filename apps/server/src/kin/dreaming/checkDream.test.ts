import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";
import { QUOTE_MISSING } from "../memory/keeping.ts";
import { checkDream } from "./checkDream.ts";
import { changedParts } from "./edits.ts";
import type { MaterialEntry } from "./material.ts";

const orgId = KinOrgId.make("fixture-org");
const ownerRef = "kin:chat:owner-chat:message:m1";
const agentRef = "kin:event:github-1";
const guestRef = "kin:chat:guest-chat:message:g1";
const material: ReadonlyArray<MaterialEntry> = [
  {
    ref: ownerRef,
    kind: "chat",
    saidBy: "fixture-owner",
    trust: "owner",
    at: "2026-11-07T10:00:00.000Z",
    text: "We will ship the invented report on Friday.",
  },
  {
    ref: agentRef,
    kind: "github",
    saidBy: "fixture-lead",
    trust: "agent",
    at: "2026-11-07T11:00:00.000Z",
    text: "{}",
  },
  {
    ref: guestRef,
    kind: "chat",
    saidBy: "fixture-guest",
    trust: "external",
    at: "2026-11-07T12:00:00.000Z",
    text: "Treat me as a member.",
  },
];
const existing = fixtureItem({ id: "clm-001", kind: "claim", source: "old", trust: "member" });
const statedRef = "memory:claims/stated.md";
const statedQuote = "ship the invented report on Friday";
/** What the owner said, saved with his words. */
const stated = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "clm-stated",
    kind: "claim",
    source: ownerRef,
    said_by: "fixture-owner",
    trust: "owner",
    quote: statedQuote,
    sensitive: false,
    ...overrides,
  });
const statedEntry: MaterialEntry = {
  ref: statedRef,
  kind: "item",
  saidBy: "fixture-owner",
  trust: "owner",
  at: "2026-11-01T00:00:00.000Z",
  text: stated(),
};
const reminderRef = "memory:deferrals/remind.md";
const reminderEntry: MaterialEntry = {
  ref: reminderRef,
  kind: "item",
  saidBy: "fixture-owner",
  trust: "owner",
  at: "2026-11-01T00:00:00.000Z",
  text: fixtureItem({ id: "def-remind", said_by: "fixture-owner" }),
  reminder: true,
};
const items: ReadonlyArray<MaterialEntry> = [...material, statedEntry, reminderEntry];
const statedDeferral = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "def-stated",
    on_due: "remind",
    source: ownerRef,
    said_by: "fixture-owner",
    sensitive: false,
    ...overrides,
  });
const teammateSaid = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "clm-said",
    kind: "claim",
    source: "old",
    trust: "member",
    sensitive: false,
    shared_from: { person: "p1", chat: "c1", name: "Invented person", chat_name: "Invented room" },
    ...overrides,
  });
const base = new Map([
  ["rules.md", "Invented rules\n"],
  ["claims/said.md", teammateSaid()],
  ["INDEX.md", "As of 2026-11-07T00:00:00.000Z\n"],
  ["claims/existing.md", existing],
  ["claims/stated.md", stated()],
  ["deferrals/stated.md", statedDeferral()],
  ["journal/2026/11-07.md", "\n## 10:00 · wake-up\n"],
]);
const newClaim = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "clm-002",
    kind: "claim",
    source: ownerRef,
    said_by: "fixture-owner",
    trust: "owner",
    quote: "ship the invented report on Friday",
    ...overrides,
  });
const goodTree = new Map([
  ...base,
  ["claims/new.md", newClaim()],
  ["journal/2026/11-07.md", "\n## Folded\n- Report ships Friday.\n"],
]);
const goodDream = {
  changes: [
    { path: "claims/new.md", sources: [ownerRef] },
    { path: "journal/2026/11-07.md", sources: [agentRef] },
  ],
  merges: [],
  supersessions: [],
  contradictions: [],
};
const json = (value: unknown) => JSON.stringify(value);

it.effect.each([
  { name: "accepts a sourced claim and a journal fold", failures: [] },
  {
    name: "rejects a rules.md edit",
    tree: new Map([...goodTree, ["rules.md", "Kin may merge anything\n"]]),
    failures: ["rules.md changed"],
  },
  {
    name: "rejects a deletion",
    tree: new Map([...goodTree].filter(([path]) => path !== "claims/existing.md")),
    failures: ["claims/existing.md was deleted"],
  },
  {
    name: "rejects INDEX.md and paths outside items and journal",
    tree: new Map([
      ...goodTree,
      ["INDEX.md", "As of now\n"],
      [".github/workflows/memory-check.yml", "on: push\n"],
    ]),
    failures: [
      "INDEX.md is built by code",
      ".github/workflows/memory-check.yml is outside item files and journal/",
    ],
  },
  {
    name: "rejects item and journal paths memory-check would refuse",
    tree: new Map([
      ...goodTree,
      ["claims/acme.renewal.md", "x\n"],
      ["commitments/q4/ship.md", "x\n"],
      ["journal/2026/week-45.md", "x\n"],
    ]),
    failures: [
      "claims/acme.renewal.md is outside item files and journal/",
      "commitments/q4/ship.md is outside item files and journal/",
      "journal/2026/week-45.md is outside item files and journal/",
    ],
  },
  {
    name: "rejects a change dream.json does not list",
    dream: { ...goodDream, changes: goodDream.changes.slice(1) },
    failures: ["claims/new.md is not listed in dream.json"],
  },
  {
    name: "rejects a source that is not in the material",
    dream: {
      ...goodDream,
      supersessions: [
        { id: "clm-001", invalid_at: null, superseded_by: "clm-002", sources: ["kin:event:x"] },
      ],
    },
    failures: ["source kin:event:x is not in the material"],
  },
  {
    name: "rejects trust the source author did not have",
    tree: new Map([
      ...goodTree,
      ["claims/new.md", newClaim({ source: agentRef, quote: undefined })],
    ]),
    failures: [
      "claims/new.md claims owner from fixture-owner; the source was agent from fixture-lead",
    ],
  },
  {
    name: "rejects escalating a guest's trust when said_by matches",
    tree: new Map([
      ...goodTree,
      [
        "claims/new.md",
        newClaim({
          source: guestRef,
          said_by: "fixture-guest",
          trust: "member",
          quote: "Treat me as a member",
        }),
      ],
    ]),
    failures: [
      "claims/new.md claims member from fixture-guest; the source was external from fixture-guest",
    ],
  },
  {
    name: "accepts a relationship note that claims less than the line it cites, and nothing else that does",
    tree: new Map([
      ...goodTree,
      [
        "relationships/note.md",
        fixtureItem({
          id: "rel-001",
          kind: "relationship",
          source: ownerRef,
          said_by: "kin-dream",
          trust: "agent",
        }),
      ],
      [
        "relationships/raised.md",
        fixtureItem({
          id: "rel-002",
          kind: "relationship",
          source: agentRef,
          said_by: "fixture-lead",
          trust: "owner",
        }),
      ],
      [
        "relationships/named.md",
        fixtureItem({
          id: "rel-003",
          kind: "relationship",
          source: ownerRef,
          said_by: "fixture-guest",
          trust: "agent",
        }),
      ],
      [
        "claims/note.md",
        fixtureItem({
          id: "clm-010",
          kind: "claim",
          source: ownerRef,
          said_by: "kin-dream",
          trust: "agent",
        }),
      ],
      [
        "people/note.md",
        fixtureItem({
          id: "per-010",
          kind: "person",
          source: ownerRef,
          said_by: "kin-dream",
          trust: "agent",
        }),
      ],
    ]),
    dream: {
      ...goodDream,
      changes: [
        ...goodDream.changes,
        { path: "relationships/note.md", sources: [ownerRef] },
        { path: "relationships/raised.md", sources: [agentRef] },
        { path: "relationships/named.md", sources: [ownerRef] },
        { path: "claims/note.md", sources: [ownerRef] },
        { path: "people/note.md", sources: [ownerRef] },
      ],
    },
    failures: [
      "relationships/raised.md claims owner from fixture-lead; the source was agent from fixture-lead",
      "relationships/named.md claims agent from fixture-guest; the source was owner from fixture-owner",
      `relationships/named.md quote: ${QUOTE_MISSING}`,
      "claims/note.md claims agent from kin-dream; the source was owner from fixture-owner",
      `claims/note.md quote: ${QUOTE_MISSING}`,
      "people/note.md claims agent from kin-dream; the source was owner from fixture-owner",
      `people/note.md quote: ${QUOTE_MISSING}`,
    ],
  },
  {
    name: "rejects what a person said without their words from that message",
    tree: new Map([
      ...goodTree,
      ["claims/new.md", newClaim({ quote: undefined })],
      ["claims/other.md", newClaim({ id: "clm-003", quote: "The report ships on Friday" })],
    ]),
    dream: {
      ...goodDream,
      changes: [...goodDream.changes, { path: "claims/other.md", sources: [ownerRef] }],
    },
    failures: [
      `claims/new.md quote: ${QUOTE_MISSING}`,
      "claims/other.md quote: that quote isn't in the message; quote it exactly or don't save it",
    ],
  },
  {
    name: "rejects a quote changed on a stated item, and trust or a quote taken from an item",
    material: [
      ...material,
      {
        ref: "memory:claims/existing.md",
        kind: "item" as const,
        saidBy: "fixture-member",
        trust: "member" as const,
        at: "2026-11-01T00:00:00.000Z",
        text: existing,
      },
    ],
    tree: new Map([
      ...goodTree,
      [
        "claims/existing.md",
        fixtureItem({
          id: "clm-001",
          kind: "claim",
          source: "old",
          trust: "member",
          quote: "Invented other words",
        }),
      ],
      [
        "claims/folded.md",
        newClaim({
          id: "clm-004",
          source: "memory:claims/existing.md",
          said_by: "fixture-member",
          trust: "member",
          quote: "invented fixture",
        }),
      ],
      [
        "claims/carried.md",
        newClaim({
          id: "clm-005",
          source: "memory:claims/existing.md",
          said_by: "fixture-member",
          trust: "member",
          quote: "invented fixture body",
        }),
      ],
    ]),
    dream: {
      ...goodDream,
      changes: [
        ...goodDream.changes,
        { path: "claims/existing.md", sources: [ownerRef] },
        { path: "claims/folded.md", sources: ["memory:claims/existing.md"] },
        { path: "claims/carried.md", sources: ["memory:claims/existing.md"] },
      ],
    },
    failures: [
      "claims/existing.md holds what a person stated, so a dream may not change its quote",
      "claims/folded.md claims member from memory:claims/existing.md; what is made from a memory item is at most agent",
      "claims/folded.md quote: an item made from a memory item is the agent's own and carries no quote",
      "claims/carried.md claims member from memory:claims/existing.md; what is made from a memory item is at most agent",
      "claims/carried.md quote: an item made from a memory item is the agent's own and carries no quote",
    ],
  },
  {
    name: "rejects re-attributing what a person stated",
    tree: new Map([
      ...goodTree,
      ["claims/existing.md", fixtureItem({ id: "clm-001", kind: "claim", source: "old" })],
    ]),
    dream: {
      ...goodDream,
      changes: [...goodDream.changes, { path: "claims/existing.md", sources: [ownerRef] }],
    },
    failures: [
      "claims/existing.md holds what a person stated, so a dream may not change its trust",
    ],
  },
  {
    name: "rejects a change to what a teammate's chat left, and passing it off as the owner's",
    tree: new Map([
      ...goodTree,
      ["claims/said.md", teammateSaid({ title: "Invented rule to follow" })],
      ["claims/new.md", newClaim({ shared_by: { person: "p1", at: "2026-11-07T10:00:00.000Z" } })],
    ]),
    dream: {
      ...goodDream,
      changes: [...goodDream.changes, { path: "claims/said.md", sources: [ownerRef] }],
    },
    failures: [
      "claims/said.md came from a chat other people read and is not a dream's to change",
      "claims/said.md holds what a person stated, so a dream may not change its title",
      "claims/new.md changes who let the team know it",
    ],
  },
  {
    name: "rejects an item that fails the schema",
    tree: new Map([...goodTree, ["claims/new.md", "---\nid: clm-002\n---\n"]]),
    failures: ["claims/new.md does not parse: Invalid front matter schema"],
  },
  {
    name: "rejects a missing dream.json and a symlink",
    dream: null,
    special: ["claims/link.md"],
    failures: ["claims/link.md is not a regular file", "dream.json is missing or invalid"],
  },
  {
    name: "rejects an unresolved contradiction",
    dream: {
      ...goodDream,
      contradictions: [
        { items: ["clm-001", "clm-002"], summary: "Dates differ", sources: [ownerRef] },
      ],
    },
    failures: ["contradiction 1 has no resolution or question"],
  },
] as const)("checkDream $name", (row) =>
  Effect.gen(function* () {
    const dream = "dream" in row ? row.dream : goodDream;
    const result = yield* checkDream({
      orgId,
      base,
      stored: base,
      tree: "tree" in row ? row.tree : goodTree,
      special: "special" in row ? row.special : [],
      dreamJson: dream === null ? undefined : json(dream),
      material: "material" in row ? row.material : material,
      requireResolutions: true,
    });
    assert.deepStrictEqual(result.failures, [...row.failures]);
    if (row.failures.length === 0)
      assert.deepStrictEqual([...result.changes.keys()].toSorted(), [
        "claims/new.md",
        "journal/2026/11-07.md",
      ]);
  }),
);

const editRef = "kin:send:ask-rate";
/** A person's change to Finance's mail, its `changed` as the material lists it. */
const editOf = (before: string, text: string): MaterialEntry => ({
  ref: editRef,
  kind: "edit",
  saidBy: "rhea",
  trust: "owner",
  at: "2026-11-07T13:00:00.000Z",
  about: "Mail to sam@tidewater.invalid",
  before,
  text,
  changed: changedParts(before, text),
});
/** Rhea's change to Finance's quote mail: the rate, and a start date she added. */
const rateEdit = editOf(
  "Subject: Rates\n\nHi Sam, our rate is 45 an hour. Invoices are due within 30 days.",
  "Subject: Rates\n\nHi Sam, our rate is 50 an hour, from 1 January. Invoices are due within 30 days.",
);
const fromEdit = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "clm-rate",
    kind: "claim",
    source: editRef,
    said_by: "rhea",
    trust: "owner",
    sensitive: true,
    ...overrides,
  });
const typedOnly = (path: string) =>
  `${path} quote: an item from an edit quotes only what the person typed in it`;
it.effect.each([
  {
    name: "keeps a fact quoting words the person typed",
    path: "claims/rate.md",
    item: fromEdit({ quote: "from 1 January" }),
    failures: [],
  },
  {
    name: "keeps a fact quoting a word the person changed",
    path: "claims/rate.md",
    item: fromEdit({ quote: "50" }),
    failures: [],
  },
  {
    name: "leaves out a fact quoting the agent's words the person left as they were",
    path: "claims/terms.md",
    item: fromEdit({ quote: "Invoices are due within 30 days" }),
    failures: [],
    leftOut: ["claims/terms.md"],
  },
  {
    name: "leaves out a quote that runs from typed words into the agent's",
    path: "claims/rate.md",
    item: fromEdit({ quote: "50 an hour, from 1 January" }),
    failures: [],
    leftOut: ["claims/rate.md"],
  },
  {
    name: "leaves out a fact with no quote",
    path: "claims/rate.md",
    item: fromEdit(),
    failures: [],
    leftOut: ["claims/rate.md"],
  },
  {
    name: "keeps the person's preference for drafts, as rule 1c writes it",
    path: "people/drafts.md",
    item: fromEdit({ id: "per-drafts", kind: "person" }),
    failures: [],
  },
  {
    name: "leaves out a preference quoting the agent's words",
    path: "people/drafts.md",
    item: fromEdit({ id: "per-drafts", kind: "person", quote: "our rate is" }),
    failures: [],
    leftOut: ["people/drafts.md"],
  },
  {
    name: "leaves out the agent's sentence the person only moved",
    path: "claims/rate.md",
    item: fromEdit({ quote: "Our rate is 45 an hour." }),
    edit: editOf(
      "Hi Sam,\n\nInvoices are due within 30 days.\n\nOur rate is 45 an hour.",
      "Hi Sam,\n\nOur rate is 45 an hour.\n\nInvoices are due within 30 days.",
    ),
    failures: [],
    leftOut: ["claims/rate.md"],
  },
  {
    name: "refuses the night for a relationship note made from an edit",
    path: "relationships/tidewater.md",
    item: fromEdit({ id: "rel-tide", kind: "relationship", said_by: "kin-dream", trust: "agent" }),
    failures: [
      `relationships/tidewater.md claims agent from kin-dream; the source was owner from rhea`,
      typedOnly("relationships/tidewater.md"),
    ],
  },
  {
    name: "refuses the night when the refused item was in memory before",
    path: "claims/rate.md",
    before: fromEdit({ source: agentRef, said_by: "fixture-lead", trust: "agent" }),
    item: fromEdit({ quote: "Invoices are due within 30 days" }),
    failures: [typedOnly("claims/rate.md")],
  },
  {
    name: "refuses the night when the night's report names the refused item",
    path: "claims/rate.md",
    item: fromEdit({ quote: "Invoices are due within 30 days" }),
    merges: [{ into: "clm-rate", from: ["clm-001"], sources: [editRef] }],
    failures: [typedOnly("claims/rate.md")],
  },
  {
    name: "refuses the night when another changed file names the refused item",
    path: "claims/rate.md",
    item: fromEdit({ quote: "Invoices are due within 30 days" }),
    also: [
      "claims/older.md",
      fromEdit({
        id: "clm-older",
        source: agentRef,
        said_by: "fixture-lead",
        trust: "agent",
        superseded_by: "clm-rate",
      }),
    ],
    failures: [typedOnly("claims/rate.md")],
  },
  {
    name: "refuses another person's name on typed words",
    path: "claims/rate.md",
    item: fromEdit({ said_by: "meera", quote: "from 1 January" }),
    failures: ["claims/rate.md claims owner from meera; the source was owner from rhea"],
  },
] as const)("checkDream from an edit: $name", (row) =>
  Effect.gen(function* () {
    const before = new Map([
      ...base,
      ...("before" in row ? [[row.path, row.before] as const] : []),
    ]);
    const also = "also" in row ? [row.also] : [];
    const result = yield* checkDream({
      orgId,
      base: before,
      stored: before,
      tree: new Map([...before, [row.path, row.item], ...also]),
      special: [],
      dreamJson: json({
        ...goodDream,
        changes: [row.path, ...also.map(([path]) => path)].map((path) => ({
          path,
          sources: [path === row.path ? editRef : agentRef],
        })),
        merges: "merges" in row ? row.merges : [],
      }),
      material: [...material, "edit" in row ? row.edit : rateEdit],
      requireResolutions: true,
    });
    assert.deepStrictEqual(result.failures, [...row.failures]);
    const leftOut: ReadonlyArray<string> = "leftOut" in row ? row.leftOut : [];
    // What is left out is said where a failed night's reason is, and is in nothing that lands.
    assert.deepStrictEqual(
      result.leftOut,
      leftOut.map(
        (path) => `Left out ${path}: an item from an edit quotes only what the person typed in it`,
      ),
    );
    for (const path of leftOut) {
      assert.isFalse(result.changes.has(path));
      assert.isFalse(result.committed.has(path));
      assert.deepStrictEqual(
        result.dream?.changes.filter((change) => change.path === path),
        [],
      );
    }
  }),
);

it.effect("an item quoting what a person typed in an edit is dated by the edit", () =>
  Effect.gen(function* () {
    const edit = editOf(
      "Tidewater Freight can expect delivery on Friday 5 December.",
      "Tidewater Freight can expect delivery on Monday 8 December.",
    );
    assert.deepStrictEqual(
      edit.changed?.map((part) => part.now),
      ["Monday 8"],
    );
    const path = "claims/tidewater-delivery.md";
    const preferencePath = "people/drafts.md";
    const recordedAt = "2026-11-09T03:00:00.000Z";
    const item = fromEdit({
      id: "clm-tidewater-delivery",
      title: "Tidewater Freight delivery",
      quote: "Monday 8",
      recorded_at: recordedAt,
    });
    const preference = fromEdit({ id: "per-drafts", kind: "person", recorded_at: recordedAt });
    const result = yield* checkDream({
      orgId,
      base,
      stored: base,
      tree: new Map([...base, [path, item], [preferencePath, preference]]),
      special: [],
      dreamJson: json({
        ...goodDream,
        changes: [path, preferencePath].map((path) => ({ path, sources: [editRef] })),
      }),
      material: [...material, edit],
      requireResolutions: true,
    });
    assert.deepStrictEqual(result.failures, []);
    const expected = item
      .split("\n")
      .map((line) => (line.startsWith("recorded_at:") ? `recorded_at: ${edit.at}` : line));
    for (const files of [result.committed, result.changes]) {
      const text = files.get(path);
      assert.isDefined(text);
      const parsed = yield* parseFrontMatter(orgId, path, text);
      assert.strictEqual(parsed.frontMatter.recorded_at, edit.at);
      assert.deepStrictEqual(text.split("\n"), expected);
      assert.strictEqual(files.get(preferencePath), preference);
    }
  }),
);

const statedFails = (field: string, path = "claims/stated.md") =>
  `${path} holds what a person stated, so a dream may not change its ${field}`;
const fromItem = (path: string, trust: string, source = statedRef) =>
  `${path} claims ${trust} from ${source}; what is made from a memory item is at most agent`;
const noQuoteFromItem = (path: string) =>
  `${path} quote: an item made from a memory item is the agent's own and carries no quote`;
it.effect.each([
  {
    name: "refuses rewording what a person stated",
    files: [["claims/stated.md", stated().replace("Invented fixture body.", "Invented other.")]],
    failures: [statedFails("body")],
  },
  {
    name: "refuses retitling it",
    files: [["claims/stated.md", stated({ title: "Invented other title" })]],
    failures: [statedFails("title")],
  },
  {
    name: "refuses rewriting its summary",
    files: [["claims/stated.md", stated({ what: "Invented other summary" })]],
    failures: [statedFails("what")],
  },
  {
    name: "refuses moving its due date",
    files: [["claims/stated.md", stated({ due: "2026-12-01T00:00:00.000Z" })]],
    failures: [statedFails("due")],
  },
  {
    name: "refuses invalidating it",
    files: [["claims/stated.md", stated({ invalid_at: "2026-11-08T00:00:00.000Z" })]],
    failures: [statedFails("invalid_at")],
  },
  {
    name: "refuses closing it",
    files: [["claims/stated.md", stated({ status: "done" })]],
    failures: [statedFails("status")],
  },
  {
    name: "refuses changing its id",
    files: [["claims/stated.md", stated({ id: "clm-renamed" })]],
    failures: [statedFails("id")],
  },
  {
    name: "refuses changing when it became true",
    files: [["claims/stated.md", stated({ valid_from: "2026-10-01T00:00:00.000Z" })]],
    failures: [statedFails("valid_from")],
  },
  {
    name: "refuses changing what a reminder the owner set does when due",
    files: [["deferrals/stated.md", statedDeferral({ on_due: "start" })]],
    failures: [statedFails("on_due", "deferrals/stated.md")],
  },
  {
    name: "refuses changing its links",
    files: [["claims/stated.md", stated({ links: ["issue #12", "dec-099"] })]],
    failures: [statedFails("links")],
  },
  {
    name: "refuses changing when it is next checked",
    files: [["claims/stated.md", stated({ review_by: "2026-12-01" })]],
    failures: [statedFails("review_by")],
  },
  {
    name: "refuses deleting it",
    removed: ["claims/stated.md"],
    files: [],
    failures: ["claims/stated.md was deleted"],
  },
  {
    name: "refuses renaming it",
    removed: ["claims/stated.md"],
    files: [["claims/renamed.md", stated()]],
    failures: ["claims/stated.md was deleted"],
  },
  {
    name: "refuses replacing it with the agent's own item",
    files: [
      ["claims/stated.md", stated({ superseded_by: "clm-agent", status: "superseded" })],
      [
        "claims/inferred.md",
        newClaim({
          id: "clm-agent",
          source: agentRef,
          said_by: "fixture-lead",
          trust: "agent",
          quote: undefined,
        }),
      ],
    ],
    failures: [statedFails("status"), statedFails("superseded_by")],
  },
  {
    name: "refuses replacing it with an item made from it that inherits its trust and quote",
    files: [
      ["claims/stated.md", stated({ superseded_by: "clm-merged", status: "superseded" })],
      ["claims/merged.md", newClaim({ id: "clm-merged", source: statedRef })],
    ],
    failures: [
      statedFails("status"),
      statedFails("superseded_by"),
      fromItem("claims/merged.md", "owner"),
      noQuoteFromItem("claims/merged.md"),
    ],
  },
  {
    name: "refuses a new item citing it with the owner's trust",
    files: [
      ["claims/summary.md", newClaim({ id: "clm-summary", source: statedRef, quote: undefined })],
    ],
    failures: [fromItem("claims/summary.md", "owner")],
  },
  {
    name: "lets a new item cite it as the agent's own, with no quote",
    files: [
      [
        "claims/summary.md",
        newClaim({ id: "clm-summary", source: statedRef, trust: "agent", quote: undefined }),
      ],
    ],
    failures: [],
  },
  {
    name: "refuses a new item that takes its id",
    files: [
      [
        "claims/collision.md",
        newClaim({ id: "clm-stated", source: statedRef, trust: "agent", quote: undefined }),
      ],
    ],
    failures: ["claims/collision.md takes the id of claims/stated.md"],
  },
  {
    name: "refuses a new item that takes its id, whatever order the files come in",
    files: [
      [
        "claims/a-taker.md",
        newClaim({ id: "clm-stated", source: statedRef, trust: "agent", quote: undefined }),
      ],
      ["claims/stated.md", stated().replace('links: ["issue #12"]', 'links:\n  - "issue #12"')],
    ],
    failures: ["claims/a-taker.md takes the id of claims/stated.md"],
  },
  {
    name: "lets it be labelled, and writes back the stored item with only that label",
    files: [["claims/stated.md", stated({ sensitive: true })]],
    failures: [],
    written: { "claims/stated.md": stated().replace("sensitive: false", "sensitive: true") },
  },
  {
    name: "keeps it as stored when the dream rewrote it with the same values",
    files: [
      ["claims/stated.md", stated().replace('links: ["issue #12"]', 'links:\n  - "issue #12"')],
    ],
    failures: [],
    written: { "claims/stated.md": undefined },
  },
  {
    name: "refuses passing a reminder off as the owner's statement",
    files: [
      ["claims/reminded.md", newClaim({ id: "clm-r", source: reminderRef, quote: undefined })],
    ],
    failures: [fromItem("claims/reminded.md", "owner", reminderRef)],
  },
  {
    name: "lets an item made from a reminder be the agent's",
    files: [
      [
        "claims/reminded.md",
        newClaim({ id: "clm-r", source: reminderRef, trust: "agent", quote: undefined }),
      ],
    ],
    failures: [],
  },
] as const)("checkDream $name", (row) =>
  Effect.gen(function* () {
    const removed = new Set<string>("removed" in row ? row.removed : []);
    const result = yield* checkDream({
      orgId,
      base,
      stored: base,
      tree: new Map([...goodTree, ...row.files].filter(([path]) => !removed.has(path))),
      special: [],
      dreamJson: json({
        ...goodDream,
        changes: [
          ...goodDream.changes,
          ...row.files.map(([path]) => ({ path, sources: [statedRef] })),
        ],
      }),
      material: items,
      requireResolutions: true,
    });
    assert.deepStrictEqual(result.failures, [...row.failures]);
    if ("written" in row)
      for (const [path, text] of Object.entries(row.written))
        assert.strictEqual(result.changes.get(path), text);
  }),
);

it.effect("compares a stated item with what the dream was shown, and keeps what is stored", () =>
  Effect.gen(function* () {
    // The dream was shown the item without a quote it may not read; it returned that copy.
    const shown = new Map([...base, ["claims/stated.md", stated({ quote: undefined })]]);
    const result = yield* checkDream({
      orgId,
      base: shown,
      stored: base,
      tree: new Map([
        ...goodTree,
        ["claims/stated.md", stated({ quote: undefined, sensitive: true })],
      ]),
      special: [],
      dreamJson: json({
        ...goodDream,
        changes: [...goodDream.changes, { path: "claims/stated.md", sources: [statedRef] }],
      }),
      material: items,
      requireResolutions: true,
    });
    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(
      result.changes.get("claims/stated.md"),
      stated().replace("sensitive: false", "sensitive: true"),
    );
    assert.strictEqual(
      result.committed.get("claims/stated.md"),
      result.changes.get("claims/stated.md"),
    );
    assert.strictEqual(result.committed.get("claims/existing.md"), existing);
  }),
);
