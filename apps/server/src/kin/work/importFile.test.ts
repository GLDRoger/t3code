// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_IMPORT_MAX_FILE_BYTES,
  KinAgentId,
  KinChatError,
  type KinImportMapping,
  type KinImportTarget,
  KinOrgId,
  KinPersonId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ImportFile from "./importFile.ts";
import * as KinImport from "./KinImport.ts";
import * as KinRecords from "./KinRecords.ts";
import { dayIn } from "./money.ts";
import * as Clients from "./ownerClients.ts";

// Invented company (Ambermill), people, clients and amounts only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("rhea");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const ZONE = "Pacific/Auckland";
const rhea = { _tag: "person" as const, orgId, personId: ownerId };
const meera = { _tag: "person" as const, orgId, personId: KinPersonId.make("meera") };
const zoya = { _tag: "person" as const, orgId, personId: KinPersonId.make("zoya") };
const isChatError = Schema.is(KinChatError);

const identity = Layer.mock(KinIdentity)({
  owner: rhea,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make("lead"),
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
    }),
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = KinImport.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(KinRecords.layer, identity, gate)),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-import-file-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Rhea owns Ambermill; Meera is a co-owner; Zoya sells with Clients on. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, ${ZONE}, '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner'),
      ('meera', ${orgId}, 'meera', 'Meera', ${at}, 'co_owner'),
      ('zoya', ${orgId}, 'zoya', 'Zoya', ${at}, 'member')`;
  yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = 'zoya'`;
  const party = (name: string) =>
    Clients.createParty([rhea], { orgId, name, clientRequestId: name });
  const kestrel = yield* party("Invented Kestrel Freight");
  const orbit = yield* party("Invented Orbit Dental");
  const lumen = yield* party("Invented Lumen Grove");
  const cafe = yield* party("Invented Corner Cafe");
  const contact = (key: string, name: string, email: string) =>
    Clients.createContact([rhea], { orgId, party: key, name, email, clientRequestId: email });
  yield* contact(kestrel.key, "Lars Holm", "lars@kestrel.example");
  yield* contact(orbit.key, "Ana Berg", "ana@orbitdental.example");
  yield* contact(cafe.key, "Kim Lee", "kim.cafe@gmail.com");
  return { kestrel: kestrel.key, orbit: orbit.key, lumen: lumen.key };
});

const fileOf = (text: string | Uint8Array, name = "old-crm.csv") => ({
  name,
  data: Buffer.from(text).toString("base64"),
});
const utf16 = (text: string, big: boolean, mark: boolean) => {
  const le = Buffer.from(text, "utf16le");
  if (big)
    for (let index = 0; index < le.length; index += 2)
      le.writeUInt16BE(le.readUInt16LE(index), index);
  const bom = big ? [0xfe, 0xff] : [0xff, 0xfe];
  return new Uint8Array(mark ? [...bom, ...le] : [...le]);
};
const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isChatError(error) ? `${error.reason}: ${error.message}` : error._tag)),
  );
const readOk = (bytes: Uint8Array) => {
  const csv = ImportFile.readCsv(bytes);
  if (isChatError(csv)) throw new Error(csv.message);
  return csv;
};

