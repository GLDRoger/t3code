// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Numbers from "../gendocs/numbering.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { removeChunk } from "./importUndo.ts";
import * as KinImport from "./KinImport.ts";
import * as KinRecords from "./KinRecords.ts";
import { searchIndexed } from "./searchIndex.ts";

// Invented org, people and amounts only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const owner = { actor: { _tag: "person" as const, personId: ownerId }, via: "owner" as const };
const me = { _tag: "person" as const, personId: ownerId };

const layer = KinImport.layer.pipe(
  Layer.provideMerge(KinRecords.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-import-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at})`;
});

const header = {
  format: "kin-import",
  version: 1,
  batch: "oldbooks",
  source: "Old Books",
  asOf: "2026-07-31",
  lists: [
    {
      list: "invoices",
      template: "invoices",
      numbering: { prefix: "OBK", series: "financial_year", width: 3 },
    },
    {
      list: "expenses",
      template: "expenses",
      fields: [{ label: "Vendor GSTIN", type: "text" }],
      categories: ["subscriptions"],
    },
  ],
};
const rows = [
  { client: { source: "c1", name: "Invented Acme", terms: "30 days", createdAt: "2026-04-02" } },
  { project: { source: "p1", name: "Website", client: "c1", createdAt: "2026-04-03" } },
  {
    entry: {
      source: "t1",
      list: "work",
      title: "Send the welcome pack",
      state: "done",
      client: "c1",
      createdAt: "2026-04-05",
      closedAt: "2026-04-09",
    },
  },
  {
    entry: {
      source: "t2",
      list: "work",
      title: "Renew the domain",
      state: "open",
      due: "2026-07-01",
      project: "p1",
      createdAt: "2026-06-20",
    },
  },
  {
    entry: {
      source: "e1",
      list: "expenses",
      title: "Design tool seat",
      state: "done",
      date: "2026-05-14",
      amount: "1200.50",
      category: "software",
      fields: { vendor: "Invented Tools", vendorGstin: "29BBBBB1111B1Z5" },
    },
  },
  {
    entry: {
      source: "i1",
      list: "invoices",
      title: "April retainer",
      state: "waiting",
      client: "c1",
      date: "2026-04-30",
      due: "2026-05-30",
      amount: "61234",
      number: "OBK/2026-27/004",
      payments: [{ source: "pay1", amount: "61234", paidOn: "2026-05-20" }],
    },
  },
  {
    entry: {
      source: "i2",
      list: "invoices",
      title: "May retainer",
      state: "waiting",
      client: "c1",
      date: "2026-05-31",
      amount: "38765",
      number: "OBK/26-27/002",
    },
  },
];
const linesOf = (first: unknown, rest: ReadonlyArray<unknown>, extra: ReadonlyArray<string> = []) =>
  Stream.fromIterable([JSON.stringify(first), ...rest.map((one) => JSON.stringify(one)), ...extra]);
const books = () => linesOf(header, rows);

const countOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`;
    return row?.n ?? 0;
  });
const recordOf = (source: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      recordId: string;
      key: string;
      state: string;
      createdAt: number;
      closedAt: number | null;
      notes: string;
    }>`SELECT record_id AS "recordId", key, state, created_at AS "createdAt",
        closed_at AS "closedAt", notes
      FROM kin_records WHERE org_id = ${orgId} AND origin_key LIKE ${`import:oldbooks:%:${source}`}`;
    return row;
  });
/** What the organisation holds, to compare before an import and after its undo. */
const holdings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [money] = yield* sql<{ total: number | null; paid: number | null }>`SELECT
      (SELECT SUM(amount_minor) FROM kin_records) AS total,
      (SELECT SUM(amount_minor) FROM kin_record_payments) AS paid`;
  return {
    records: yield* countOf("kin_records"),
    // Kin's own Clients and Projects lists appear on first use and stay; defined ones count.
    lists: (yield* sql<{
      n: number;
    }>`SELECT COUNT(*) AS n FROM kin_registers WHERE built_in = 0`)[0]?.n,
    payments: yield* countOf("kin_record_payments"),
    changes: yield* countOf("kin_record_changes"),
    numbers: yield* countOf("kin_issued_numbers"),
    search: yield* countOf("kin_search_rows"),
    money,
  };
});
const quiet = Effect.gen(function* () {
  return [
    yield* countOf("kin_events"),
    yield* countOf("kin_wakeups"),
    yield* countOf("kin_messages"),
    yield* countOf("kin_widgets"),
  ];
});

