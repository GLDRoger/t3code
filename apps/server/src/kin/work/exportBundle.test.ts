// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
// @effect-diagnostics nodeBuiltinImport:off -- the test writes a doc's file where the host keeps attachments.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KIN_EXPORT_HOLDS, KIN_EXPORT_LEAVES, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Yauzl from "yauzl";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { EXPORT_READS, exportZip } from "./exportBundle.ts";
import * as KinImport from "./KinImport.ts";
import * as KinRecords from "./KinRecords.ts";

// Invented companies, people, amounts and secrets only.
const from = KinOrgId.make("org-from");
const into = KinOrgId.make("org-into");
const owner = KinPersonId.make("owner-from");
const ownerInto = KinPersonId.make("owner-into");
const coOwner = KinPersonId.make("coowner-from");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const CANARY = "CANARY-SECRET-7f3a";
const ATTACHMENT = "kin-chat-docs-00000000-0000-4000-8000-000000000001-png";

const layer = KinImport.layer.pipe(
  Layer.provideMerge(KinRecords.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-export-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const org = (orgId: KinOrgId, name: string, personId: KinPersonId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, ${name}, ${at})`;
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
        dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${personId}, ${orgId}, ${`h-${personId}`}, 'Owner', ${at}, 'owner')`;
  });

const header = {
  format: "kin-import",
  version: 1,
  batch: "oldbooks",
  lists: [
    { list: "invoices", template: "invoices" },
    {
      list: "leave",
      name: "Leave",
      fields: [
        { label: "Covering", type: "person" },
        { label: "Visiting", type: "link", link: "clients" },
        { label: "Reason", type: "choice", choices: ["sick", "holiday"] },
      ],
      categories: ["half day"],
    },
  ],
};
const rows = [
  { client: { source: "c1", name: "Invented Acme", gstin: "29AAAAA0000A1Z5", terms: "30 days" } },
  { client: { source: "c2", name: "Invented Paper Co", kind: "vendor", state: "dropped" } },
  { project: { source: "p1", name: "Website", client: "c1", target: "2026-12-01" } },
  {
    entry: {
      source: "ct1",
      list: "contacts",
      title: "Invented Asha",
      client: "c1",
      fields: { role: "Finance", email: "asha@invented.example", phone: "+91 00000 00000" },
    },
  },
  {
    entry: {
      source: "t1",
      list: "work",
      title: "Send the welcome pack",
      state: "done",
      client: "c1",
      due: "2026-04-08",
      createdAt: "2026-04-05",
      closedAt: "2026-04-09",
    },
  },
  {
    entry: {
      source: "t2",
      list: "work",
      title: "Renew the domain",
      project: "p1",
      notes: "Two years this time.",
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
      amount: "61234.50",
      number: "INV/2026-27/004",
      fields: { tax: { amount: "1100", currency: "INR" } },
      payments: [{ source: "pay1", amount: "1234.50", paidOn: "2026-05-20", note: "part" }],
    },
  },
  {
    entry: {
      source: "l1",
      list: "leave",
      title: "Off for the wedding",
      category: "half day",
      date: "2026-06-02",
      fields: { covering: "owner", visiting: "c1", reason: "holiday" },
    },
  },
];
const books = Stream.fromIterable([header, ...rows].map((one) => JSON.stringify(one)));
// Later books add a way to pay to the Expenses template, and an expense paid that way.
const cheque = [
  {
    ...header,
    batch: "cheques",
    lists: [
      { list: "expenses", template: "expenses" },
      { list: "expenses", fields: [{ label: "Paid with", type: "choice", choices: ["cheque"] }] },
    ],
  },
  {
    entry: {
      source: "e1",
      list: "expenses",
      title: "Printer paper",
      state: "done",
      date: "2026-05-04",
      amount: "840",
      fields: { vendor: "Invented Paper Co", paidWith: "cheque" },
    },
  },
];
const chequeBooks = Stream.fromIterable(cheque.map((one) => JSON.stringify(one)));

const unzip = (bytes: Uint8Array) =>
  Effect.promise(
    () =>
      new Promise<Map<string, Buffer>>((resolve, reject) => {
        Yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
          if (error !== null) return reject(error);
          const out = new Map<string, Buffer>();
          zip.on("entry", (entry: Yauzl.Entry) =>
            zip.openReadStream(entry, (cause, readable) => {
              if (cause !== null) return reject(cause);
              const parts: Array<Buffer> = [];
              readable.on("data", (part: Buffer) => parts.push(part));
              readable.on("end", () => {
                out.set(entry.fileName, Buffer.concat(parts));
                zip.readEntry();
              });
            }),
          );
          zip.on("end", () => resolve(out));
          zip.on("error", reject);
          zip.readEntry();
        });
      }),
  );