describe("reading a CSV", () => {
  it("reads each encoding and separator to the same rows", () => {
    const table = "Company,E-mail\nInvented Acme,ana@acme.example\n";
    const as = (separator: string) => table.replaceAll(",", separator);
    const cases: ReadonlyArray<readonly [string, Uint8Array]> = [
      ["UTF-8, comma", new TextEncoder().encode(as(","))],
      [
        "UTF-8 with a mark, semicolon",
        new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(as(";"))]),
      ],
      ["UTF-16 LE with a mark, tab", utf16(as("\t"), false, true)],
      ["UTF-16 BE with a mark, comma", utf16(as(","), true, true)],
      ["UTF-16 LE without a mark, semicolon", utf16(as(";"), false, false)],
      ["CRLF line ends", new TextEncoder().encode(as(",").replaceAll("\n", "\r\n"))],
    ];
    for (const [name, bytes] of cases)
      assert.deepStrictEqual(
        readOk(bytes),
        {
          headers: ["Company", "E-mail"],
          rows: [{ line: 2, cells: ["Invented Acme", "ana@acme.example"] }],
        },
        name,
      );
  });

  it("keeps separators, doubled quotes and line breaks inside a quoted field, numbering lines as the file does", () => {
    const csv = readOk(
      new TextEncoder().encode(
        'Company;Notes\n"Invented; Acme";"Met at stand B12\nwants a ""pilot"""\n\nInvented Orbit;x\n',
      ),
    );
    assert.deepStrictEqual(csv.rows, [
      { line: 2, cells: ["Invented; Acme", 'Met at stand B12\nwants a "pilot"'] },
      { line: 5, cells: ["Invented Orbit", "x"] },
    ]);
  });

  it("refuses past its caps and what isn't text, in plain sentences", () => {
    const header = "Company\n";
    const rows = (count: number) => header + "Invented Row\n".repeat(count);
    assert.strictEqual(readOk(new TextEncoder().encode(rows(50_000))).rows.length, 50_000);
    const cases: ReadonlyArray<readonly [Uint8Array, string]> = [
      [
        new TextEncoder().encode(rows(50_001)),
        "The file has more than 50,000 rows; Kin takes up to 50,000 at a time. Split it into smaller files and import each.",
      ],
      [new Uint8Array(KIN_IMPORT_MAX_FILE_BYTES + 1).fill(65), ImportFile.TOO_BIG],
      [
        new Uint8Array([0x43, 0x6f, 0xff, 0xfe, 0xfd, 0x0a]),
        "Kin reads files saved as CSV in UTF-8 or UTF-16, and this one is neither. Save it again as CSV UTF-8 and choose it again.",
      ],
      [new TextEncoder().encode("\n\n"), "The file is empty."],
      [new TextEncoder().encode(header), "The file has a header row and nothing under it."],
    ];
    for (const [bytes, sentence] of cases) {
      const read = ImportFile.readCsv(bytes);
      assert.strictEqual(isChatError(read) ? read.message : "read", sentence);
    }
    assert.strictEqual(
      ImportFile.TOO_BIG,
      "The file is over 10 MB; Kin takes up to 10 MB at a time. Split it into smaller files and import each.",
    );
  });
});

describe("proposing columns", () => {
  it("knows the header words, takes several email and phone columns, and leaves out why we may mail them", () => {
    assert.deepStrictEqual(
      ImportFile.proposeColumns([
        "Company",
        "Status",
        "Contact name",
        "E-mail",
        "Work email",
        "Phone",
        "Mobile",
        "Opportunity",
        "Amount",
        "Pipeline stage",
        "Owner",
        "Source",
        "Notes",
        "Fax",
        "Why we may mail them",
        "Account name",
      ]),
      [
        "client.name",
        "client.kind",
        "contact.name",
        "contact.email",
        "contact.email",
        "contact.phone",
        "contact.phone",
        "deal.title",
        "deal.value",
        "deal.stage",
        "owner",
        "client.source",
        "client.notes",
        "skip",
        "skip",
        "skip",
      ],
    );
  });

  it("reads amounts with their currency and days in the chosen format", () => {
    const money: ReadonlyArray<readonly [string, ReturnType<typeof ImportFile.parseMoneyCell>]> = [
      ["18000", { amount: "18000", currency: undefined }],
      ["€18.000,50", { amount: "18000.50", currency: "EUR" }],
      ["18 000 NOK", { amount: "18000", currency: "NOK" }],
      ["USD 1,200.5", { amount: "1200.5", currency: "USD" }],
      ["1,234", { amount: "1234", currency: undefined }],
      ["12,5", { amount: "12.5", currency: undefined }],
      ["$900", { amount: "900", currency: undefined }],
      ["about ten", undefined],
    ];
    for (const [cell, read] of money)
      assert.deepStrictEqual(ImportFile.parseMoneyCell(cell), read, cell);
    assert.deepStrictEqual(
      [
        ImportFile.parseDayCell("2026-04-03", undefined),
        ImportFile.parseDayCell("03/04/2026", undefined),
        ImportFile.parseDayCell("03/04/2026", "dmy"),
        ImportFile.parseDayCell("03/04/2026", "mdy"),
        ImportFile.parseDayCell("31.02.26", "dmy"),
      ],
      ["2026-04-03", undefined, "2026-04-03", "2026-03-04", undefined],
    );
  });
});

const HEADERS =
  "Company,Status,Contact name,E-mail,Email 2,Phone,Address,Opportunity,Amount,Pipeline stage,Close date,Owner,Why we may mail them";
