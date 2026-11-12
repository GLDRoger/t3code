// @effect-diagnostics nodeBuiltinImport:off -- fixtures hash their invented files as the format asks.
import * as NodeCrypto from "node:crypto";

// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Numbers from "../gendocs/numbering.ts";
import { zip } from "../gendocs/zip.testkit.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { type Bundle, zipBundle } from "./importBundle.ts";
import * as KinImport from "./KinImport.ts";
import * as KinRecords from "./KinRecords.ts";

// Invented org, people, amounts and files only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const owner = { actor: { _tag: "person" as const, personId: ownerId }, via: "owner" as const };

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
});
const layer = KinImport.layer.pipe(
  Layer.provideMerge(KinRecords.layer),
  Layer.provideMerge(Layer.mergeAll(KinEventQueue.layer, identity)),
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

const text = (value: string) => new TextEncoder().encode(value);
const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const receipt = text("%PDF-1.4\n% an invented receipt\n");
const bundleOf = (doc: unknown, files: Readonly<Record<string, Uint8Array>> = {}): Bundle => ({
  json: text(JSON.stringify(doc)),
  read: (path) => {
    const bytes = files[path];
    return Effect.succeed(bytes === undefined ? { missing: true as const } : { bytes });
  },
});

const books = {
  format: "kin-import",
  version: 1,
  batch: "oldbooks",
  source: "Old Books",
  asOf: "2026-08-10",
  lists: [
    {
      list: "invoices",
      template: "invoices",
      numbering: { prefix: "QST", series: "financial_year", width: 3 },
    },
    {
      list: "expenses",
      template: "expenses",
      fields: [{ label: "Vendor GSTIN", type: "text" }],
      categories: ["subscriptions"],
    },
  ],
  clients: [{ source: "c1", name: "Invented Acme", terms: "30 days", createdAt: "2026-04-02" }],
  projects: [{ source: "p1", name: "Website", client: "c1", createdAt: "2026-04-03" }],
  entries: [
    {
      source: "t1",
      list: "work",
      title: "Send the welcome pack",
      state: "done",
      client: "c1",
      createdAt: "2026-04-05",
      closedAt: "2026-04-09",
    },
    {
      source: "t2",
      list: "work",
      title: "Renew the domain",
      state: "open",
      due: "2026-07-01",
      project: "p1",
      createdAt: "2026-06-20",
    },
    {
      source: "e1",
      list: "expenses",
      title: "Design tool seat",
      state: "done",
      date: "2026-05-14",
      amount: "1200.50",
      category: "software",
      fields: { vendor: "Invented Tools", vendorGstin: "29BBBBB1111B1Z5" },
    },
    {
      source: "i1",
      list: "invoices",
      title: "April retainer",
      state: "waiting",
      client: "c1",
      date: "2026-04-30",
      due: "2026-05-30",
      amount: "50000",
      number: "QST/2026-27/004",
    },
    {
      source: "i2",
      list: "invoices",
      title: "May retainer",
      state: "waiting",
      client: "c1",
      date: "2026-05-31",
      amount: "40000",
      number: "QST/26-27/002",
    },
  ],
  payments: [{ source: "pay1", entry: "i1", amount: "50000", paidOn: "2026-05-20" }],
  files: [
    {
      source: "f1",
      entry: "e1",
      name: "receipt.pdf",
      path: "receipts/e1.pdf",
      sha256: sha(receipt),
    },
  ],
};
const booksFiles = { "receipts/e1.pdf": receipt };

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
      key: string;
      state: string;
      createdAt: number;
      closedAt: number | null;
      notes: string;
    }>`SELECT key, state, created_at AS "createdAt", closed_at AS "closedAt", notes
      FROM kin_records WHERE org_id = ${orgId} AND origin_key LIKE ${`import:oldbooks:%:${source}`}`;
    return row!;
  });