/** What an org holds, as `kin import` makes it again: owners and dates aside. */
const holdings = (orgId: KinOrgId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql<{
      registerId: string;
      title: string;
      state: string;
      category: string | null;
      amountMinor: number | null;
      dueAt: number | null;
      dateAt: number | null;
      sensitive: number;
      notes: string;
      fieldsJson: string;
      party: string | null;
      project: string | null;
      createdAt: number;
      confirmed: number;
    }>`SELECT r.register_id AS "registerId", r.title, r.state, r.category, r.confirmed,
        r.amount_minor AS "amountMinor", r.due_at AS "dueAt", r.date_at AS "dateAt",
        r.sensitive, r.notes, r.fields_json AS "fieldsJson", p.title AS party,
        j.title AS project, r.created_at AS "createdAt"
      FROM kin_records r LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.party_id
        LEFT JOIN kin_records j ON j.org_id = r.org_id AND j.record_id = r.project_id
      WHERE r.org_id = ${orgId} AND r.register_id <> 'docs' ORDER BY r.register_id, r.title`;
    const payments = yield* sql`SELECT r.title, p.amount_minor AS "amountMinor", p.paid_on AS
        "paidOn", p.note FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id
        AND r.record_id = p.record_id WHERE p.org_id = ${orgId} ORDER BY r.title`;
    const numbers = yield* sql`SELECT number FROM kin_issued_numbers WHERE org_id = ${orgId}`;
    const lists = yield* sql`SELECT register_id AS id, name, definition_json AS definition
      FROM kin_registers WHERE org_id = ${orgId} AND built_in = 0 ORDER BY register_id`;
    return { records, payments, numbers, lists };
  });

