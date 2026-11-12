import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import { changedKeys, parseFrontMatter } from "./frontMatter.ts";
import { deletedQuotes, readableFiles } from "./quoteAccess.ts";

const orgId = KinOrgId.make("fixture-org");
const gone = "kin:chat:gone-chat:message:gone-msg";
const words = "invented words from a deleted message";
const fields = [
  ["id", '"clm-001"'],
  ["kind", "claim"],
  ["title", '"Invented title"'],
  ["status", "open"],
  ["due", "null"],
  ["recorded_at", '"2026-11-01T00:00:00.000Z"'],
  ["valid_from", '"2026-11-01T00:00:00.000Z"'],
  ["invalid_at", "null"],
  ["superseded_by", "null"],
  ["review_by", '"2026-12-01"'],
  ["source", `"${gone}"`],
  ["said_by", "owner"],
  ["trust", "owner"],
  ["links", '["issue #12"]'],
] as const;
const item = (front: string, body = "Invented body.\n") => `---\n${front}\n---\n${body}`;
const block = (indent: string, quoteKey: string) =>
  [...fields.map(([key, value]) => `${key}: ${value}`), `${quoteKey}: "${words}"`]
    .map((line) => `${indent}${line}`)
    .join("\n");

const quoted = [
  { name: "an indented mapping", text: item(block("  ", "quote")) },
  {
    name: "a flow-style mapping",
    text: item(
      `{ ${[...fields.map(([key, value]) => `${key}: ${value}`), `quote: "${words}"`].join(", ")} }`,
    ),
  },
  { name: "a quoted key", text: item(block("", '"quote"')) },
  { name: "an escaped key", text: item(block("", '"\\x71uote"')) },
];
const unquoted = item(
  fields.map(([key, value]) => `${key}: ${value}`).join("\n"),
  "Invented body that says the word quote.\n",
);

const layer = Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect.each(quoted)("strips a quote written as $name, leaving every other field", ({ text }) =>
  Effect.gen(function* () {
    const before = yield* parseFrontMatter(orgId, "claims/item.md", text);
    assert.strictEqual(before.frontMatter.quote, words);
    const swept = yield* deletedQuotes(orgId, new Map([["claims/item.md", text]]));
    const shown = yield* readableFiles(orgId, "owner", [{ path: "claims/item.md", text }]);
    for (const stripped of [swept.get("claims/item.md"), shown.get("claims/item.md")]) {
      assert.isDefined(stripped);
      assert.notInclude(stripped!, words);
      const after = yield* parseFrontMatter(orgId, "claims/item.md", stripped!);
      assert.deepStrictEqual(changedKeys(before.frontMatter, after.frontMatter), ["quote"]);
      assert.strictEqual(after.body, before.body);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("leaves an item without a quote alone, whatever its body says", () =>
  Effect.gen(function* () {
    const files = new Map([["claims/item.md", unquoted]]);
    assert.strictEqual((yield* deletedQuotes(orgId, files)).size, 0);
    assert.strictEqual(
      (yield* readableFiles(orgId, "owner", [{ path: "claims/item.md", text: unquoted }])).size,
      0,
    );
  }).pipe(Effect.provide(layer)),
);
