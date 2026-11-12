// @effect-diagnostics nodeBuiltinImport:off -- node:fs reads sources for the authorise guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  KinChatId,
  KinOrgId,
  KinPersonId,
  MemoryItemHead,
  type MemoryItemKind,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import {
  NEVER_SHARED_FIELDS,
  SHARED_HEAD_FIELDS,
  SHARING_KINDS,
  SharedItem,
  authorise,
  classify,
  fingerprint,
  hold,
  looksLikeSecret,
  mustBeSensitive,
  reaches,
  reaching,
  shareable,
  storedLabels,
  suggest,
  visibility,
} from "./sensitivity.ts";

const withTeamMemory = (env: Record<string, string>) =>
  Layer.merge(
    Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory),
    ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
  );
const layer = withTeamMemory({ KIN_TEAM_MEMORY: "on" });
const orgId = KinOrgId.make("fixture-org");
const item = (id: string, body: string, sensitive?: boolean) => ({
  head: {
    id,
    kind: "claim" as MemoryItemKind,
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
    // Review of 17822434f4: a grant an earlier build's chat stored is not one this build honours.
    const labelled = item("labelled", "Invented chat grant.\n", false);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, shared_content, shared_how, shared_at)
      VALUES (${orgId}, 'labelled', ${fingerprint(labelled)}, 'owner_label', 1)`;
    const labels = yield* storedLabels(orgId);
    assert.isFalse(reaches("shared", labelled, labels));
    assert.strictEqual(visibility(labelled, labels), "only_owner");
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
    // Every part of what a shared turn is given counts as its words, its kind and who said it too.
    assert.isFalse(team({ ...shared, head: { ...shared.head, kind: "decision" } }));
    const said = item("said", "Invented remark.\n", false);
    const from = {
      person: KinPersonId.make("fixture-teammate"),
      chat: KinChatId.make("fixture-chat"),
      name: "Teammate",
      chat_name: "Invented room",
    };
    yield* authorise(
      orgId,
      "said",
      fingerprint({ ...said, head: { ...said.head, shared_from: from } }),
      "teammate",
    );
    const saidLabels = yield* storedLabels(orgId);
    assert.isTrue(
      reaches("shared", { ...said, head: { ...said.head, shared_from: from } }, saidLabels),
    );
    assert.isFalse(
      reaches(
        "shared",
        { ...said, head: { ...said.head, shared_from: { ...from, name: "Invented other" } } },
        saidLabels,
      ),
    );
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

it.effect.each([
  {},
  { KIN_TEAM_MEMORY: "" },
  { KIN_TEAM_MEMORY: "true" },
  { KIN_TEAM_MEMORY: "ON" },
  { KIN_TEAM_MEMORY: " on " },
  { KIN_TEAM_MEMORY: "on\n" },
])("team memory is off unless the host sets KIN_TEAM_MEMORY=on: %j", (env) =>
  Effect.gen(function* () {
    yield* org;
    const shared = item("shared", "Invented status.\n", false);
    yield* authorise(orgId, "shared", fingerprint(shared), "owner_setting");
    const labels = yield* storedLabels(orgId);
    assert.isFalse(reaches("shared", shared, labels));
    assert.deepStrictEqual(yield* reaching(orgId, "shared", [shared]), []);
    // The owner's turns and Memory page are as before, so he can prepare what the team may know.
    assert.isTrue(reaches("owner_only", shared, labels));
    assert.strictEqual(visibility(shared, labels), "team");
  }).pipe(Effect.provide(withTeamMemory(env))),
);

// Review of 9de4e8d197: a dream's private words in a field the fingerprint skipped reached a
// shared memory_read. Every head field is either given to shared turns or never is.
it("a shared turn is given a fixed projection, and every head field is accounted for", () => {
  const listed = [...SHARED_HEAD_FIELDS, ...NEVER_SHARED_FIELDS];
  assert.sameMembers(Object.keys(MemoryItemHead.fields), listed);
  assert.strictEqual(new Set(listed).size, listed.length);
  const head = {
    ...item("full", "Invented body.\n", false).head,
    what: "Invented what",
    links: ["Invented link"],
    owner: "Invented private owner note",
    source: "kin:chat:private-chat:message:private-message",
    quote: "Invented private words from the owner's chat",
    path: "claims/full.md",
    shared_from: {
      person: KinPersonId.make("fixture-teammate"),
      chat: KinChatId.make("fixture-chat"),
      name: "Teammate",
      chat_name: "Invented room",
    },
  };
  const projected = shareable({ head, body: "Invented body.\n" });
  assert.sameMembers(Object.keys(projected), Object.keys(SharedItem.fields));
  assert.deepStrictEqual(projected.from, { name: "Teammate", chat_name: "Invented room" });
  for (const hidden of ["private", "claims/full.md", "fixture-teammate", "fixture-chat"])
    assert.notInclude(JSON.stringify(projected), hidden);
  // What it is not given is not what an authorisation covers.
  const reworded = { ...head, owner: "Invented other" };
  assert.strictEqual(
    fingerprint({ head, body: "Invented body.\n" }),
    fingerprint({ head: reworded, body: "Invented body.\n" }),
  );
});

it.effect("a suggestion is of the latest words, and an owner's word ends it", () =>
  Effect.gen(function* () {
    yield* org;
    const first = item("first", "Invented one.\n", false);
    const second = item("second", "Invented two.\n", false);
    yield* suggest(orgId, "first", fingerprint(first));
    yield* suggest(orgId, "first", fingerprint(first));
    yield* suggest(orgId, "second", fingerprint(second));
    const before = yield* storedLabels(orgId);
    assert.strictEqual(before.suggested.get("first"), fingerprint(first));
    assert.strictEqual(before.suggested.get("second"), fingerprint(second));
    yield* authorise(orgId, "first", fingerprint(first), "owner_confirmed");
    yield* authorise(orgId, "second", fingerprint(second), "owner_confirmed");
    const reworded = fingerprint({ ...first, body: "Invented reworded.\n" });
    yield* suggest(orgId, "first", reworded);
    const after = yield* storedLabels(orgId);
    assert.deepStrictEqual([...after.suggested], [["first", reworded]]);
    // What the team already knows needs no suggestion.
    yield* suggest(orgId, "second", fingerprint(second));
    assert.isFalse((yield* storedLabels(orgId)).suggested.has("second"));
  }).pipe(Effect.provide(layer)),
);

// Review of 69b673e063: a grant of a kind no longer honoured still kept the owner from being asked.
it.effect("a grant this build doesn't honour never stands in for asking the owner", () =>
  Effect.gen(function* () {
    yield* org;
    const sql = yield* SqlClient.SqlClient;
    const legacy = item("legacy", "Invented legacy grant.\n", false);
    const unkinded = item("unkinded", "Invented grant of no kind.\n", false);
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, shared_content, shared_how, shared_at)
      VALUES (${orgId}, 'legacy', ${fingerprint(legacy)}, 'owner_label', 1),
        (${orgId}, 'unkinded', ${fingerprint(unkinded)}, NULL, 1)`;
    yield* suggest(orgId, "legacy", fingerprint(legacy));
    yield* suggest(orgId, "unkinded", fingerprint(unkinded));
    const labels = yield* storedLabels(orgId);
    assert.strictEqual(visibility(legacy, labels), "suggested");
    assert.strictEqual(visibility(unkinded, labels), "suggested");
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

// Review of 8c8ee76d04: chat could let the team know words the owner never saw.
it("only the owner's own write, the Memory screen and a teammate's words let the team know", () => {
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const sites = (NodeFS.readdirSync(root, { recursive: true }) as Array<string>)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .flatMap((file) =>
      [
        ...NodeFS.readFileSync(NodePath.join(root, file), "utf8").matchAll(
          /\bauthorise\(([^;]*?)\)\.pipe/g,
        ),
      ].map((call) => [
        file.split(NodePath.sep).join("/"),
        call[1]!
          .replaceAll(/\s+/g, " ")
          .replace(/,?\s*$/, "")
          .split(", ")
          .at(-1),
      ]),
    )
    .toSorted();
  assert.deepStrictEqual(sites, [
    ["kin/lead/LeadMemory.ts", 'owner !== undefined ? "owner_message" : "teammate"'],
    ["kin/memory/MemoryChanges.ts", '"owner_confirmed"'],
    ["kin/memory/MemoryChanges.ts", '"owner_setting"'],
  ]);
  // Exactly the kinds those calls store are honoured; a new one is a change to this list.
  assert.sameMembers(
    [...SHARING_KINDS],
    sites.flatMap(([, how]) => how!.match(/"\w+"/g)!.map((kind) => JSON.parse(kind) as string)),
  );
});