const ROWS = [
  // Named otherwise than Kin's client: a contact's email Kin has only asks.
  "Kestrel Freight Ltd,Customer,Lars Holm,lars@kestrel.example,,,Harbour Road 1,,,,,,yes",
  // So does the web domain of another contact's email, at one client.
  "Orbit Dental Group,Customer,Mia Berg,mia@orbitdental.example,,,,,,,,,",
  // The folded name.
  "INVENTED  LUMEN GROVE,Customer,,,,,,,,,,,",
  // Close to Lumen Grove: never merged by itself.
  "Invented Lumen Grove (Oslo),Prospect,,,,,,,,,,,",
  // A public mail domain says nothing: Corner Cafe's contact is at gmail too.
  "Invented Pebble Bakery,Lead,Pia Lund,pia.bakery@gmail.com,,,,,,,,,",
  // One client twice, by name in another case; a third name at its web domain is its own client.
  "Invented Harbour Tiles,Prospect,Oda Dahl,oda@harbourtiles.example,,+47 900 00 001,,Showroom refit,18000,Negotiation,03/04/2026,Zoya,",
  "invented harbour tiles,,Oda Dahl,ODA@harbourtiles.example,,+47 900 00 002,,,,,,,",
  "Harbour Tiles Holdings,,Per Dahl,per@harbourtiles.example; sales@harbourtiles.example,per.dahl@harbourtiles.example,+47 900 00 003; +47 900 00 004,,Second site,EUR 2400,In talks,05/04/2026,Someone Else,",
];
const csvText = `${HEADERS}\n${ROWS.join("\n")}\n`;
const mapping = (extra: Partial<KinImportMapping> = {}): KinImportMapping => ({
  columns: ImportFile.proposeColumns(HEADERS.split(",")) as ReadonlyArray<KinImportTarget>,
  ...extra,
});
const ready = { currency: "EUR", dateFormat: "dmy" } as const;