describe("KinImport", () => {
  it.effect("applies exactly what it planned, quietly, keeping the old dates and numbers", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const plan = yield* imports.plan(orgId, ownerId, bundleOf(books, booksFiles));
      assert.strictEqual(yield* countOf("kin_records"), 0);
      assert.strictEqual(yield* countOf("kin_registers"), 0);
      const applied = yield* imports.apply(orgId, ownerId, bundleOf(books, booksFiles));
      assert.deepStrictEqual(applied.problems, []);
      assert.deepStrictEqual({ ...applied, applied: false }, plan);
      assert.deepStrictEqual(
        [applied.clients, applied.projects, applied.entries, applied.payments, applied.files].map(
          (one) => one.create,
        ),
        [1, 1, 5, 1, 1],
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
          total: { minor: 9000000, currency: "INR" },
          paid: { minor: 5000000, currency: "INR" },
        },
      ]);
      assert.deepStrictEqual(applied.stale, [
        { list: "invoices", open: 1, oldest: "2026-05-31" },
        { list: "work", open: 1, oldest: "2026-06-20" },
      ]);

      // Its own dates, in the owner's zone; closed when the old system closed it.
      const done = yield* recordOf("t1");
      assert.strictEqual(done.createdAt, Date.parse("2026-04-04T18:30:00.000Z"));
      assert.strictEqual(done.closedAt, Date.parse("2026-04-09T18:29:59.999Z"));
      assert.include((yield* recordOf("t2")).notes, "last kept up on 2026-08-10");
      assert.notInclude(done.notes, "last kept up");
      // Paid in full by its payment; the other still owed.
      assert.strictEqual((yield* recordOf("i1")).state, "done");
      assert.strictEqual((yield* recordOf("i2")).state, "waiting");

      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT DISTINCT via FROM kin_record_changes ORDER BY via`, [
        { via: "import" },
      ]);
      // Nothing wakes, posts or asks, however late the imported entries are.
      assert.deepStrictEqual(
        [
          yield* countOf("kin_events"),
          yield* countOf("kin_wakeups"),
          yield* countOf("kin_messages"),
          yield* countOf("kin_widgets"),
        ],
        [0, 0, 0, 0],
      );

      // Kin's next invoice number follows the highest imported one in that year's series.
      const records = yield* KinRecords.KinRecords;
      const { row: draft } = yield* records.create(orgId, owner, {
        list: "invoices",
        originKey: "owner:draft",
        title: "June retainer",
        owner: { _tag: "person", personId: ownerId },
        state: "open",
        amount: { minor: 100, currency: "INR" },
      });
      const issued = yield* Numbers.issue(orgId, owner, draft.key);
      assert.strictEqual(issued.number, "QST/26-27/005");

      // The receipt is the organisation's, on its entry, with no chat behind it.
      const expense = yield* records.get(orgId, (yield* recordOf("e1")).key);
      const detail = yield* records.detail(expense!);
      assert.deepStrictEqual(
        detail.files?.map((one) => [one.name, one.mimeType, one.chatId]),
        [["receipt.pdf", "application/pdf", undefined]],
      );
      const fs = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      assert.strictEqual((yield* fs.readDirectory(attachmentsDir)).length, 1);

      const again = yield* imports.apply(orgId, ownerId, bundleOf(books, booksFiles));
      assert.deepStrictEqual(
        [again.clients, again.projects, again.entries, again.payments, again.files].map((one) => [
          one.create,
          one.unchanged,
        ]),
        [
          [0, 1],
          [0, 1],
          [0, 5],
          [0, 1],
          [0, 1],
        ],
      );
      assert.strictEqual(yield* countOf("kin_records"), 8);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves an entry the owner changed after import alone, with what hangs off it", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const records = yield* KinRecords.KinRecords;
      yield* imports.apply(orgId, ownerId, bundleOf(books, booksFiles));
      const may = yield* recordOf("i2");
      yield* records.update(orgId, owner, may.key, { notes: "Agreed a discount by phone." });
      const later = {
        ...books,
        payments: [
          ...books.payments,
          { source: "pay2", entry: "i2", amount: "40000", paidOn: "2026-06-30" },
        ],
      };
      const report = yield* imports.apply(orgId, ownerId, bundleOf(later, booksFiles));
      assert.deepStrictEqual(report.changed, [{ source: "i2", key: may.key }]);
      assert.deepStrictEqual(
        [report.entries.changed, report.payments.changed, report.payments.unchanged],
        [1, 1, 1],
      );
      const kept = yield* recordOf("i2");
      assert.deepStrictEqual([kept.state, kept.notes], ["waiting", "Agreed a discount by phone."]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("names every row it can't import and imports the rest", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const broken = {
        ...books,
        entries: [
          ...books.entries,
          { source: "t1", list: "work", title: "A second t1" },
          { source: "x1", list: "work", title: "For a client never listed", client: "nobody" },
          { source: "x2", list: "leave", title: "On a list nobody defined" },
          { source: "x3", list: "expenses", title: "Lunch for ₹500", amount: "500" },
        ],
        payments: [
          ...books.payments,
          { source: "pay9", entry: "ghost", amount: "1", paidOn: "2026-05-01" },
        ],
        files: [
          ...books.files,
          {
            source: "f2",
            entry: "e1",
            name: "bad.pdf",
            path: "receipts/e1.pdf",
            sha256: "0".repeat(64),
          },
          {
            source: "f3",
            entry: "e1",
            name: "gone.pdf",
            path: "receipts/gone.pdf",
            sha256: sha(receipt),
          },
          {
            source: "f4",
            entry: "e1",
            name: "tool.exe",
            path: "receipts/e1.pdf",
            sha256: sha(receipt),
          },
          {
            source: "f5",
            entry: "e1",
            name: "up.pdf",
            path: "../secret.pdf",
            sha256: sha(receipt),
          },
        ],
      };
      const report = yield* imports.apply(orgId, ownerId, bundleOf(broken, booksFiles));
      assert.deepStrictEqual(
        report.problems.map((one) => [one.section, one.source]),
        [
          ["entries", "t1"],
          ["entries", "x1"],
          ["entries", "x2"],
          ["entries", "x3"],
          ["payments", "pay9"],
          ["files", "f2"],
          ["files", "f3"],
          ["files", "f4"],
          ["files", "f5"],
        ],
      );
      assert.include(report.problems[5]!.reason, "doesn't match its sha256");
      assert.include(report.problems[6]!.reason, "isn't in the import");
      assert.deepStrictEqual([report.entries.create, report.files.create], [5, 1]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a ZIP with its files beside import.json, also inside one folder", () =>
    Effect.gen(function* () {
      yield* seed;
      const imports = yield* KinImport.KinImport;
      const json = JSON.stringify(books);
      const pdf = new TextDecoder().decode(receipt);
      for (const root of ["", "export/"]) {
        const bundle = yield* zipBundle(
          zip([
            [`${root}import.json`, json],
            [`${root}files/receipts/e1.pdf`, pdf],
          ]),
        );
        const report = yield* imports.plan(orgId, ownerId, bundle);
        assert.deepStrictEqual([report.entries.create, report.files.create], [5, 1]);
      }
      const unpacked = yield* zipBundle(zip([["notes.txt", "no manifest"]])).pipe(Effect.flip);
      assert.include(unpacked.message, "import.json");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("is the owner's alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const stranger = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("teammate") }];
      const refused = yield* KinImport.ownerImport(
        stranger,
        "session:teammate",
        { orgId, upload: "pending-anything" },
        true,
      ).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_allowed");
    }).pipe(Effect.provide(layer)),
  );

  it.each([
    ["QST/2026-27/013", { series: "QST|26-27", seq: 13 }],
    ["QST/26-27/013", { series: "QST|26-27", seq: 13 }],
    ["QST-2026-27-007", { series: "QST|26-27", seq: 7 }],
    ["QST/2026-28/001", { series: "imported|QST/2026-28/001", seq: 1 }],
    ["QST-RN/2026-27/001", { series: "imported|QST-RN/2026-27/001", seq: 1 }],
  ] as const)("places %s in its series", (number, expected) => {
    assert.deepStrictEqual(
      KinImport.seriesOf({ prefix: "QST", series: "financial_year", width: 3 }, number),
      expected,
    );
  });
});
