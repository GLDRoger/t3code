// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { setProfile } from "../work/companyProfile.ts";
import { dayIn, financialYearOf } from "../work/money.ts";
import { ownerWriter } from "../work/ownerWork.ts";
import { presetDefinition } from "../work/registers.ts";
import { issue, unvoidEntry, voidEntry } from "./numbering.ts";

// Invented orgs and invoices only.
const ownerId = KinPersonId.make("owner");
const START = Date.parse("2026-11-12T06:00:00.000Z");
const DAY = 86_400_000;
const ZONE = "Asia/Kolkata";
const ENTRIES = 5;

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const step = Arbitrary.all({
  op: Arbitrary.schema(Schema.Literals(["issue", "void", "unvoid", "later"])),
  entry: int(0, ENTRIES - 1),
  /** Days the clock moves for "later": enough to cross 31 March now and then. */
  days: int(0, 160),
});
const steps = Arbitrary.array(step, { minLength: 1, maxLength: 24 });

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId: KinOrgId.make("org-0"), personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const testLayer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-numbering-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A fresh org per run, with an invoices list and five draft invoices of ₹1,000. */
const freshOrg = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_orgs`;
  const orgId = KinOrgId.make(`org-${count?.n ?? 0}`);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-11')`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, ${ZONE}, '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${`${orgId}-owner`}, ${orgId}, 'owner', 'Owner', '2026-11-11', 'owner')`;
  yield* setProfile(
    orgId,
    { _tag: "person", personId: `${orgId}-owner` },
    { country: "IN" },
    undefined,
  );
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
      created_at, definition_json)
    VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
  for (let n = 1; n <= ENTRIES; n += 1)
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at, state, amount_minor,
        currency, sensitive)
      VALUES (${orgId}, ${`${orgId}-i${n}`}, 'invoices', ${`INV-${n}`}, ${`Invented retainer ${n}`},
        'person', ${`${orgId}-owner`}, 'system', ${`i${n}`}, ${START}, ${START}, 'open', 100000,
        'INR', 1)`;
  return orgId;
});

layer(testLayer)("issued numbers", (it) => {
  it.effect.prop(
    "numbers are unique, run 1, 2, 3… in each financial year in the order issued, and stay with their entry",
    [steps],
    ([run]) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(START);
        const orgId = yield* freshOrg;
        const writer = ownerWriter({
          _tag: "person",
          orgId,
          personId: KinPersonId.make(`${orgId}-owner`),
        });
        const given = new Map<string, string>();
        const voided = new Set<string>();
        for (const { op, entry, days } of run) {
          const key = `INV-${entry + 1}`;
          if (op === "later") {
            yield* TestClock.adjust(days * DAY);
            continue;
          }
          const act = op === "issue" ? issue : op === "void" ? voidEntry : unvoidEntry;
          const done = yield* Effect.result(act(orgId, writer, key));
          if (done._tag === "Failure") {
            // Only a void entry is refused a number.
            assert.isTrue(op === "issue" && voided.has(key) && !given.has(key), `${op} ${key}`);
            continue;
          }
          const had = given.get(key);
          if (had !== undefined) assert.strictEqual(done.success.number, had, `${op} ${key} kept`);
          else if (done.success.number !== null) given.set(key, done.success.number);
          if (op === "void") voided.add(key);
          if (op === "unvoid") voided.delete(key);
        }
        const sql = yield* SqlClient.SqlClient;
        const issued = yield* sql<{
          number: string;
          series: string;
          seq: number;
          at: number;
          key: string;
          field: string | null;
        }>`SELECT n.number, n.series, n.seq, n.issued_at AS at, r.key,
            json_extract(r.fields_json, '$.number') AS field
          FROM kin_issued_numbers n JOIN kin_records r
            ON r.org_id = n.org_id AND r.record_id = n.record_id
          WHERE n.org_id = ${orgId} ORDER BY n.issued_at, n.seq`;
        assert.deepStrictEqual(
          new Map(issued.map((one) => [one.key, one.number])),
          given,
          "what each issue answered is what was kept",
        );
        assert.strictEqual(new Set(issued.map((one) => one.number)).size, issued.length);
        const bySeries = Map.groupBy(issued, (one) => one.series);
        for (const [series, rows] of bySeries) {
          assert.deepStrictEqual(
            rows.map((one) => one.seq),
            rows.map((_, index) => index + 1),
            series,
          );
          for (const one of rows) {
            assert.strictEqual(series, `INV|${financialYearOf(dayIn(one.at, ZONE)).slice(4)}`);
            assert.strictEqual(one.field, one.number, `${one.key} shows its number`);
          }
        }
      }),
  );
});
