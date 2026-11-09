import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { checkDream } from "./checkDream.ts";
import type { MaterialEntry } from "./material.ts";

const orgId = KinOrgId.make("fixture-org");
const ownerRef = "kin:chat:owner-chat:message:m1";
const agentRef = "kin:event:report-1";
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
    kind: "worker_report",
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
const base = new Map([
  ["rules.md", "Invented rules\n"],
  ["INDEX.md", "As of 2026-11-07T00:00:00.000Z\n"],
  ["claims/existing.md", existing],
  ["journal/2026/11-07.md", "\n## 10:00 · wake-up\n"],
]);
const newClaim = (overrides: Record<string, unknown> = {}) =>
  fixtureItem({
    id: "clm-002",
    kind: "claim",
    source: ownerRef,
    said_by: "fixture-owner",
    trust: "owner",
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
    tree: new Map([...goodTree, ["claims/new.md", newClaim({ source: agentRef })]]),
    failures: [
      "claims/new.md claims owner from fixture-owner; the source was agent from fixture-lead",
    ],
  },
  {
    name: "rejects escalating a guest's trust when said_by matches",
    tree: new Map([
      ...goodTree,
      ["claims/new.md", newClaim({ source: guestRef, said_by: "fixture-guest", trust: "member" })],
    ]),
    failures: [
      "claims/new.md claims member from fixture-guest; the source was external from fixture-guest",
    ],
  },
  {
    name: "rejects re-attributing an existing item to unknown provenance",
    tree: new Map([
      ...goodTree,
      ["claims/existing.md", fixtureItem({ id: "clm-001", kind: "claim", source: "old" })],
    ]),
    dream: {
      ...goodDream,
      changes: [...goodDream.changes, { path: "claims/existing.md", sources: [ownerRef] }],
    },
    failures: ["claims/existing.md source old is not in the material"],
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
      tree: "tree" in row ? row.tree : goodTree,
      special: "special" in row ? row.special : [],
      dreamJson: dream === null ? undefined : json(dream),
      material,
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