describe("bringing a file in", () => {
  it.effect(
    "proposes, matches by each rule, asks what it can't know, and is ready once decided",
    () =>
      Effect.gen(function* () {
        const { kestrel, orbit, lumen } = yield* seed;
        const file = fileOf(csvText);
        const proposed = yield* ImportFile.check([rhea], { orgId, file });
        assert.isFalse(proposed.checked);
        assert.deepStrictEqual(
          proposed.notImported.map((one) => one.header),
          ["Why we may mail them"],
        );
        assert.strictEqual(proposed.columns[0]?.sample, "Kestrel Freight Ltd");

        const first = yield* ImportFile.check([rhea], { orgId, file, mapping: mapping() });
        assert.deepStrictEqual(first.asks, {
          currency: true,
          dateFormat: true,
          dateExamples: ["03/04/2026", "05/04/2026"],
        });
        assert.deepStrictEqual(
          first.matches.map((one) => [one.name, one.key, one.by, one.kept]),
          [["INVENTED  LUMEN GROVE", lumen, "name", []]],
        );
        assert.deepStrictEqual(
          first.decide.map((one) => [
            one.name,
            one.candidates.map((candidate) => candidate.key),
            one.decision,
          ]),
          [
            ["Kestrel Freight Ltd", [kestrel], null],
            ["Orbit Dental Group", [orbit], null],
            ["Invented Lumen Grove (Oslo)", [lumen], null],
          ],
        );
        assert.deepStrictEqual(first.stages, [{ value: "Negotiation", rows: 1, decision: null }]);
        assert.isFalse(first.ready);

        const decided = yield* ImportFile.check([rhea], {
          orgId,
          file,
          mapping: mapping(ready),
          decisions: {
            clients: { r2: kestrel, r3: orbit, r5: "new" },
            stages: { negotiation: "deciding" },
          },
        });
        assert.isTrue(decided.ready);
        // Pebble and Oslo are prospects; Harbour Tiles' two rows are one prospect.
        assert.deepStrictEqual(decided.will, { prospects: 3, clients: 1, contacts: 4, deals: 2 });
        assert.strictEqual(decided.matched, 3);
        assert.strictEqual(decided.ownersUnknown, 1);
        // Checking writes nothing.
        const sql = yield* SqlClient.SqlClient;
        const [held] = yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM kin_records WHERE org_id = ${orgId}`;
        assert.strictEqual(held?.n, 7);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("finds each same name by the title index as it did without it", () =>
    Effect.gen(function* () {
      const { kestrel, orbit } = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const decisions = {
        clients: { r2: kestrel, r3: orbit, r5: "new" as const },
        stages: { negotiation: "deciding" },
      };
      const first = fileOf(csvText);
      const { batch } = yield* ImportFile.check([rhea], {
        orgId,
        file: first,
        mapping: mapping(ready),
        decisions,
      });
      yield* ImportFile.apply([rhea], {
        orgId,
        file: first,
        mapping: mapping(ready),
        decisions,
        batch,
      });
      // Names Kin has in another case, a contact and a deal at their client, a deal's name at
      // another client, and one deal twice in the file.
      const again = fileOf(
        `${HEADERS}\n${[
          "INVENTED HARBOUR TILES,,OdA DaHl,,,,,SHOWROOM REFIT,500,In talks,01/05/2026,,",
          "invented kestrel freight,,LARS HOLM,,,,,Second site,100,In talks,01/05/2026,,",
          "Invented Fjord Mills,Prospect,Ivo Lind,ivo@fjordmills.example,,,,Second Site,100,In talks,01/05/2026,,",
          "Invented Fjord Mills,,,,,,,second site,100,In talks,01/05/2026,,",
        ].join("\n")}\n`,
        "again.csv",
      );
      const check = ImportFile.check([rhea], { orgId, file: again, mapping: mapping(ready) });
      const indexed = yield* check;
      yield* sql`DROP INDEX idx_kin_records_title`;
      assert.deepStrictEqual(yield* check, indexed);
      assert.deepStrictEqual(indexed.will, { prospects: 1, clients: 0, contacts: 1, deals: 0 });
      assert.deepStrictEqual(
        indexed.matches.map((one) => [one.name, one.by]),
        [
          ["INVENTED HARBOUR TILES", "name"],
          ["invented kestrel freight", "name"],
        ],
      );
      assert.deepStrictEqual(
        indexed.leftOut.map((one) => [one.line, one.reason]),
        [
          [2, "There is already a deal named SHOWROOM REFIT: DL-1."],
          [3, "There is already a deal named Second site: DL-2."],
          [4, "There is already a deal named Second Site: DL-2."],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "imports as checked: in-file duplicates collapse, several emails and phones, deals through Deals, and a rerun changes nothing",
    () =>
      Effect.gen(function* () {
        const { kestrel, orbit } = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const file = fileOf(csvText);
        const decisions = {
          clients: { r2: kestrel, r3: orbit, r5: "new" as const },
          stages: { negotiation: "deciding" },
        };
        const checked = yield* ImportFile.check([rhea], {
          orgId,
          file,
          mapping: mapping(ready),
          decisions,
        });
        const applied = yield* ImportFile.apply([rhea], {
          orgId,
          file,
          mapping: mapping(ready),
          decisions,
          batch: checked.batch,
        });
        assert.deepStrictEqual(applied.added, { prospects: 3, clients: 1, contacts: 4, deals: 2 });
        assert.strictEqual(applied.matched, 3);
        assert.strictEqual(applied.filled, 1);
        assert.deepStrictEqual(applied.noticed, { noNextStep: 2, datesPassed: 2 });

        const harbour = yield* sql<{ recordId: string; category: string; owner: string }>`SELECT
          record_id AS "recordId", category, owner_id AS owner FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'clients' AND title = 'Invented Harbour Tiles'`;
        assert.deepStrictEqual(
          harbour.map((one) => [one.category, one.owner]),
          [["prospect", "zoya"]],
        );
        const people = yield* sql<{ client: string; name: string; fields: string }>`SELECT
          p.title AS client, c.title AS name, c.fields_json AS fields FROM kin_records c
          JOIN kin_records p ON p.org_id = c.org_id AND p.record_id = c.party_id
        WHERE c.org_id = ${orgId} AND c.register_id = 'contacts' AND p.title LIKE '%Harbour Tiles%'
        ORDER BY c.title`;
        assert.deepStrictEqual(
          people.map((one) => [one.client, one.name, JSON.parse(one.fields)]),
          [
            [
              "Invented Harbour Tiles",
              "Oda Dahl",
              {
                email: "oda@harbourtiles.example",
                phones: ["+47 900 00 001", "+47 900 00 002"],
                phone: "+47 900 00 001",
              },
            ],
            [
              "Harbour Tiles Holdings",
              "Per Dahl",
              {
                email: "per@harbourtiles.example",
                emails: [
                  "per@harbourtiles.example",
                  "sales@harbourtiles.example",
                  "per.dahl@harbourtiles.example",
                ],
                phone: "+47 900 00 003",
                phones: ["+47 900 00 003", "+47 900 00 004"],
              },
            ],
          ],
        );
        const deals = yield* sql<{
          title: string;
          fields: string;
          owner: string;
          dueAt: number;
        }>`SELECT
          title, fields_json AS fields, owner_id AS owner, due_at AS "dueAt" FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'deals' ORDER BY title`;
        assert.deepStrictEqual(
          deals.map((one) => [
            one.title,
            JSON.parse(one.fields).stage,
            JSON.parse(one.fields).value,
            one.owner,
            dayIn(one.dueAt, ZONE),
          ]),
          [
            // Its owner is no one Kin knows, so whoever imported it.
            ["Second site", "in-talks", { minor: 240000, currency: "EUR" }, "rhea", "2026-04-05"],
            [
              "Showroom refit",
              "deciding",
              { minor: 1800000, currency: "EUR" },
              "zoya",
              "2026-04-03",
            ],
          ],
        );
        // Kestrel had no address: it gains the file's, and keeps everything it had.
        const [kestrelRow] = yield* sql<{
          fields: string;
        }>`SELECT fields_json AS fields FROM kin_records
        WHERE org_id = ${orgId} AND key = ${kestrel}`;
        assert.strictEqual(JSON.parse(kestrelRow!.fields).address, "Harbour Road 1");

        const count = sql<{ n: number; rev: number }>`SELECT COUNT(*) AS n, SUM(rev) AS rev
        FROM kin_records WHERE org_id = ${orgId}`;
        const before = yield* count;
        const again = yield* ImportFile.apply([rhea], {
          orgId,
          file,
          mapping: mapping(ready),
          decisions,
          batch: checked.batch,
        });
        assert.deepStrictEqual(
          [again.added, again.filled],
          [{ prospects: 0, clients: 0, contacts: 0, deals: 0 }, 0],
        );
        assert.deepStrictEqual(yield* count, before);
        const rechecked = yield* ImportFile.check([rhea], {
          orgId,
          file,
          mapping: mapping(ready),
          decisions,
        });
        assert.deepStrictEqual(rechecked.will, { prospects: 0, clients: 0, contacts: 0, deals: 0 });
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "undo takes away what the batch added and empties what it filled, refusing what changed since",
    () =>
      Effect.gen(function* () {
        const { kestrel, orbit } = yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const file = fileOf(
          "Company,Contact name,E-mail,Address,Notes\nInvented Kestrel Freight,,,Harbour Road 1,\nInvented Orbit Dental,,,Quay 2,\nInvented Fjord Labs,Eli Moen,eli@fjordlabs.example,,Met at stand B12\nInvented Vika Studio,Siv Ruud,siv@vika.example,,\n",
        );
        const columns = ImportFile.proposeColumns([
          "Company",
          "Contact name",
          "E-mail",
          "Address",
          "Notes",
        ]);
        const checked = yield* ImportFile.check([rhea], { orgId, file, mapping: { columns } });
        yield* ImportFile.apply([rhea], {
          orgId,
          file,
          mapping: { columns },
          batch: checked.batch,
        });
        // Someone changes Orbit, which the import filled, and one contact the import made.
        const [orbitRow] = yield* sql<{ rev: number }>`SELECT rev FROM kin_records
          WHERE org_id = ${orgId} AND key = ${orbit}`;
        yield* Clients.updateParty([rhea], {
          orgId,
          key: orbit,
          notes: "Rhea's own words",
          rev: orbitRow!.rev,
        });
        const [siv] = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
        WHERE org_id = ${orgId} AND title = 'Siv Ruud'`;
        yield* Clients.updateContact([rhea], {
          orgId,
          key: siv!.key,
          role: "Founder",
          rev: siv!.rev,
        });

        const runs = yield* ImportFile.runs([rhea], { orgId });
        assert.deepStrictEqual(
          runs.runs.map((one) => [one.batch, one.file, one.by, one.added, one.undone]),
          [
            [
              checked.batch,
              "old-crm.csv",
              ownerId,
              { clients: 2, contacts: 2, deals: 0, other: 0 },
              null,
            ],
          ],
        );
        const undone = yield* ImportFile.undo([rhea], { orgId, batch: checked.batch });
        assert.deepStrictEqual(undone.removed, { clients: 1, contacts: 1, deals: 0, other: 0 });
        assert.strictEqual(undone.restored, 1);
        const [vika] = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE org_id = ${orgId} AND title = 'Invented Vika Studio'`;
        assert.deepStrictEqual(undone.kept, [
          { key: siv!.key, reason: "someone changed it since the import" },
          { key: vika!.key, reason: `${siv!.key} uses it` },
          { key: orbit, reason: "it changed since the import filled in its address, so they stay" },
        ]);
        const address = (key: string) =>
          sql<{ address: string | null }>`SELECT json_extract(fields_json, '$.address') AS address
          FROM kin_records WHERE org_id = ${orgId} AND key = ${key}`;
        assert.deepStrictEqual(yield* address(kestrel), [{ address: null }]);
        assert.deepStrictEqual(yield* address(orbit), [{ address: "Quay 2" }]);
        const [fjord] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE org_id = ${orgId} AND title IN ('Invented Fjord Labs', 'Eli Moen')`;
        assert.strictEqual(fjord?.n, 0);
        const after = yield* ImportFile.runs([rhea], { orgId });
        assert.strictEqual(after.runs[0]?.undone?.by, ownerId);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "undo keeps a client or prospect someone logged contact with, and its contacts, and takes the rest",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const file = fileOf(
          "Company,Status,Contact name,E-mail\nInvented Fenn Bakery,,Ida Lund,ida@fenn.example\nInvented Fenn Bakery,,Ola Lund,ola@fenn.example\nInvented Tarn Optics,Prospect,Per Vik,per@tarn.example\nInvented Moss Hall,,Eva Moss,eva@moss.example\nInvented Sund Yard,,Tor Sund,tor@sund.example\n",
        );
        const columns: ReadonlyArray<KinImportTarget> = [
          "client.name",
          "client.kind",
          "contact.name",
          "contact.email",
        ];
        const checked = yield* ImportFile.check([rhea], { orgId, file, mapping: { columns } });
        yield* ImportFile.apply([rhea], {
          orgId,
          file,
          mapping: { columns },
          batch: checked.batch,
        });
        const keyOf = (title: string) =>
          sql<{ key: string }>`SELECT key FROM kin_records
            WHERE org_id = ${orgId} AND title = ${title}`.pipe(Effect.map((rows) => rows[0]?.key));
        // Each way contact reaches a client: logged and kept, logged then taken back, none.
        const cases = [
          { client: "Invented Fenn Bakery", contacts: ["Ida Lund", "Ola Lund"], touch: "logged" },
          { client: "Invented Tarn Optics", contacts: ["Per Vik"], touch: "removed" },
          { client: "Invented Moss Hall", contacts: ["Eva Moss"], touch: "none" },
          { client: "Invented Sund Yard", contacts: ["Tor Sund"], touch: "none" },
        ] as const;
        for (const one of cases) {
          if (one.touch === "none") continue;
          const logged = yield* Clients.logTouch([rhea], {
            orgId,
            party: (yield* keyOf(one.client))!,
            kind: "email",
            clientRequestId: one.client,
          });
          if (one.touch === "removed")
            yield* Clients.removeTouch([rhea], { orgId, touchId: logged.id });
        }
        // The client is kept by the contact logged with it and by its own contacts, kept with it.
        const keptWhy = yield* Effect.forEach(
          cases.filter((one) => one.touch !== "none"),
          (one) =>
            Effect.gen(function* () {
              const contacts = yield* Effect.forEach(one.contacts, keyOf);
              return [
                { key: (yield* keyOf(one.client))!, by: [...contacts, "a logged contact"] },
                ...contacts.map((key) => ({ key: key!, by: ["a logged contact"] })),
              ];
            }),
        );

        const undone = yield* ImportFile.undo([rhea], { orgId, batch: checked.batch });
        assert.deepStrictEqual(undone.removed, { clients: 2, contacts: 2, deals: 0, other: 0 });
        assert.deepStrictEqual(
          undone.kept,
          keptWhy
            .flat()
            .map(({ key, by }) => ({
              key,
              reason: `${by.join(", ")} ${by.length === 1 ? "uses" : "use"} it`,
            }))
            .toSorted((a, b) => (a.key < b.key ? -1 : 1)),
        );
        for (const one of cases)
          assert.deepStrictEqual(
            yield* Effect.forEach([one.client, ...one.contacts], keyOf).pipe(
              Effect.map((keys) => keys.map((key) => key !== undefined)),
            ),
            [one.client, ...one.contacts].map(() => one.touch !== "none"),
            one.client,
          );
        const after = yield* ImportFile.runs([rhea], { orgId });
        assert.strictEqual(after.runs[0]?.undone?.by, ownerId);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "puts each contact under the company its own row names, however alike the names and emails",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const pad = (value: number, width: number) => String(value).padStart(width, "0");
        // Every email at one domain, as a test file or a shared mail host has them.
        const person = (n: number) =>
          [`Fenvale Contact ${pad(n, 4)}`, `fenvale${pad(n, 4)}@example.invalid`] as const;
        const bring = Effect.fn("test.bring")(function* (
          text: string,
          name: string,
          columns: ReadonlyArray<KinImportTarget>,
        ) {
          const file = fileOf(text, name);
          const checked = yield* ImportFile.check([rhea], { orgId, file, mapping: { columns } });
          assert.isTrue(checked.ready);
          const applied = yield* ImportFile.apply([rhea], {
            orgId,
            file,
            mapping: { columns },
            batch: checked.batch,
          });
          return { checked, applied };
        });
        const underWhom = sql<{ contact: string; client: string }>`SELECT c.title AS contact,
            p.title AS client FROM kin_records c JOIN kin_records p
            ON p.org_id = c.org_id AND p.record_id = c.party_id
          WHERE c.org_id = ${orgId} AND c.register_id = 'contacts' AND p.title LIKE 'Fenmere%'
          ORDER BY c.title, p.title`;

        // 5 contacts at each of 200 companies whose names differ only in their last digits.
        const first = Array.from({ length: 1_000 }, (_, index) => {
          const [contact, email] = person(index + 1);
          return { contact, email, client: `Fenmere Works ${pad(Math.floor(index / 5) + 1, 3)}` };
        });
        const one = yield* bring(
          `Name,Client,Role,Main email\n${first
            .map((row) => `${row.contact},${row.client},Buyer,${row.email}`)
            .join("\n")}\n`,
          "fenmere.csv",
          ["contact.name", "client.name", "contact.role", "contact.email"],
        );
        const made = { prospects: 0, clients: 200, contacts: 1_000, deals: 0 };
        assert.deepStrictEqual([one.checked.will, one.applied.added], [made, made]);
        assert.deepStrictEqual(
          yield* underWhom,
          first.map((row) => ({ contact: row.contact, client: row.client })),
        );

        // A second file at the same domain: new names that differ from Kin's only in digits are
        // new companies; one Kin has, written in another case and spacing, is that one.
        const header = "Name,Client,Role,Main email,Phone,Status,Deal,Stage";
        const second = [
          ...[201, 202, 203, 204].flatMap((company) =>
            Array.from({ length: 5 }, (_, index) => {
              const [contact, email] = person(company * 10 + index);
              const lead = index === 0 && company <= 202;
              return {
                line: `${contact},Fenmere Works ${company},Buyer,${email},,${lead && company === 201 ? "Prospect" : ""},${lead ? `Pilot ${company}` : ""},${lead ? "In talks" : ""}`,
                contact,
                client: `Fenmere Works ${company}`,
              };
            }),
          ),
          ...(["FENMERE  works 001", "Fenmere Works - 001"] as const).map((client, index) => {
            const [contact, email] = person(5_000 + index);
            return {
              line: `${contact},${client},Buyer,${email},,,,`,
              contact,
              client: "Fenmere Works 001",
            };
          }),
          // Named in words, not digits, that Kin has nothing like.
          {
            line: `Harrow Contact,Fenmere Harrow Mills,Buyer,harrow@example.invalid,,,,`,
            contact: "Harrow Contact",
            client: "Fenmere Harrow Mills",
          },
        ];
        const two = yield* bring(
          `${header}\n${[
            ...second.map((row) => row.line),
            // No company named: with the row whose email it shares, as today.
            `,,,${person(2_021)[1]},+47 900 00 021,,,`,
            // No company and no email: left out, saying why.
            "Nobody Known,,Buyer,,,,,",
          ].join("\n")}\n`,
          "fenmere-more.csv",
          [
            "contact.name",
            "client.name",
            "contact.role",
            "contact.email",
            "contact.phone",
            "client.kind",
            "deal.title",
            "deal.stage",
          ],
        );
        const more = { prospects: 1, clients: 4, contacts: 23, deals: 2 };
        assert.deepStrictEqual([two.checked.will, two.applied.added], [more, more]);
        assert.deepStrictEqual(
          [two.checked.matches.map((match) => [match.name, match.by]), two.checked.decide],
          [[["FENMERE  works 001", "name"]], []],
        );
        assert.strictEqual(two.applied.matched, 1);
        assert.deepStrictEqual(
          two.applied.leftOut.map((left) => left.reason),
          ["This row names no client and no email, so Kin can't tell whose it is."],
        );
        assert.deepStrictEqual(
          yield* underWhom,
          [...first, ...second]
            .map((row) => ({ contact: row.contact, client: row.client }))
            .toSorted((a, b) => (a.contact < b.contact ? -1 : a.contact > b.contact ? 1 : 0)),
        );
        const [phoned] = yield* sql<{ phone: string }>`SELECT
            json_extract(fields_json, '$.phone') AS phone FROM kin_records
          WHERE org_id = ${orgId} AND title = ${person(2_021)[0]}`;
        assert.strictEqual(phoned?.phone, "+47 900 00 021");
        const deals = yield* sql<{ deal: string; client: string; category: string }>`SELECT
            d.title AS deal, p.title AS client, p.category FROM kin_records d JOIN kin_records p
            ON p.org_id = d.org_id AND p.record_id = d.party_id
          WHERE d.org_id = ${orgId} AND d.register_id = 'deals' ORDER BY d.title`;
        assert.deepStrictEqual(
          deals.map((deal) => [deal.deal, deal.client, deal.category]),
          [
            ["Pilot 201", "Fenmere Works 201", "prospect"],
            ["Pilot 202", "Fenmere Works 202", "client"],
          ],
        );

        // Undo takes away exactly what the second file made.
        const undone = yield* ImportFile.undo([rhea], { orgId, batch: two.checked.batch });
        assert.deepStrictEqual(undone.removed, { clients: 5, contacts: 23, deals: 2, other: 0 });
        assert.deepStrictEqual(
          yield* underWhom,
          first.map((row) => ({ contact: row.contact, client: row.client })),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "is the owner level's: a co-owner brings a file in, a teammate is refused at every call",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const file = fileOf("Company\nInvented Fjord Labs\n");
        const columns = ["client.name" as const];
        const checked = yield* ImportFile.check([meera], { orgId, file, mapping: { columns } });
        const applied = yield* ImportFile.apply([meera], {
          orgId,
          file,
          mapping: { columns },
          batch: checked.batch,
        });
        assert.strictEqual(applied.added.clients, 1);
        const refused = "not_allowed: Only the owner or a co-owner brings a file in.";
        assert.deepStrictEqual(
          [
            yield* refusal(ImportFile.check([zoya], { orgId, file })),
            yield* refusal(
              ImportFile.apply([zoya], { orgId, file, mapping: { columns }, batch: checked.batch }),
            ),
            yield* refusal(ImportFile.undo([zoya], { orgId, batch: checked.batch })),
            yield* refusal(ImportFile.runs([zoya], { orgId })),
          ],
          [refused, refused, refused, refused],
        );
        // A different file under the checked batch's name is refused before anything is written.
        assert.strictEqual(
          yield* refusal(
            ImportFile.apply([rhea], {
              orgId,
              file: fileOf("Company\nInvented Other\n"),
              mapping: { columns },
              batch: checked.batch,
            }),
          ),
          "invalid_state: This isn't the file you checked. Check it again before importing.",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "shows the owner level a run going on, by whom and how far, and one that stopped where it stopped",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const imports = yield* KinImport.KinImport;
        const sql = yield* SqlClient.SqlClient;
        const linesFor = (batch: string) => [
          JSON.stringify({ format: "kin-import", version: 1, batch, source: "Old CRM" }),
          ...Array.from({ length: 150 }, (_, index) =>
            JSON.stringify({
              client: { source: `c${index}`, name: `Invented Firm ${batch} ${index}` },
            }),
          ),
        ];
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const progress = (done: number) =>
          done !== 99
            ? Effect.void
            : Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)));
        const going = yield* imports
          .apply(orgId, ownerId, Stream.fromIterable(linesFor("going")), {
            progress,
            file: "old-crm.csv",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(paused);
        const checking = yield* Deferred.make<void>();
        const checked = yield* Deferred.make<void>();
        const check = yield* imports
          .plan(orgId, ownerId, Stream.fromIterable(linesFor("next")), {
            progress: (done) =>
              done !== 99
                ? Effect.void
                : Deferred.succeed(checking, undefined).pipe(
                    Effect.andThen(Deferred.await(checked)),
                  ),
            file: "next.csv",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(checking);
        // A co-owner opening Import sees Rhea's import and check and how far each is; neither is
        // listed as done.
        const mid = yield* ImportFile.runs([meera], { orgId });
        assert.deepStrictEqual(
          mid.running?.map((one) => [one.action, one.by, one.file, one.done, one.of]),
          [
            ["apply", ownerId, "old-crm.csv", 99, 150],
            ["check", ownerId, "next.csv", 99, 150],
          ],
        );
        assert.deepStrictEqual(mid.runs, []);
        yield* Deferred.succeed(resume, undefined);
        yield* Deferred.succeed(checked, undefined);
        yield* Fiber.join(going);
        yield* Fiber.join(check);
        const after = yield* ImportFile.runs([rhea], { orgId });
        assert.deepStrictEqual(after.running, []);
        assert.deepStrictEqual(
          after.runs.map((one) => [one.batch, one.added.clients, one.stopped]),
          [["going", 150, undefined]],
        );

        // Cut off part way, as a restart leaves it: what came in stays, the
        // run says where it stopped, and importing it again brings the rest.
        const whole = Stream.fromIterable(linesFor("cut"));
        let reads = 0;
        const breaking = Stream.unwrap(
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? whole
              : Stream.concat(
                  whole.pipe(Stream.take(120)),
                  Stream.fail(new KinChatError({ reason: "unavailable", message: "stopped" })),
                );
          }),
        );
        yield* imports.apply(orgId, ownerId, breaking, { file: "cut.csv" }).pipe(Effect.flip);
        const cut = (yield* ImportFile.runs([rhea], { orgId })).runs.find(
          (one) => one.batch === "cut",
        );
        assert.deepStrictEqual(
          [cut?.file, cut?.added.clients, cut?.stopped, cut?.undone],
          ["cut.csv", 119, { done: 119, of: 150 }, null],
        );
        // A check's row its host isn't running, as a stop leaves one, is neither going nor done.
        yield* sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at,
            summary_json)
          VALUES (${orgId}, 'cut', 'check', ${ownerId}, ${NOW}, '{"done":40,"rows":150}')`;
        const left = yield* ImportFile.runs([rhea], { orgId });
        assert.deepStrictEqual(left.running, []);
        assert.deepStrictEqual(
          left.runs.find((one) => one.batch === "cut"),
          cut,
        );
      }).pipe(Effect.provide(layer)),
  );
});
