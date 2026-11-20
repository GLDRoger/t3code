import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId, type KinPulseFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Chat from "../chat/layer.ts";
import * as KinPulse from "./KinPulse.ts";

// Invented company, people, clients and deals only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const rhea = KinPersonId.make("rhea");
const zoya = KinPersonId.make("zoya");
const arjun = KinPersonId.make("arjun");
const dev = KinPersonId.make("dev");
const chief = KinAgentId.make("cos");
const growth = KinAgentId.make("growth");
/** Sunday 1 November 2026, 00:00 UTC. */
const B = Date.UTC(2026, 10, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday 2 November, 08:00 UTC: Zoya's day starts. */
const MONDAY = B + DAY + 8 * HOUR;
const stamp = "2026-10-01T00:00:00.000Z";

const chatLayer = Chat.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

interface Entry {
  readonly id: string;
  readonly list: string;
  readonly title: string;
  readonly ownerKind?: string;
  readonly ownerId?: string;
  readonly partyId?: string;
  readonly category?: string;
  readonly state?: string;
  readonly dueAt?: number;
  readonly createdAt?: number;
  readonly closedAt?: number;
  readonly origin?: string;
  readonly side?: "ours" | "theirs";
  readonly fields?: object;
}

const insert = Effect.fn("test.insert")(function* (entry: Entry) {
  const sql = yield* SqlClient.SqlClient;
  const created = entry.createdAt ?? B;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, category, party_id, due_at, due_all_day, created_by_kind, created_by_id,
      origin_key, created_at, updated_at, fields_json, closed_at)
    VALUES (${orgId}, ${`r-${entry.id}`}, ${entry.list}, ${entry.id}, ${entry.title},
      ${entry.state ?? "open"}, ${entry.ownerKind ?? "person"}, ${entry.ownerId ?? zoya},
      ${entry.side ?? "ours"},
      ${entry.category ?? null}, ${entry.partyId === undefined ? null : `r-${entry.partyId}`},
      ${entry.dueAt ?? null}, ${entry.dueAt === undefined ? 0 : 1}, 'person', ${rhea},
      ${entry.origin ?? `origin-${entry.id}`}, ${created}, ${created},
      ${entry.fields === undefined ? (entry.list === "deals" ? '{"stage":"new"}' : "{}") : JSON.stringify(entry.fields)},
      ${entry.closedAt ?? null})`;
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, sees_clients,
      created_at)
    VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', 'owner', 0, ${stamp}),
      (${zoya}, ${orgId}, 'zoya', 'Zoya', 'member', 1, ${stamp}),
      (${arjun}, ${orgId}, 'arjun', 'Arjun', 'member', 1, ${stamp}),
      (${dev}, ${orgId}, 'dev', 'Dev', 'member', 0, ${stamp})`;
  for (const [agent, domain] of [
    [chief, "chief-of-staff"],
    [growth, "growth"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent}, 'lead', ${rhea}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  for (const person of [zoya, arjun, dev])
    yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
      VALUES (${orgId}, ${chief}, ${person}, ${rhea}, 0)`;
  for (const [id, prefix] of [
    ["clients", "C"],
    ["deals", "DL"],
    ["work", "W"],
    ["projects", "P"],
    ["docs", "D"],
  ] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;
  yield* insert({ id: "C-1", list: "clients", title: "Corran Tiles", category: "client" });
  // Expected by Sunday 8 November, the end of that day in the company's zone.
  yield* insert({
    id: "DL-1",
    list: "deals",
    title: "Stock and orders system",
    partyId: "C-1",
    dueAt: Date.UTC(2026, 10, 9) - 1,
  });
});

const read = (at: number, viewer: KinPulse.Viewer = { _tag: "owner" }) =>
  KinPulse.read({ orgId, at, viewer, includeHandled: true, limit: 200 });
const asZoya = (at: number) => read(at, { _tag: "people", people: [zoya] });
/** The pages Kin posted in someone's direct chat with the Chief of staff, oldest first. */
const pagesTo = Effect.fn("test.pagesTo")(function* (personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ body: string; form: string | null }>`SELECT m.body, m.form
    FROM kin_messages m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND c.direct_key = ${`${personId}:${chief}`}
      AND m.author_kind = 'system' AND m.status = 'posted' AND m.form = 'brief'
    ORDER BY m.seq`;
});
const tickAt = (at: number) => TestClock.setTime(at).pipe(Effect.andThen(KinPulse.tick(orgId, at)));

/** Kin's own notices to someone that aren't a page: a holder's late or due work. */
const noticesTo = Effect.fn("test.noticesTo")(function* (personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ body: string }>`SELECT m.body
    FROM kin_messages m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND c.direct_key = ${`${personId}:${chief}`}
      AND m.author_kind = 'system' AND m.status = 'posted' AND m.form IS NULL
    ORDER BY m.seq`).map((row) => row.body);
});

/** A follow-up far ahead keeps the seeded deal quiet in every test here. */
const stepFarAhead = Effect.fn("test.stepFarAhead")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* insert({
    id: "W-1",
    list: "work",
    title: "Call about the order",
    category: "task",
    partyId: "C-1",
    dueAt: Date.UTC(2027, 0, 30),
  });
  yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation, created_at)
    VALUES (${orgId}, 'r-W-1', 'record', 'r-DL-1', 'relates', ${B})`;
});

const promiseOf = (
  id: string,
  title: string,
  side: "ours" | "theirs",
  dueAt: number,
  extra: Partial<Entry> = {},
) =>
  insert({
    id,
    list: "work",
    title,
    category: "obligation",
    partyId: "C-1",
    side,
    dueAt,
    ...extra,
  });

describe("promises both ways", () => {
  it.effect(
    "her page lists what she promised this week and what clients owe her that is late, each once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* stepFarAhead();
        // Monday 2 November: one of hers due today, one Thursday; Corran owed one by Friday and
        // owes another Wednesday. A plain follow-up today is still a follow-up.
        yield* promiseOf("W-5", "Signed order form", "theirs", Date.UTC(2026, 10, 1) - 1 - DAY);
        yield* promiseOf("W-6", "Send the plan", "ours", Date.UTC(2026, 10, 2, 15));
        yield* promiseOf("W-7", "Staff list", "theirs", Date.UTC(2026, 10, 5) - 1);
        yield* promiseOf("W-8", "Book the training day", "ours", Date.UTC(2026, 10, 6) - 1);
        yield* insert({
          id: "W-9",
          list: "work",
          title: "Call Lena",
          category: "task",
          partyId: "C-1",
          dueAt: Date.UTC(2026, 10, 2, 16),
        });
        yield* tickAt(MONDAY);
        assert.deepStrictEqual(yield* pagesTo(zoya), [
          {
            form: "brief",
            body: [
              "## Needs you",
              "",
              "- W-9 Call Lena, due today",
              "",
              "## Clients",
              "",
              "- Follow-ups today: 1.",
              "- Promised this week: 2.",
              "- Send the plan for Corran Tiles, due today.",
              "- Book the training day for Corran Tiles, by Thu 5 Nov.",
              "- Corran Tiles owed Signed order form by Fri 30 Oct.",
              "",
              "## Coming up",
              "",
              "- Staff list from Corran Tiles, by Wed 4 Nov.",
              "- Stock and orders system for Corran Tiles is expected by Sun 8 Nov.",
            ].join("\n"),
          },
        ]);
        // What the page told, no notice tells again; later that day and the next, nothing new.
        yield* tickAt(MONDAY + HOUR);
        yield* tickAt(MONDAY + 3 * HOUR);
        assert.deepStrictEqual(yield* noticesTo(zoya), []);
        // The staff list comes due and passes: told once, by Kin's notice, between pages.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_records SET state = 'done' WHERE key IN ('W-6', 'W-8', 'W-9')`;
        const late = Date.UTC(2026, 10, 5, 15);
        yield* tickAt(late);
        yield* tickAt(late + HOUR);
        assert.deepStrictEqual(yield* noticesTo(zoya), ["W-7 Staff list was due yesterday."]);
        // Nobody else hears any of it.
        for (const person of [arjun, dev, rhea]) {
          assert.lengthOf(yield* pagesTo(person), 0, person);
          assert.lengthOf(yield* noticesTo(person), 0, person);
        }
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a notice day is one fact from the heads-up to the renewal, for whoever looks after the client, and clears when the dates change or the project ends",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* stepFarAhead();
        const sql = yield* SqlClient.SqlClient;
        // The deal is expected next year and has moved lately: nothing else about it to tell.
        yield* sql`UPDATE kin_records SET due_at = ${Date.UTC(2027, 5, 1)},
          updated_at = ${Date.UTC(2026, 11, 16)} WHERE record_id = 'r-DL-1'`;
        // 60 days' notice before 1 March: by 31 December, told from 17 December.
        yield* insert({
          id: "P-1",
          list: "projects",
          title: "Rota system",
          partyId: "C-1",
          ownerId: rhea,
          fields: { renewsOn: "2027-03-01", noticeDays: "60" },
        });
        const notices = (facts: ReadonlyArray<KinPulseFact>) =>
          facts.filter((fact) => fact.sense === "notice_due" && fact.handled === null);
        assert.lengthOf(notices((yield* read(Date.UTC(2026, 11, 17) - 1)).facts), 0);
        const first = notices((yield* read(Date.UTC(2026, 11, 17))).facts);
        assert.deepStrictEqual(
          first.map((fact) => [fact.key, fact.subject.key, fact.actor, fact.consequence]),
          [
            [
              "notice_due:P-1:on=2026-12-31",
              "C-1",
              { _tag: "person", personId: zoya },
              "Corran Tiles: notice by Thu 31 Dec if the contract changes; Rota system renews Mon 1 Mar.",
            ],
          ],
        );
        // Passed, while the renewal is still ahead; gone once it has renewed.
        const passed = notices((yield* read(Date.UTC(2027, 0, 2, 9))).facts);
        assert.strictEqual(
          passed[0]?.consequence,
          "Corran Tiles: notice was due by Thu 31 Dec, 2 days ago; Rota system renews Mon 1 Mar.",
        );
        assert.lengthOf(notices((yield* read(Date.UTC(2027, 2, 2) - 1)).facts), 1);
        assert.lengthOf(notices((yield* read(Date.UTC(2027, 2, 2))).facts), 0);
        // Zoya reads it; Arjun (Clients on, not hers), Dev (Clients off) don't.
        const at = Date.UTC(2026, 11, 20);
        assert.lengthOf(notices((yield* asZoya(at)).facts), 1);
        for (const person of [arjun, dev])
          assert.lengthOf(
            notices((yield* read(at, { _tag: "people", people: [person] })).facts),
            0,
          );
        // Thursday 17 December, 08:00: once, on her page; the next morning, not again.
        const thursday = Date.UTC(2026, 11, 17, 8);
        yield* tickAt(thursday);
        yield* tickAt(thursday + DAY);
        const pages = (yield* pagesTo(zoya)).map((page) => page.body);
        assert.lengthOf(pages, 1);
        assert.include(pages[0], "- Corran Tiles: notice by Thu 31 Dec if the contract changes;");
        // Renewed for a year, its notice days changed, or the project ended: no fact.
        for (const change of [
          sql`UPDATE kin_records SET fields_json = '{"renewsOn":"2028-03-01","noticeDays":"60"}'
            WHERE record_id = 'r-P-1'`,
          sql`UPDATE kin_records SET fields_json = '{"renewsOn":"2027-03-01","noticeDays":"30"}'
            WHERE record_id = 'r-P-1'`,
          sql`UPDATE kin_records SET fields_json = '{"renewsOn":"2027-03-01"}'
            WHERE record_id = 'r-P-1'`,
          sql`UPDATE kin_records SET fields_json = '{"renewsOn":"2027-03-01","noticeDays":"60"}',
            state = 'done' WHERE record_id = 'r-P-1'`,
        ]) {
          yield* change;
          assert.lengthOf(notices((yield* read(at)).facts), 0);
        }
        // A client looked after by an agent: the project's lead hears it; an agent's project
        // too, or a lead who left: the owner.
        yield* sql`UPDATE kin_records SET state = 'open' WHERE record_id = 'r-P-1'`;
        yield* sql`UPDATE kin_records SET owner_kind = 'agent', owner_id = ${growth}
          WHERE record_id = 'r-C-1'`;
        const actors = Effect.map(read(at), (read) =>
          notices(read.facts).map((fact) => fact.actor),
        );
        assert.deepStrictEqual(yield* actors, [{ _tag: "person", personId: rhea }]);
        yield* sql`UPDATE kin_records SET owner_kind = 'agent', owner_id = ${growth}
          WHERE record_id = 'r-P-1'`;
        assert.deepStrictEqual(yield* actors, [{ _tag: "owner" }]);
        yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${rhea}
          WHERE record_id = 'r-P-1'`;
        // A private project's notice day is the owner level's alone.
        yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${zoya},
          sensitive = 0 WHERE record_id = 'r-C-1'`;
        yield* sql`UPDATE kin_records SET sensitive = 1 WHERE record_id = 'r-P-1'`;
        assert.lengthOf(notices((yield* asZoya(at)).facts), 0);
        assert.lengthOf(notices((yield* read(at)).facts), 1);
      }).pipe(Effect.provide(chatLayer)),
  );
});
