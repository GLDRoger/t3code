import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { reversal } from "../lead/changeRows.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { keepAllDayDays } from "./allDayZone.ts";
import * as Deals from "./deals.ts";
import * as KinRecords from "./KinRecords.ts";
import { dayIn } from "./money.ts";
import { endOfDay, parseChanges } from "./recordRows.ts";
import { presetDefinition } from "./registers.ts";

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("rhea");
const owner = { _tag: "person", orgId, personId: ownerId } as const;
const layer = Layer.mergeAll(
  KinRecords.layer,
  Layer.mock(KinIdentity)({
    owner,
    isAgentThread: () => false,
    isLeadThread: () => false,
  }),
).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const writer = {
  actor: { _tag: "person", personId: ownerId },
  via: "owner",
  askedBy: ownerId,
} as const;
const me = { _tag: "person", personId: ownerId } as const;
const timed = Date.parse("2026-11-27T09:30:00.000Z");
// Each list's own all-day day, some on a day the clocks change in a zone it moves through.
const DAYS = [
  ["work", "due", "2026-11-27"],
  ["invoices", "due", "2026-11-01"],
  ["invoices", "date", "2026-03-08"],
  ["milestones", "due", "2026-12-31"],
  ["goals", "due", "2027-03-31"],
  ["projects", "due", "2026-12-15"],
  ["receipts", "date", "2026-11-02"],
  ["expenses", "date", "2026-11-03"],
] as const;

