// @effect-diagnostics nodeBuiltinImport:off -- the authority test inspects source imports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import * as BankSenders from "./bankSenders.ts";

const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const address = "notifications@harborbank.example";
const org = KinOrgId.make("tidewater");
const otherOrg = KinOrgId.make("juniper");
const owner = KinPersonId.make("rhea");
const coOwner = KinPersonId.make("meera");
const member = KinPersonId.make("zoya");
const candidate = {
  address: address.toUpperCase(),
  bankName: "Harbor Bank",
  accounts: ["4821"],
  matchedFrom: "company_details",
  seenAt: 2,
} as const;

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Tidewater Freight', '2026-11-01'),
    (${otherOrg}, 'Juniper Cold Chain', '2026-11-01')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, display_name, handle, created_at, access)
    VALUES (${owner}, ${org}, 'Rhea', 'rhea', '2026-11-01', 'owner'),
    (${coOwner}, ${org}, 'Meera', 'meera', '2026-11-01', 'co_owner'),
    (${member}, ${org}, 'Zoya', 'zoya', '2026-11-01', 'member'),
    ('arjun', ${otherOrg}, 'Arjun', 'arjun', '2026-11-01', 'owner')`;
  return sql;
});
const manual = { address, bankName: "Harbor Bank", accounts: ["4821"] };

it.effect("records candidate sightings, then approves only a seen ending", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    assert.isTrue(yield* BankSenders.noteCandidate(org, candidate));
    assert.isTrue(
      yield* BankSenders.noteCandidate(org, { ...candidate, accounts: ["5530"], seenAt: 1 }),
    );
    assert.deepStrictEqual(yield* BankSenders.sendersOf(org), new Map());
    assert.deepStrictEqual(
      yield* sql`SELECT address, state, first_seen_at, last_seen_at, seen_count, seen_accounts_json
        FROM kin_bank_senders`,
      [
        {
          address,
          state: "candidate",
          first_seen_at: 1,
          last_seen_at: 2,
          seen_count: 2,
          seen_accounts_json: '["4821","5530"]',
        },
      ],
    );
    assert.include(yield* Effect.flip(BankSenders.approve(org, owner, address, ["9999"])), {
      reason: "invalid_state",
    });
    yield* BankSenders.approve(org, owner, address, ["4821", "4821"]);
    assert.deepStrictEqual(
      [...(yield* BankSenders.sendersOf(org))].map(([key, row]) => ({
        key,
        bankName: row.bankName,
        accounts: row.accounts,
      })),
      [{ key: address, bankName: "Harbor Bank", accounts: ["4821"] }],
    );
    assert.deepStrictEqual(yield* BankSenders.sendersOf(otherOrg), new Map());
    assert.isFalse(yield* BankSenders.noteCandidate(org, candidate));
  }).pipe(Effect.provide(layer)),
);

it.effect("decline suppresses future sightings; Settings can undo it, remove and re-add", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* BankSenders.noteCandidate(org, candidate);
    yield* BankSenders.decline(org, owner, address);
    assert.isFalse(yield* BankSenders.noteCandidate(org, candidate));
    assert.include(yield* Effect.flip(BankSenders.approve(org, owner, address, ["4821"])), {
      reason: "conflict",
    });
    yield* BankSenders.add(org, coOwner, manual);
    const before = yield* BankSenders.sendersOf(org);
    assert.isTrue(before.has(address));
    yield* BankSenders.remove(org, coOwner, address.toUpperCase());
    assert.deepStrictEqual(yield* BankSenders.sendersOf(org), new Map());
    assert.deepStrictEqual(
      yield* sql`SELECT state, decided_by_person_id, seen_count
      FROM kin_bank_senders`,
      [{ state: "removed", decided_by_person_id: coOwner, seen_count: 1 }],
    );
    assert.isFalse(yield* BankSenders.noteCandidate(org, candidate));
    yield* BankSenders.add(org, coOwner, manual);
    assert.deepStrictEqual(yield* BankSenders.sendersOf(org), before);
  }).pipe(Effect.provide(layer)),
);

it.effect("only current owner-level people can change an org's senders", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* BankSenders.noteCandidate(org, candidate);
    for (const actor of [member, KinPersonId.make("arjun")]) {
      for (const change of [
        BankSenders.approve(org, actor, address, ["4821"]),
        BankSenders.decline(org, actor, address),
        BankSenders.remove(org, actor, address),
        BankSenders.add(org, actor, manual),
      ])
        assert.include(yield* Effect.flip(change), { reason: "not_allowed" });
    }
    yield* sql`UPDATE kin_people SET removed_at = '2026-11-03' WHERE person_id = ${coOwner}`;
    assert.include(yield* Effect.flip(BankSenders.add(org, coOwner, manual)), {
      reason: "not_allowed",
    });
    assert.deepStrictEqual(yield* BankSenders.sendersOf(org), new Map());
  }).pipe(Effect.provide(layer)),
);

it("MCP handlers do not import bank sender decisions", () => {
  const root = NodePath.resolve(import.meta.dirname, "../../..");
  const files = ["mcp", "kin/mcp", "kin/lead/mcp"].flatMap((path) =>
    (NodeFS.readdirSync(NodePath.join(root, path), { recursive: true }) as Array<string>)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .map((file) => NodePath.join(root, path, file)),
  );
  assert.deepStrictEqual(
    files.filter((file) =>
      /(?:from|import\s*\()\s*["'][^"']*\/bankSenders\.ts["']/.test(
        NodeFS.readFileSync(file, "utf8"),
      ),
    ),
    [],
  );
});