describe("KinImport", () => {
  it.effect("applies exactly what it planned, quietly, keeping the old dates and numbers", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const plan = yield* imports.plan(orgId, ownerId, books());
      assert.strictEqual(yield* countOf("kin_records"), 0);
      assert.strictEqual(yield* countOf("kin_registers"), 0);
      assert.strictEqual(yield* countOf("kin_import_runs"), 0);
      const applied = yield* imports.apply(orgId, ownerId, books());
      assert.deepStrictEqual(applied.problems, []);
      assert.deepStrictEqual({ ...applied, applied: false }, plan);
      assert.deepStrictEqual(
        [applied.clients, applied.projects, applied.entries, applied.payments].map(
          (one) => one.create,
        ),
        [1, 1, 5, 1],
      );
      assert.deepStrictEqual(
        applied.lists.map((one) => [one.list, one.action]),
        [
          ["invoices", "create"],
          ["expenses", "create"],
        ],
      );
      assert.deepStrictEqual(applied.money, [
        {
          list: "expenses",
          entries: 1,
          total: { minor: 120050, currency: "INR" },
          paid: { minor: 0, currency: "INR" },
        },
        {
          list: "invoices",
          entries: 2,
          total: { minor: 9999900, currency: "INR" },
          paid: { minor: 6123400, currency: "INR" },
        },
      ]);
      assert.deepStrictEqual(applied.stale, [
        { list: "invoices", open: 1, oldest: "2026-05-31" },
        { list: "work", open: 1, oldest: "2026-06-20" },
      ]);

      // Its own dates, in the owner's zone; closed when the old system closed or was paid.
      const done = (yield* recordOf("t1"))!;
      assert.strictEqual(done.createdAt, Date.parse("2026-04-04T18:30:00.000Z"));
      assert.strictEqual(done.closedAt, Date.parse("2026-04-09T18:29:59.999Z"));
      assert.include((yield* recordOf("t2"))!.notes, "last kept up on 2026-07-31");
      assert.notInclude(done.notes, "last kept up");
      const paid = (yield* recordOf("i1"))!;
      assert.deepStrictEqual(
        [paid.state, paid.closedAt],
        ["done", Date.parse("2026-05-20T18:29:59.999Z")],
      );
      assert.strictEqual((yield* recordOf("i2"))!.state, "waiting");

      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT DISTINCT via FROM kin_record_changes ORDER BY via`, [
        { via: "import" },
      ]);
      // Nothing wakes, posts or asks, however late the imported entries are.
      assert.deepStrictEqual(yield* quiet, [0, 0, 0, 0]);

      // Kin's next invoice number follows the highest imported one in that year's series.
      const records = yield* KinRecords.KinRecords;
      const { row: draft } = yield* records.create(orgId, owner, {
        list: "invoices",
        originKey: "owner:draft",
        title: "June retainer",
        owner: me,
        state: "open",
        amount: { minor: 100, currency: "INR" },
      });
      assert.strictEqual((yield* Numbers.issue(orgId, owner, draft.key)).number, "OBK/26-27/005");

      const again = yield* imports.apply(orgId, ownerId, books());
      assert.deepStrictEqual(
        [again.clients, again.projects, again.entries, again.payments].map((one) => [
          one.create,
          one.unchanged,
        ]),
        [
          [0, 1],
          [0, 1],
          [0, 5],
          [0, 1],
        ],
      );
      assert.strictEqual(yield* countOf("kin_records"), 8);

      // The owner voids the imported payment; importing again leaves it voided, without a problem.
      const sql2 = yield* SqlClient.SqlClient;
      const [imported] = yield* sql2<{ key: string; paymentId: string }>`SELECT r.key,
          p.payment_id AS "paymentId" FROM kin_record_payments p
          JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id ORDER BY p.payment_id`;
      yield* records.voidPayment(orgId, owner, imported!.key, imported!.paymentId);
      const third = yield* imports.apply(orgId, ownerId, books());
      assert.deepStrictEqual([third.problems, third.payments.create], [[], 0]);
      assert.lengthOf(yield* sql2`SELECT 1 FROM kin_record_payments WHERE voided_at IS NULL`, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves an entry the owner changed after import alone, with its payments", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      yield* imports.apply(orgId, ownerId, books());
      const may = (yield* recordOf("i2"))!;
      yield* records.update(orgId, owner, may.key, { notes: "Agreed a discount by phone." });
      const paidLater = rows.map((one) =>
        "entry" in one && one.entry.source === "i2"
          ? {
              entry: {
                ...one.entry,
                payments: [{ source: "pay2", amount: "38765", paidOn: "2026-06-30" }],
              },
            }
          : one,
      );
      const report = yield* imports.apply(orgId, ownerId, linesOf(header, paidLater));
      assert.deepStrictEqual(report.changed, [{ source: "i2", key: may.key }]);
      assert.deepStrictEqual(
        [report.entries.changed, report.payments.changed, report.payments.unchanged],
        [1, 1, 1],
      );
      const kept = (yield* recordOf("i2"))!;
      assert.deepStrictEqual([kept.state, kept.notes], ["waiting", "Agreed a discount by phone."]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names every line it can't import and imports the rest", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const broken = [
        ...rows,
        { entry: { source: "t1", list: "work", title: "A second t1" } },
        { entry: { source: "x1", list: "work", title: "For a client never listed", client: "no" } },
        { entry: { source: "x2", list: "leave", title: "On a list nobody defined" } },
        { entry: { source: "x3", list: "expenses", title: "Lunch for ₹500", amount: "500" } },
        { entry: { source: "x4", list: "clients", title: "A client as an entry" } },
        {
          entry: {
            source: "x5",
            list: "work",
            title: "Pays twice",
            payments: [{ source: "pay1", amount: "1", paidOn: "2026-05-01" }],
          },
        },
      ];
      const report = yield* imports.apply(
        orgId,
        ownerId,
        linesOf(header, broken, ["{not json", ""]),
      );
      assert.deepStrictEqual(
        report.problems.map((one) => [one.line, one.kind, one.source]),
        [
          [9, "entry", "t1"],
          [10, "entry", "x1"],
          [11, "entry", "x2"],
          [12, "entry", "x3"],
          [13, "entry", "x4"],
          [14, "payment", "pay1"],
          [15, "file", null],
        ],
      );
      assert.deepStrictEqual([report.entries.create, report.entries.problems], [6, 5]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a file without a header, or past its limits, before writing anything", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const headless = yield* imports
        .apply(orgId, ownerId, Stream.fromIterable(rows.map((one) => JSON.stringify(one))))
        .pipe(Effect.flip);
      assert.include(headless.message, "isn't a kin-import header");
      const long = yield* imports
        .apply(orgId, ownerId, linesOf(header, [], ["x".repeat(1_000_001)]))
        .pipe(Effect.flip);
      assert.include(long.message, "Line 2 is longer");
      assert.strictEqual(yield* countOf("kin_registers"), 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("undo puts the organisation back as it was, quietly, and the file applies again", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      yield* records.create(orgId, owner, {
        list: "work",
        originKey: "owner:before",
        title: "Already here",
        owner: me,
      });
      const before = yield* holdings;
      yield* imports.apply(orgId, ownerId, books());
      const keysOf = Effect.forEach(["c1", "p1", "t1", "t2", "i1"], (one) =>
        recordOf(one).pipe(Effect.map((row) => row?.key)),
      );
      const keys = yield* keysOf;
      const plan = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: false,
        includeChanged: false,
      });
      assert.deepStrictEqual(plan.removes, { clients: 1, projects: 1, entries: 5, payments: 1 });
      assert.notDeepEqual(yield* holdings, before);
      const undone = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: true,
        includeChanged: false,
      });
      assert.deepStrictEqual({ ...undone, applied: false }, plan);
      assert.deepStrictEqual(
        undone.lists.map((one) => [one.list, one.action]),
        [
          ["invoices", "remove"],
          ["expenses", "remove"],
        ],
      );
      assert.deepStrictEqual(yield* holdings, before);
      assert.deepStrictEqual(yield* quiet, [0, 0, 0, 0]);

      const again = yield* imports.apply(orgId, ownerId, books());
      assert.deepStrictEqual([again.entries.create, again.payments.create], [5, 1]);
      // Nothing else took a key after the batch's, so the same rows get the same keys again.
      assert.deepStrictEqual(yield* keysOf, keys);
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT action FROM kin_import_runs WHERE batch = 'oldbooks' ORDER BY seq`,
        [{ action: "apply" }, { action: "undo" }, { action: "apply" }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a plain undo keeps what someone changed or uses, and numbering never goes back", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      yield* imports.apply(orgId, ownerId, linesOf(header, rows.slice(0, 5)));
      const acme = (yield* recordOf("c1"))!;
      const { row: mine } = yield* records.create(orgId, owner, {
        list: "work",
        originKey: "owner:call",
        title: "Call them about renewal",
        owner: me,
        partyId: acme.recordId,
      });
      yield* imports.apply(orgId, ownerId, books());
      const may = (yield* recordOf("i2"))!;
      yield* records.update(orgId, owner, may.key, { notes: "Agreed a discount by phone." });
      const { row: draft } = yield* records.create(orgId, owner, {
        list: "invoices",
        originKey: "owner:draft",
        title: "June retainer",
        owner: me,
        state: "open",
        amount: { minor: 100, currency: "INR" },
      });
      assert.strictEqual((yield* Numbers.issue(orgId, owner, draft.key)).number, "OBK/26-27/005");

      const plan = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: false,
        includeChanged: false,
      });
      assert.deepStrictEqual(plan.changed, [may.key]);
      const undone = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: true,
        includeChanged: false,
      });
      assert.deepStrictEqual(undone.changed, [may.key]);
      assert.deepStrictEqual(undone.kept, [
        { key: acme.key, reason: `${[may.key, mine.key].toSorted().join(", ")} use it` },
      ]);
      assert.deepStrictEqual(undone.removes, { clients: 0, projects: 1, entries: 4, payments: 1 });
      assert.deepStrictEqual(
        undone.lists.map((one) => [one.list, one.action, one.entries]),
        [
          ["invoices", "keep", 2],
          ["expenses", "remove", 0],
        ],
      );
      assert.deepStrictEqual(
        [(yield* recordOf("c1"))?.key, (yield* recordOf("i2"))?.notes, yield* recordOf("i1")],
        [acme.key, "Agreed a discount by phone.", undefined],
      );

      // The imported 004 is gone; the counter stays past it and past the 005 issued by hand.
      const { row: next } = yield* records.create(orgId, owner, {
        list: "invoices",
        originKey: "owner:next",
        title: "July retainer",
        owner: me,
        state: "open",
        amount: { minor: 100, currency: "INR" },
      });
      assert.strictEqual((yield* Numbers.issue(orgId, owner, next.key)).number, "OBK/26-27/006");

      const all = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: true,
        includeChanged: true,
      });
      assert.deepStrictEqual(all.kept, [{ key: acme.key, reason: `${mine.key} uses it` }]);
      assert.strictEqual(all.removes.entries, 1);
      assert.strictEqual(yield* recordOf("i2"), undefined);
      assert.strictEqual((yield* recordOf("c1"))?.key, acme.key);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("undo never takes a number Kin issued back, nor a payment Kin recorded", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      const invoiceRow = (source: string, title: string) => ({
        entry: { source, list: "invoices", title, state: "open", client: "c1", amount: "500" },
      });
      const onlyInvoices = { ...header, lists: [header.lists[0]] };
      // The batch makes the list; the owner issues one of its invoices: changed or not, it stays.
      yield* imports.apply(
        orgId,
        ownerId,
        linesOf(onlyInvoices, [rows[0], invoiceRow("i3", "June")]),
      );
      const june = (yield* recordOf("i3"))!;
      assert.strictEqual((yield* Numbers.issue(orgId, owner, june.key)).number, "OBK/26-27/001");
      const kept = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: true,
        includeChanged: true,
      });
      assert.deepStrictEqual(kept.kept, [
        { key: (yield* recordOf("c1"))!.key, reason: `${june.key} uses it` },
        { key: june.key, reason: "Kin issued it OBK/26-27/001, which stays in its series" },
      ]);
      assert.deepStrictEqual(
        kept.lists.map((one) => [one.list, one.action]),
        [["invoices", "keep"]],
      );
      assert.strictEqual((yield* recordOf("i3"))?.key, june.key);
      // Imported again, the list carries on the same series.
      yield* imports.apply(
        orgId,
        ownerId,
        linesOf(onlyInvoices, [rows[0], invoiceRow("i4", "May")]),
      );
      const { row: next } = yield* records.create(orgId, owner, {
        list: "invoices",
        originKey: "owner:july",
        title: "July retainer",
        owner: me,
        state: "open",
        amount: { minor: 100, currency: "INR" },
      });
      assert.strictEqual((yield* Numbers.issue(orgId, owner, next.key)).number, "OBK/26-27/002");

      // An entry with a payment Kin recorded stays with it, changed or not, and so does its client.
      const may = (yield* recordOf("i4"))!;
      yield* records.pay(orgId, owner, may.key, {
        amount: { minor: 10_000, currency: "INR" },
        paidOn: "2026-11-01",
        originKey: "owner:may-part",
      });
      const undone = yield* imports.undo(orgId, ownerId, "oldbooks", {
        apply: true,
        includeChanged: true,
      });
      const acme = (yield* recordOf("c1"))!;
      assert.deepStrictEqual(
        undone.kept,
        [
          { key: acme.key, reason: [june.key, may.key].toSorted().join(", ") + " use it" },
          { key: june.key, reason: "Kin issued it OBK/26-27/001, which stays in its series" },
          { key: may.key, reason: "a payment recorded in Kin is on it" },
        ].toSorted((a, b) => (a.key < b.key ? -1 : 1)),
      );
      assert.deepStrictEqual(undone.removes, { clients: 0, projects: 0, entries: 0, payments: 0 });
      assert.deepStrictEqual(
        yield* sql`SELECT origin_key AS "originKey" FROM kin_record_payments ORDER BY origin_key`,
        [{ originKey: "owner:may-part" }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an undo keeps a row paid while it runs, deciding inside each chunk", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      yield* imports.apply(orgId, ownerId, books());
      const may = (yield* recordOf("i2"))!;
      const welcome = (yield* recordOf("t1"))!;
      // Planned for removal, then paid in Kin before its chunk is deleted.
      const removing = new Set([may.recordId, welcome.recordId]);
      yield* records.pay(orgId, owner, may.key, {
        amount: { minor: 100, currency: "INR" },
        paidOn: "2026-11-01",
        originKey: "owner:during-undo",
      });
      const kept = yield* removeChunk(
        orgId,
        "oldbooks",
        [may.recordId, welcome.recordId],
        removing,
        {
          includeChanged: true,
          indexed: yield* searchIndexed(),
        },
      );
      assert.deepStrictEqual(kept, [may.recordId]);
      assert.deepStrictEqual([...removing], [welcome.recordId]);
      assert.deepStrictEqual(
        [
          (yield* recordOf("i2"))?.key,
          yield* recordOf("t1"),
          yield* countOf("kin_record_payments"),
        ],
        [may.key, undefined, 2],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names each client it matches by name, and not one whose GSTIN differs", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      const client = (title: string, gstin: string) =>
        records.create(orgId, owner, {
          list: "clients",
          originKey: `owner:${title}`,
          title,
          owner: me,
          fields: { gstin },
        });
      const { row: acme } = yield* client("Invented Acme", "27AAAAA0000A1Z5");
      const { row: beta } = yield* client("Invented Beta", "29CCCCC2222C1Z5");
      const plan = yield* imports.plan(
        orgId,
        ownerId,
        linesOf({ ...header, lists: [] }, [
          { client: { source: "c1", name: "Invented Acme", gstin: "29BBBBB1111B1Z5" } },
          { client: { source: "c2", name: "invented beta" } },
          { entry: { source: "t1", list: "work", title: "Call Acme", client: "c1" } },
          { entry: { source: "t2", list: "work", title: "Call Beta", client: "c2" } },
        ]),
      );
      assert.deepStrictEqual(
        [plan.clients.create, plan.clients.matched, plan.clientMatches],
        [
          1,
          1,
          [
            { source: "c1", name: "Invented Acme", key: acme.key, made: "C-3" },
            { source: "c2", name: "invented beta", key: beta.key, made: null },
          ],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("plans and applies fifty thousand entries in chunks; a second apply makes none", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const count = 50_000;
      const many = () =>
        Stream.concat(
          Stream.make(JSON.stringify({ ...header, lists: [] })),
          Stream.range(1, count).pipe(
            Stream.map((index) =>
              JSON.stringify({
                entry: {
                  source: `w${index}`,
                  list: "work",
                  title: `Generated task ${index}`,
                  state: "done",
                },
              }),
            ),
          ),
        );
      const seen: Array<number> = [];
      const plan = yield* imports.plan(orgId, ownerId, many(), (done) =>
        Effect.sync(() => {
          seen.push(done);
        }),
      );
      assert.deepStrictEqual(
        [plan.rows, plan.entries.create, plan.problems.length],
        [count, count, 0],
      );
      assert.deepStrictEqual([seen.length, seen.at(-1)], [Math.ceil((count + 1) / 100), count]);
      assert.strictEqual(yield* countOf("kin_records"), 0);
      const applied = yield* imports.apply(orgId, ownerId, many());
      assert.strictEqual(applied.entries.create, count);
      assert.strictEqual(yield* countOf("kin_records"), count);
      const again = yield* imports.apply(orgId, ownerId, many());
      assert.deepStrictEqual([again.entries.create, again.entries.unchanged], [0, count]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("an apply cut off part way leaves whole chunks, and a rerun completes it", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const tasks = Array.from({ length: 250 }, (_, index) => ({
        entry: { source: `w${index}`, list: "work", title: `Task ${index}`, state: "done" },
      }));
      const whole = linesOf({ ...header, lists: [] }, tasks);
      // The first pass reads it all; the second, the writing one, breaks after 220 lines.
      let reads = 0;
      const breaking = Stream.unwrap(
        Effect.sync(() => {
          reads += 1;
          return reads === 1
            ? whole
            : Stream.concat(
                whole.pipe(Stream.take(220)),
                Stream.fail(new KinChatError({ reason: "unavailable", message: "cut off" })),
              );
        }),
      );
      const cut = yield* imports.apply(orgId, ownerId, breaking).pipe(Effect.flip);
      assert.strictEqual(cut.message, "cut off");
      assert.strictEqual(yield* countOf("kin_records"), 219);
      const rerun = yield* imports.apply(orgId, ownerId, whole);
      assert.deepStrictEqual([rerun.entries.unchanged, rerun.entries.create], [219, 31]);
    }).pipe(Effect.provide(layer)),
  );

  it.each([
    ["OBK/2026-27/013", { series: "OBK|26-27", seq: 13 }],
    ["OBK/26-27/013", { series: "OBK|26-27", seq: 13 }],
    ["OBK-2026-27-007", { series: "OBK|26-27", seq: 7 }],
    ["OBK/2026-28/001", { series: "imported|OBK/2026-28/001", seq: 1 }],
    ["OBK-RN/2026-27/001", { series: "imported|OBK-RN/2026-27/001", seq: 1 }],
  ] as const)("places %s in its series", (number, expected) => {
    assert.deepStrictEqual(
      Numbers.seriesOf({ prefix: "OBK", series: "financial_year", width: 3 }, number),
      expected,
    );
  });
});