describe("Download everything", () => {
  it.effect("is what kin import makes the company again from, and holds no secret", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* org(from, "Invented Studio", owner);
      yield* org(into, "Invented Studio Again", ownerInto);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${coOwner}, ${from}, 'co', 'Co-owner', ${at}, 'co_owner')`;
      const imports = yield* KinImport.KinImport;
      const seeded = yield* imports.apply(from, owner, books);
      assert.deepStrictEqual(seeded.problems, []);
      const extended = yield* imports.apply(from, owner, chequeBooks);
      assert.deepStrictEqual(extended.problems, []);
      // A file without the suggestion field imports as it always did: kept.
      assert.deepStrictEqual(
        yield* sql`SELECT DISTINCT confirmed FROM kin_records WHERE org_id = ${from}`,
        [{ confirmed: 1 }],
      );
      // An agent's suggestion nobody kept, with a payment recorded before: it comes back as one.
      yield* sql`UPDATE kin_records SET confirmed = 0 WHERE org_id = ${from} AND record_id IN
        (SELECT record_id FROM kin_record_payments WHERE org_id = ${from})`;

      // A doc with a picture in it, kept as the host keeps both.
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at) VALUES (${from}, 'docs', 'Docs', 'D', 1, ${NOW})`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at, category)
        VALUES (${from}, 'doc1', 'docs', 'D-1', 'Brand guide', 'person', ${owner}, 'person',
          'test:doc1', ${NOW}, ${NOW}, 'reference')`;
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind,
          summary, operations_json, actor_kind, via, origin_key, created_at)
        VALUES (${from}, 'doc1', 1, 'Old words.', 'Brand guide', 'created', '', '[]', 'person',
          'owner', 'test:v1', ${NOW}), (${from}, 'doc1', 2, 'Use the blue. kin-file:x', 'Brand guide',
          'edited', '', '[]', 'person', 'owner', 'test:v2', ${NOW})`;
      yield* sql`INSERT INTO kin_doc_files (org_id, record_id, attachment_id, created_at)
        VALUES (${from}, 'doc1', ${ATTACHMENT}, ${NOW})`;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${ATTACHMENT}.png`), "invented png");

      // Secrets the host keeps beside the company's records.
      yield* sql`INSERT INTO kin_push_devices (org_id, token, person_id, platform, aps_environment,
          session_id, created_at, updated_at)
        VALUES (${from}, ${CANARY}, ${owner}, 'ios', 'development', ${`s-${CANARY}`}, ${NOW}, ${NOW})`;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${from}, ${JSON.stringify({ bankAccount: CANARY })}, 1, ${NOW}, 'person', ${owner})`;

      // Only the owner may take it; a co-owner is refused.
      const refused = yield* exportZip(from, coOwner).pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_allowed");

      const bytes = yield* (yield* exportZip(from, owner)).pipe(
        Stream.runFold(
          () => [] as Array<Uint8Array>,
          (parts, part) => {
            parts.push(part);
            return parts;
          },
        ),
        Effect.map((parts) => Buffer.concat(parts)),
      );
      const zip = yield* unzip(bytes);
      assert.deepStrictEqual(
        [...zip.keys()],
        ["README.txt", "kin.jsonl", "docs/D-1 Brand guide.md", `docs/D-1/${ATTACHMENT}.png`],
      );
      assert.strictEqual(
        zip.get("docs/D-1 Brand guide.md")!.toString(),
        "# Brand guide\n\nUse the blue. kin-file:x\n",
      );
      assert.strictEqual(zip.get(`docs/D-1/${ATTACHMENT}.png`)!.toString(), "invented png");
      // What it holds and leaves out reads the same in the zip, in Settings and in the user guide.
      const guide = NodeFS.readFileSync(
        NodePath.resolve(import.meta.dirname, "../../../../../docs/user/kin.md"),
        "utf8",
      ).replace(/\s+/g, " ");
      for (const words of [KIN_EXPORT_HOLDS, KIN_EXPORT_LEAVES]) {
        assert.include(zip.get("README.txt")!.toString(), words);
        assert.include(guide, words);
      }

      // Nothing kept outside the company's records leaves: no token, key, session or invite.
      assert.notInclude(bytes.toString("latin1"), CANARY);
      for (const [, body] of zip) assert.notInclude(body.toString(), CANARY);
      assert.deepStrictEqual(EXPORT_READS, [
        "kin_orgs",
        "kin_registers",
        "kin_records",
        "kin_record_payments",
        "kin_issued_numbers",
        "kin_doc_versions",
        "kin_doc_files",
      ]);

      // Restore is kin import, into a company that has nothing yet.
      const lines = zip.get("kin.jsonl")!.toString().trimEnd().split("\n");
      const restored = yield* imports.apply(into, ownerInto, Stream.fromIterable(lines));
      assert.deepStrictEqual(restored.problems, []);
      assert.deepStrictEqual(
        [restored.clients, restored.projects, restored.entries, restored.payments].map(
          (one) => one.create,
        ),
        [2, 1, 6, 1],
      );

      const before = yield* holdings(from);
      const after = yield* holdings(into);
      assert.deepStrictEqual(after.payments, before.payments);
      assert.deepStrictEqual(after.numbers, before.numbers);
      assert.deepStrictEqual(after.lists, before.lists);
      assert.strictEqual(after.records.length, before.records.length);
      // Field by field, every record but who holds it.
      const sample = (rows: typeof before.records, orgOwner: string) =>
        rows.map(({ fieldsJson, ...row }) => ({
          ...row,
          fields: JSON.parse(fieldsJson.replaceAll(orgOwner, "OWNER")),
        }));
      const withoutLinks = (rows: ReturnType<typeof sample>) =>
        rows.map(({ fields, ...row }) => ({ ...row, fields: { ...fields, visiting: undefined } }));
      assert.deepStrictEqual(
        withoutLinks(sample(after.records, ownerInto)),
        withoutLinks(sample(before.records, owner)),
      );
      // The added way to pay comes back on the list, and the expense paid that way with it.
      const paidWith = (orgId: KinOrgId) =>
        sql<{ choices: string; paid: string }>`SELECT
            (SELECT f.value ->> '$.choices' FROM kin_registers g, json_each(g.definition_json, '$.fields') f
              WHERE g.org_id = ${orgId} AND g.register_id = 'expenses'
                AND f.value ->> '$.key' = 'paidWith') AS choices,
            json_extract(r.fields_json, '$.paidWith') AS paid
          FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'expenses'`;
      assert.deepStrictEqual(yield* paidWith(into), [
        { choices: '["card","upi","bank","cash","cheque"]', paid: "cheque" },
      ]);
      // A link points at the same client again, by its new record.
      const leave = (yield* sql<{ client: string }>`SELECT c.title AS client FROM kin_records r
        JOIN kin_records c ON c.org_id = r.org_id
          AND c.record_id = json_extract(r.fields_json, '$.visiting')
        WHERE r.org_id = ${into} AND r.register_id = 'leave'`)[0];
      assert.strictEqual(leave?.client, "Invented Acme");
    }).pipe(Effect.provide(layer)),
  );
});
