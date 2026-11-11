import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import {
  authorise,
  classify,
  fingerprint,
  hold,
  looksLikeSecret,
  mustBeSensitive,
  reaches,
  storedLabels,
  suggest,
  visibility,
} from "./sensitivity.ts";

const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const orgId = KinOrgId.make("fixture-org");
const item = (id: string, body: string, sensitive?: boolean) => ({
  head: {
    id,
    title: `Invented ${id}`,
    links: [],
    ...(sensitive === undefined ? {} : { sensitive }),
  },
  body,
});
const org = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES (${orgId}, 'Fixture', '2026-11-08T00:00:00.000Z')`;
});

it.effect("only a stored authorisation of the exact words lets the team know an item", () =>
  Effect.gen(function* () {
    yield* org;
    const shared = item("shared", "Invented status.\n", false);
    yield* authorise(orgId, "shared", fingerprint(shared), "owner_setting");
    // A file that says "not sensitive", the nightly pass, or a lead's word: none is enough.
    yield* classify(
      orgId,
      new Map([["nightly", { sensitive: false, content: fingerprint(item("nightly", "x")) }]]),
    );
    yield* suggest(orgId, "hinted", fingerprint(item("hinted", "Invented hint.\n", false)));
    const labels = yield* storedLabels(orgId);
    const team = (candidate: ReturnType<typeof item>) => reaches("shared", candidate, labels);
    assert.isTrue(team(shared));
    assert.isTrue(reaches("owner_only", item("anything", "x"), labels));
    assert.isFalse(team(item("unlabelled", "x", false)));
    assert.isFalse(team(item("nightly", "x")));
    assert.isFalse(team(item("hinted", "Invented hint.\n", false)));
    // Reworded by anyone, it reads as the owner's alone until the owner says so again.
    assert.isFalse(team({ ...shared, body: "Invented status, reworded.\n" }));
    assert.isFalse(team({ ...shared, head: { ...shared.head, title: "Invented other title" } }));
    assert.isFalse(team({ ...shared, head: { ...shared.head, sensitive: true } }));
    assert.strictEqual(visibility(item("nightly", "x"), labels), "suggested");
    assert.strictEqual(visibility(item("hinted", "Invented hint.\n", false), labels), "suggested");
    // A suggestion is of particular words: other words aren't suggested.
    assert.strictEqual(
      visibility(item("hinted", "Invented other.\n", false), labels),
      "only_owner",
    );
    yield* hold(orgId, "shared");
    assert.isFalse(reaches("shared", shared, yield* storedLabels(orgId)));
  }).pipe(Effect.provide(layer)),
);

it.effect("each new suggestion comes at a later revision, and an owner's word ends it", () =>
  Effect.gen(function* () {
    yield* org;
    const first = item("first", "Invented one.\n", false);
    const second = item("second", "Invented two.\n", false);
    yield* suggest(orgId, "first", fingerprint(first));
    yield* suggest(orgId, "first", fingerprint(first));
    yield* suggest(orgId, "second", fingerprint(second));
    const before = yield* storedLabels(orgId);
    assert.strictEqual(before.suggested.get("first")?.rev, 1);
    assert.strictEqual(before.suggested.get("second")?.rev, 2);
    yield* authorise(orgId, "first", fingerprint(first), "owner_confirmed");
    yield* authorise(orgId, "second", fingerprint(second), "owner_confirmed");
    // All confirmed: the next one still comes after anything the owner was shown.
    yield* suggest(orgId, "first", fingerprint({ ...first, body: "Invented reworded.\n" }));
    const after = yield* storedLabels(orgId);
    assert.deepStrictEqual([...after.suggested.keys()], ["first"]);
    assert.strictEqual(after.suggested.get("first")?.rev, 3);
    // What the team already knows needs no suggestion.
    yield* suggest(orgId, "second", fingerprint(second));
    assert.isFalse((yield* storedLabels(orgId)).suggested.has("second"));
  }).pipe(Effect.provide(layer)),
);

it.each([
  ["Client pays fifty thousand dollars", true],
  ["Client rate: CAD 500", true],
  ["API value: sk - abc def ghi", true],
  ["Invented retainer of Rs500 a month", true],
  ["Invented fee is ₹ 40,000", true],
  ["Invented deal worth two crore", true],
  ["Invented budget of USD fifty thousand", true],
  ["Invented key AKIA IOSF ODNN 7EXA MPLE", true],
  // Ordinary company knowledge stays as it is.
  ["Invented launch is on track for Friday", false],
  ["Ask the desk team about the risk-free rollout", false],
  ["Invented sprint has twenty tickets", false],
] as const)("the backstop reads %s as sensitive: %s", (text, sensitive) => {
  assert.strictEqual(mustBeSensitive(text), sensitive);
  assert.isFalse(looksLikeSecret(text));
});