// Play-test (Nov 2026): the owner's device stored its own zone as the company's, and every
// all-day day read one later for everyone; Changes and Undo read the old zone's days too.
it.effect(
  "a company zone move keeps every all-day day an org stores, its history, undo and told news, and no time moves",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      let zone = "America/Bogota";
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', '2026-11-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief,
          evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check,
          quiet_hours_json)
        VALUES (${orgId}, ${zone}, '08:30', '18:30', '03:00', 0, 1, '09:00', '[]')`;
      for (const [list, prefix] of [
        ["invoices", "INV"],
        ["receipts", "RCT"],
        ["expenses", "EXP"],
      ] as const)
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
            created_at, definition_json)
          VALUES (${orgId}, ${list}, ${list}, ${prefix}, 0, 0,
            ${JSON.stringify(presetDefinition(list, "INR"))})`;
      const keys: Array<string> = [];
      for (const [index, [list, field, day]] of DAYS.entries()) {
        const at = endOfDay(day, zone);
        const { row } = yield* records.create(orgId, writer, {
          list,
          originKey: `day:${index}`,
          title: `Invented ${list} ${field}`,
          owner: me,
          ...(field === "due" ? { dueAt: at, dueAllDay: true } : { dateAt: at, dateAllDay: true }),
        });
        keys.push(row.key);
      }
      const { row: client } = yield* records.create(orgId, writer, {
        list: "clients",
        originKey: "client",
        title: "Invented Corran Builders",
        owner: me,
      });
      const deal = yield* Deals.create([owner], {
        orgId,
        party: client.key,
        title: "Invented second site",
        expectedOn: "2026-10-25",
        clientRequestId: "deal",
      });
      keys.push(deal.deal.key);
      const task = keys[0]!;
      // "due 22 Nov → 27 Nov", put back by Undo, and a time on the same entry list.
      yield* records.update(orgId, writer, task, { dueAt: endOfDay("2026-11-22", zone) });
      yield* records.update(orgId, writer, task, { dueAt: endOfDay("2026-11-27", zone) });
      const { row: meeting } = yield* records.create(orgId, writer, {
        originKey: "timed",
        title: "Invented call with Meera",
        owner: me,
        dueAt: timed,
        dateAt: timed,
      });
      yield* records.update(orgId, writer, meeting.key, { dueAt: timed + 60_000 });
      const taskRow = (yield* records.get(orgId, task))!;
      const expense = (yield* records.get(orgId, keys.at(-2)!))!;
      const receipt = (yield* records.get(orgId, keys.at(-3)!))!;
      // A statement's undo: the expense's date before, and both entries as Kin left them.
      yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
          chat_id, agent_id, wakeup_id, status, created_at)
        VALUES (${orgId}, 'st', 'file', 'invented.pdf', 'chat', 'finance', 'wake', 'read', 0)`;
      yield* sql`INSERT INTO kin_bank_statement_entries (org_id, statement_id, seq, row_index,
          bank_record_id, action, target_record_id, prior_json, after_json)
        VALUES (${orgId}, 'st', 1, 0, ${receipt.recordId}, 'expense_paid', ${expense.recordId},
          ${JSON.stringify({ bank: { state: "open", category: null }, expense: { state: "open", dateAt: endOfDay("2026-10-30", zone), dateAllDay: true, paidWith: null } })},
          ${JSON.stringify({ bank: { state: "done", dateAt: receipt.dateAt, amountMinor: null, paidWith: null, notes: "", category: null }, target: { state: "done", dateAt: expense.dateAt, amountMinor: null, paidWith: null, notes: "", category: null } })})`;
      // News told about the due keeps its key, so nobody hears it twice; a time's stays as it is.
      const late = (key: string, at: number) => `task_late:${key}:due=${at}`;
      for (const key of [late(task, taskRow.dueAt!), late(meeting.key, timed + 60_000)]) {
        yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, first_seen_at, last_seen_at)
          VALUES (${orgId}, ${key}, 'work', 0, 0)`;
        yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
          VALUES (${orgId}, ${ownerId}, ${key}, 'event', '|open|', 0)`;
      }
      yield* sql`INSERT INTO kin_pulse_nudges (org_id, person_id, day, agent_id, chat_id,
          fact_key, sent_at) VALUES (${orgId}, ${ownerId}, '2026-11-28', 'lead', 'chat',
          ${late(task, taskRow.dueAt!)}, 0)`;

      const stored = Effect.gen(function* () {
        return {
          records: yield* sql`SELECT key, due_at, date_at FROM kin_records
            WHERE org_id = ${orgId} ORDER BY key`,
          changes: yield* sql`SELECT seq, fields_json FROM kin_record_changes
            WHERE org_id = ${orgId} ORDER BY seq`,
          statement: yield* sql`SELECT prior_json, after_json FROM kin_bank_statement_entries
            WHERE org_id = ${orgId} ORDER BY seq`,
          facts: yield* sql`SELECT fact_key FROM kin_pulse_facts WHERE org_id = ${orgId}
            ORDER BY fact_key`,
        };
      });
      const read = (zone: string) =>
        Effect.gen(function* () {
          const day = (at: number | null) => (at === null ? null : dayIn(at, zone));
          const rows = yield* Effect.forEach(keys, (key) => records.get(orgId, key));
          const task = rows[0]!;
          const [, moved] = (yield* sql<{ kind: string; fieldsJson: string }>`SELECT kind,
              fields_json AS "fieldsJson" FROM kin_record_changes
            WHERE org_id = ${orgId} AND record_id = ${task.recordId} ORDER BY seq`).filter(
            (one) => one.kind === "updated",
          );
          const line = parseChanges(moved!.fieldsJson).find((one) => one.field === "due")!;
          const undo = reversal({
            kind: "updated",
            registerId: "work",
            state: "open",
            fields: parseChanges(moved!.fieldsJson),
          });
          const [entry] = yield* sql<{ prior: number; bank: number; target: number }>`SELECT
              json_extract(prior_json, '$.expense.dateAt') AS prior,
              json_extract(after_json, '$.bank.dateAt') AS bank,
              json_extract(after_json, '$.target.dateAt') AS target
            FROM kin_bank_statement_entries WHERE org_id = ${orgId}`;
          const current = (key: string, at: number) =>
            Effect.gen(function* () {
              const [facts] = yield* sql<{ n: number }>`SELECT
                  (SELECT COUNT(*) FROM kin_pulse_facts WHERE org_id = ${orgId} AND fact_key = ${late(key, at)})
                  + (SELECT COUNT(*) FROM kin_pulse_told WHERE org_id = ${orgId} AND fact_key = ${late(key, at)})
                  + (SELECT COUNT(*) FROM kin_pulse_nudges WHERE org_id = ${orgId} AND fact_key = ${late(key, at)})
                  AS n`;
              return facts!.n;
            });
          const timedRow = (yield* records.get(orgId, meeting.key))!;
          const page = yield* Deals.page([owner], {
            orgId,
            key: deal.deal.key,
          });
          return {
            days: rows.map((row) => [row!.registerId, day(row!.dueAt), day(row!.dateAt)]),
            expected: day(Date.parse(page.deal.expectedAt!)),
            history: [day(Date.parse(line.from!)), day(Date.parse(line.to!))],
            undo: day(undo?.dueAt ?? null),
            statement: [
              day(entry!.prior),
              entry!.bank === rows.at(-3)!.dateAt ? "as left" : "changed",
              entry!.target === rows.at(-2)!.dateAt ? "as left" : "changed",
            ],
            told: [
              yield* current(task.key, task.dueAt!),
              yield* current(meeting.key, timed + 60_000),
            ],
            timed: [timedRow.dueAt, timedRow.dateAt],
          };
        });
      const expected = {
        days: [
          ...DAYS.map(([list, field, day]) =>
            field === "due" ? [list, day, null] : [list, null, day],
          ),
          ["deals", "2026-10-25", null],
        ],
        expected: "2026-10-25",
        history: ["2026-11-22", "2026-11-27"],
        undo: "2026-11-22",
        statement: ["2026-10-30", "as left", "as left"],
        told: [3, 2],
        timed: [timed + 60_000, timed],
      };
      assert.deepStrictEqual(yield* read(zone), expected);
      const start = yield* stored;
      // East across midnight by a half-hour zone, west, a quarter-hour one, across the clocks
      // changing, two zones a whole day apart, then home again.
      for (const next of [
        "Asia/Kolkata",
        "America/Los_Angeles",
        "Asia/Kathmandu",
        "Europe/London",
        "Pacific/Kiritimati",
        "Pacific/Honolulu",
        "America/Bogota",
      ]) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE kin_trigger_settings SET time_zone = ${next} WHERE org_id = ${orgId}`;
            yield* keepAllDayDays(orgId, zone, next);
          }),
        );
        zone = next;
        assert.deepStrictEqual(yield* read(zone), expected, zone);
      }
      // There and back leaves every instant, line and key exactly where it started.
      assert.deepStrictEqual(yield* stored, start);
    }).pipe(Effect.provide(layer)),
);
