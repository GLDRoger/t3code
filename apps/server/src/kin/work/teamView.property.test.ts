// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  kinApplyWorkCounts,
  kinApplyWorkRow,
  kinPatchWorkPage,
  kinRestoreWorkList,
  kinWorkHeldPage,
  kinWorkRowsStart,
  type KinWorkEvent,
  type KinWorkHeldPage,
  type KinWorkListInput,
  type KinWorkRows,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "./KinRecords.ts";
import { formatMoney, formatMoneyPlain } from "./money.ts";
import * as PulsePeople from "../pulse/people.ts";
import * as OwnerDocs from "./ownerDocs.ts";
import * as OwnerMoney from "./ownerMoney.ts";
import * as OwnerClients from "./ownerClients.ts";
import * as OwnerWork from "./ownerWork.ts";
import * as WorkStream from "./workStream.ts";
import { search } from "./search.ts";
import { indexWhere, searchIndexed } from "./searchIndex.ts";
import { listDef } from "./registers.ts";
import {
  personSees,
  teamCan,
  unreadableBy,
  viewerOfPeople,
  withoutOwnFigures,
} from "./teamView.ts";

// Invented org, people and entries only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const MEMBERS = ["ana", "ben"] as const;
/** A co-owner, who reads at the owner's level; only Work's live stream tests look at her. */
const CO_OWNER = "cora";
type Member = (typeof MEMBERS)[number];
type Who = "owner" | Member | "agent";

const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
const pickOrNull = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.NullOr(Schema.Literals(literals)));
const flag = Arbitrary.schema(Schema.Boolean);
const someOf = Arbitrary.all([flag, flag]).pipe(
  Arbitrary.map(([ana, ben]) => MEMBERS.filter((_, i) => [ana, ben][i])),
);

/** Built-in lists, a money list labelled sensitive by default, and a plain defined list. */
const LISTS = ["work", "milestones", "docs", "contacts", "invoices", "notes"] as const;
const SENSITIVE_BY_DEFAULT = new Set(["invoices"]);

const entry = Arbitrary.all({
  list: pick(LISTS),
  owner: pick(["owner", "ana", "ben", "agent"]),
  createdBy: pick(["owner", "ana", "ben", "agent"]),
  assignedBy: pickOrNull(["owner", "ana", "ben"]),
  sensitive: flag,
  shared: flag,
  project: pickOrNull(["p1", "p2"]),
  party: pickOrNull(["c1", "c2"]),
  attendees: someOf,
  alsoOn: someOf,
  company: flag,
  title: pick(["Plan launch", "Fix login", "Call vendor"]),
});
type Entry = typeof entry extends Arbitrary.Arbitrary<infer A> ? A : never;

const project = Arbitrary.all({
  lead: pick(["owner", "ana", "ben", "agent"]),
  party: pickOrNull(["c1", "c2"]),
  members: someOf,
  sensitive: flag,
  shared: flag,
});
const client = Arbitrary.all({ sensitive: flag, shared: flag });
const places = Arbitrary.all({ clients: flag, docs: flag, money: flag });

const world = Arbitrary.all({
  clients: Arbitrary.all([client, client]),
  projects: Arbitrary.all([project, project]),
  places: Arbitrary.all([places, places]),
  entries: Arbitrary.array(entry, { maxLength: 8 }),
});
type World = typeof world extends Arbitrary.Arbitrary<infer A> ? A : never;

const at = 1_800_000_000_000;
const principal = (who: Who) =>
  who === "agent" ? (["agent", "lead"] as const) : (["person", who] as const);

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-team-view-" })),
  Layer.provideMerge(NodeServices.layer),
);

const REGISTERS = [
  ["work", "T", 1, "{}"],
  ["milestones", "M", 1, "{}"],
  ["docs", "D", 1, "{}"],
  ["clients", "C", 1, "{}"],
  ["contacts", "P", 1, "{}"],
  ["projects", "J", 1, "{}"],
  ["invoices", "INV", 0, `{"sensitive":true}`],
  ["notes", "N", 0, "{}"],
] as const;

const once = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [made] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_orgs`;
  if ((made?.n ?? 0) > 0) return;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-11')`;
  for (const person of [ownerId, ...MEMBERS, CO_OWNER])
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${person}, ${orgId}, ${person}, ${person}, '2026-11-11',
        ${person === ownerId ? "owner" : person === CO_OWNER ? "co_owner" : "member"})`;
  for (const member of [...MEMBERS, CO_OWNER])
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES (${`session-${member}`}, ${orgId}, ${member}, 0)`;
  for (const [id, prefix, builtIn, definition] of REGISTERS)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json) VALUES (${orgId}, ${id}, ${id}, ${prefix}, ${builtIn}, ${at},
        ${definition})`;
});

type Row = {
  readonly id: string;
  readonly list: string;
  readonly owner: Who;
  readonly createdBy: Who;
  readonly assignedBy: Who | null;
  readonly sensitive: boolean;
  readonly shared: boolean;
  readonly project: string | null;
  readonly party: string | null;
  readonly fields: Record<string, unknown>;
  readonly title: string;
};

const rowsOf = (w: World): ReadonlyArray<Row> => [
  ...w.clients.map((c, i) => ({
    id: `c${i + 1}`,
    list: "clients",
    owner: "owner" as const,
    createdBy: "owner" as const,
    assignedBy: null,
    sensitive: c.sensitive,
    shared: c.shared,
    project: null,
    party: null,
    fields: {},
    title: `Client ${i + 1}`,
  })),
  ...w.projects.map((p, i) => ({
    id: `p${i + 1}`,
    list: "projects",
    owner: p.lead,
    createdBy: "owner" as const,
    assignedBy: null,
    sensitive: p.sensitive,
    shared: p.shared,
    project: null,
    party: p.party,
    fields: { members: p.members.map((m) => `person:${m}`) },
    title: `Project ${i + 1}`,
  })),
  ...w.entries.map((e: Entry, i) => ({
    id: `e${i + 1}`,
    list: e.list,
    owner: e.owner,
    createdBy: e.createdBy,
    assignedBy: e.assignedBy,
    sensitive: e.sensitive,
    shared: e.shared,
    project: e.project,
    party: e.party,
    fields: {
      attendees: e.attendees.map((m) => `person:${m}`),
      ...(e.list === "work" && e.alsoOn.some((m) => m !== e.owner)
        ? { alsoOn: e.alsoOn.filter((m) => m !== e.owner).map((m) => `person:${m}`) }
        : {}),
      ...(e.company ? { home: "company" } : {}),
    },
    title: `${e.title} ${i + 1}`,
  })),
];

/** `p1` is stored as P-1, as Kin numbers keys. */
const keyOf = (id: string) => id.toUpperCase().replace(/^([A-Z]+)(\d+)$/, "$1-$2");

/** Replaces the org's entries and the members' places with this world. */
const install = (w: World, extra: ReadonlyArray<Row> = []) =>
  Effect.gen(function* () {
    yield* once;
    const sql = yield* SqlClient.SqlClient;
    // A history's writes leave changes, links and notices that hold on to their entries.
    yield* sql`DELETE FROM kin_search WHERE rowid IN (SELECT id FROM kin_search_rows
      WHERE org_id = ${orgId})`.pipe(Effect.ignore);
    for (const table of [
      "kin_record_changes",
      "kin_record_links",
      "kin_search_rows",
      "kin_client_touches",
      "kin_record_payments",
    ])
      yield* sql`DELETE FROM ${sql(table)} WHERE org_id = ${orgId}`;
    yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId}`;
    yield* sql`UPDATE kin_people SET access = CASE person_id WHEN ${ownerId} THEN 'owner'
        WHEN ${CO_OWNER} THEN 'co_owner' ELSE 'member' END WHERE org_id = ${orgId}`;
    for (const [i, member] of MEMBERS.entries()) {
      const p = w.places[i]!;
      yield* sql`UPDATE kin_people SET sees_clients = ${p.clients ? 1 : 0},
          sees_docs = ${p.docs ? 1 : 0}, sees_money = ${p.money ? 1 : 0}
        WHERE person_id = ${member}`;
    }
    for (const row of [...rowsOf(w), ...extra]) {
      const [ownerKind, owner] = principal(row.owner);
      const [createdKind, createdBy] = principal(row.createdBy);
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, party_id, project_id, sensitive, team_shared, fields_json, created_by_kind,
          created_by_id, assigned_by_person_id, origin_key, created_at, updated_at)
        VALUES (${orgId}, ${row.id}, ${row.list}, ${keyOf(row.id)}, ${row.title},
          ${ownerKind}, ${owner}, ${row.party}, ${row.project}, ${row.sensitive ? 1 : 0},
          ${row.shared ? 1 : 0}, ${JSON.stringify(row.fields)}, ${createdKind}, ${createdBy},
          ${row.assignedBy}, ${row.id}, ${at}, ${at})`;
    }
    if (yield* searchIndexed()) yield* indexWhere(sql, sql`r.org_id = ${orgId}`);
  });

const seen = (viewer: Member) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string }>`SELECT r.record_id AS id FROM kin_records r
      WHERE r.org_id = ${orgId} AND ${personSees(sql, KinPersonId.make(viewer))}`;
    return new Set(rows.map((row) => row.id));
  });

/** The owner's own label: not one a list puts on every entry by default. */
const ownLabel = (row: Row) => row.sensitive && !SENSITIVE_BY_DEFAULT.has(row.list);
const holdsOrAttends = (row: Row, viewer: Member) =>
  row.list === "work" &&
  (row.owner === viewer ||
    (row.fields["attendees"] as Array<string>).includes(`person:${viewer}`) ||
    ((row.fields["alsoOn"] ?? []) as Array<string>).includes(`person:${viewer}`));

// Every entry carries an amount no other value has; one she may not see must appear nowhere.
const canary = (index: number) => 98_765_400_017 + index * 10_301;
const canaryTexts = (minor: number) => [
  String(minor),
  (minor / 100).toFixed(2),
  formatMoney({ minor, currency: "INR" }),
  formatMoneyPlain({ minor, currency: "INR" }),
];
const leaks = (payload: unknown, minor: number): boolean => {
  if (typeof payload === "number") return payload === minor || payload === minor / 100;
  if (typeof payload === "string") return canaryTexts(minor).some((text) => payload.includes(text));
  if (Array.isArray(payload)) return payload.some((one) => leaks(one, minor));
  if (payload !== null && typeof payload === "object")
    return Object.values(payload).some((one) => leaks(one, minor));
  return false;
};

layer(testLayer)("what a teammate sees and is told", (it) => {
  it.effect.prop(
    "a member never sees an entry the owner labelled private unless they hold or attend it",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        yield* install(w);
        for (const viewer of MEMBERS) {
          const sees = yield* seen(viewer);
          for (const row of rowsOf(w))
            if (sees.has(row.id) && ownLabel(row))
              assert.isTrue(holdsOrAttends(row, viewer), `${viewer} sees ${row.id}`);
        }
      }),
  );

  it.effect.prop(
    "a project's lead never sees what the owner labelled private in it, its client included",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        yield* install(w);
        const rows = rowsOf(w);
        for (const [i, p] of w.projects.entries()) {
          if (p.lead === "owner" || p.lead === "agent") continue;
          const sees = yield* seen(p.lead);
          const inIt = (row: Row) =>
            row.id === `p${i + 1}` ||
            row.project === `p${i + 1}` ||
            (row.list === "clients" && row.id === p.party);
          for (const row of rows.filter(inIt))
            if (sees.has(row.id) && ownLabel(row))
              assert.isTrue(holdsOrAttends(row, p.lead), `lead ${p.lead} sees ${row.id}`);
        }
      }),
  );

  // Entries held by someone else, outside every project, can't change what a member sees.
  const noise = Arbitrary.array(
    Arbitrary.all({
      list: pick(LISTS),
      owner: pick(["owner", "agent"]),
      createdBy: pick(["owner", "agent"]),
      sensitive: flag,
      shared: flag,
      party: pickOrNull(["c1", "c2"]),
    }),
    { minLength: 1, maxLength: 4 },
  );
  it.effect.prop(
    "what a member sees of an entry depends on it, their places and their projects alone",
    [world, noise],
    ([w, extra]) =>
      Effect.gen(function* () {
        yield* install(w);
        const before = yield* Effect.forEach(MEMBERS, seen);
        const added: ReadonlyArray<Row> = extra.map((x, i) => ({
          ...x,
          id: `x${i + 1}`,
          assignedBy: null,
          project: null,
          fields: {},
          title: `Other ${i + 1}`,
        }));
        yield* install(w, added);
        const after = yield* Effect.forEach(MEMBERS, seen);
        for (const [i, member] of MEMBERS.entries()) {
          const kept = [...after[i]!].filter((id) => !id.startsWith("x"));
          assert.deepStrictEqual(kept.toSorted(), [...before[i]!].toSorted(), member);
        }
        // Ben's places, projects, tasks and meetings never change what Ana sees: handing all of
        // Ben's part to the owner leaves Ana's view as it was.
        const benGone = (who: Who): Who => (who === "ben" ? "owner" : who);
        const notBen = (people: ReadonlyArray<Member>) => people.filter((m) => m !== "ben");
        yield* install({
          clients: w.clients,
          places: [w.places[0]!, { clients: true, docs: true, money: true }],
          projects: [
            {
              ...w.projects[0],
              lead: benGone(w.projects[0].lead),
              members: notBen(w.projects[0].members),
            },
            {
              ...w.projects[1],
              lead: benGone(w.projects[1].lead),
              members: notBen(w.projects[1].members),
            },
          ],
          entries: w.entries.map((e) => ({
            ...e,
            owner: benGone(e.owner),
            createdBy: benGone(e.createdBy),
            assignedBy: e.assignedBy === "ben" ? "owner" : e.assignedBy,
            attendees: notBen(e.attendees),
            alsoOn: notBen(e.alsoOn),
          })),
        });
        assert.deepStrictEqual([...(yield* seen("ana"))].toSorted(), [...before[0]!].toSorted());
      }),
  );

  it.effect.prop(
    "a member's lists, counts and searches show only what personSees gives them",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        yield* install(w);
        const records = yield* KinRecords.KinRecords;
        for (const viewer of MEMBERS) {
          const team = KinPersonId.make(viewer);
          const sees = yield* seen(viewer);
          for (const list of ["work", "milestones", "docs", "invoices", "notes", "clients"]) {
            const { rows, total } = yield* records.query(orgId, { list, team, limit: 100 });
            const ids = rows.map((row) => row.recordId as string);
            assert.isTrue(
              ids.every((id) => sees.has(id)),
              `${viewer} lists ${ids.join(",")} in ${list}`,
            );
            const shown = rowsOf(w).filter((row) => row.list === list && sees.has(row.id));
            assert.isAtMost(total, shown.length, `${viewer} counts ${list}`);
            const groups = yield* records.groups(orgId, { list, team }, "state");
            const counted = groups.reduce((sum, group) => sum + group.count, 0);
            assert.isAtMost(counted, shown.length, `${viewer} groups ${list}`);
          }
          for (const word of ["plan", "fix", "call", "client", "project"]) {
            const { hits } = yield* search(orgId, {
              text: word,
              limit: 50,
              viewer: "team",
              scope: viewerOfPeople([team]),
              closed: true,
            });
            for (const hit of hits)
              assert.isTrue(sees.has(hit.recordId), `${viewer} finds ${hit.key}`);
          }
        }
        // Everything one search box finds, money entries included, opens for whoever found it.
        for (const viewer of [...MEMBERS, CO_OWNER, ownerId]) {
          const people = [{ _tag: "person" as const, orgId, personId: KinPersonId.make(viewer) }];
          for (const word of ["plan", "fix", "call", "client", "project"]) {
            const { hits } = yield* OwnerDocs.search(people, {
              orgId,
              text: word,
              everything: true,
              closed: true,
              limit: 50,
            });
            for (const hit of hits) {
              const opened = yield* Effect.result(
                OwnerWork.get(people, { orgId, recordId: hit.recordId }),
              );
              assert.strictEqual(
                opened._tag,
                "Success",
                `${viewer} finds ${hit.key}, can't open it`,
              );
            }
          }
        }
      }),
  );

  it.effect("a teammate finds a money entry exactly when Money shows it to her", () =>
    Effect.gen(function* () {
      const quiet = { sensitive: false, shared: false };
      const invoice: Entry = {
        list: "invoices",
        owner: "owner",
        createdBy: "owner",
        assignedBy: null,
        sensitive: true,
        shared: true,
        project: null,
        party: null,
        attendees: [],
        alsoOn: [],
        company: false,
        title: "Call vendor",
      };
      const found = (money: boolean) =>
        Effect.gen(function* () {
          yield* install({
            clients: [quiet, quiet],
            projects: [
              { lead: "owner", party: null, members: [], ...quiet },
              { lead: "owner", party: null, members: [], ...quiet },
            ],
            places: [
              { clients: false, docs: false, money },
              { clients: false, docs: false, money: false },
            ],
            entries: [invoice],
          });
          const people = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("ana") }];
          const { hits } = yield* OwnerDocs.search(people, {
            orgId,
            text: "vendor",
            everything: true,
          });
          return hits.map((hit) => [hit.kind, hit.key]);
        });
      assert.deepStrictEqual(yield* found(true), [["invoices", "E-1"]]);
      assert.deepStrictEqual(yield* found(false), []);
    }),
  );

  it.effect.prop(
    "no payload a teammate reads carries the amount of an entry she may not see",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        yield* install(w);
        const sql = yield* SqlClient.SqlClient;
        const rows = rowsOf(w);
        for (const [index, row] of rows.entries())
          yield* sql`UPDATE kin_records SET amount_minor = ${canary(index)}, currency = 'INR'
            WHERE org_id = ${orgId} AND record_id = ${row.id}`;
        for (const viewer of MEMBERS) {
          const personId = KinPersonId.make(viewer);
          const people = [{ _tag: "person" as const, orgId, personId }];
          const sees = yield* seen(viewer);
          const payloads: Array<unknown> = [
            yield* OwnerWork.summary(people, { orgId }),
            ...(yield* Effect.forEach(LISTS, (list) =>
              Effect.result(OwnerWork.list(people, { orgId, list, limit: 100 })),
            )),
            // The opt-in wire shapes screens ask for (`kinWire.ts`).
            ...(yield* Effect.forEach(LISTS, (list) =>
              Effect.result(
                OwnerWork.list(people, { orgId, list, limit: 100, acceptCompactRows: true }),
              ),
            )),
            yield* Effect.result(OwnerMoney.money(people, { orgId, upcomingRows: false })),
            yield* Effect.result(OwnerMoney.money(people, { orgId })),
            yield* Effect.result(OwnerDocs.list(people, { orgId, acceptSlimLatest: true })),
            yield* Effect.result(
              PulsePeople.read(people, { orgId, includeHandled: true, limit: 8 }),
            ),
            ...(yield* Effect.forEach(rows, (row) =>
              Effect.result(OwnerWork.get(people, { orgId, recordId: KinRecordId.make(row.id) })),
            )),
          ];
          for (const word of ["plan", "fix", "call", "client", "project", "98765"])
            payloads.push(
              yield* search(orgId, {
                text: word,
                limit: 50,
                viewer: "team",
                scope: viewerOfPeople([personId]),
                closed: true,
              }),
            );
          for (const [index, row] of rows.entries()) {
            if (sees.has(row.id)) continue;
            const minor = canary(index);
            for (const payload of payloads)
              assert.isFalse(leaks(payload, minor), `${viewer} reads ${row.id}'s amount`);
          }
        }
      }),
  );

  const int = (min: number, max: number) =>
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })));
  const number = Arbitrary.all([int(1, 999_999), pick(["", ",000", ".5", "00"])]).pipe(
    Arbitrary.map(([n, tail]) => `${n}${tail}`),
  );
  const WORDS = ["five", "twenty", "forty", "two hundred", "fifty-five", "one", "half a"];
  const said = Arbitrary.all([pick(WORDS), pick(["", " thousand", " and twenty"])]).pipe(
    Arbitrary.map(([word, more]) => `${word}${more}`),
  );
  const around = Arbitrary.all([
    pick(["", "Tell Ana ", "The client agreed to ", "FYI: "]),
    pick(["", " for the launch.", " by Friday", "."]),
  ]);
  const tell = (text: string) => unreadableBy(orgId, KinPersonId.make("ana"), text);

  it.effect.prop(
    "a message naming an amount, in figures or words, never goes to a teammate",
    [
      around,
      number,
      said,
      pick([
        "₹{n}",
        "$ {n}",
        "€{n}",
        "£{n}",
        "Rs. {n}",
        "rs{n}",
        "INR {n}",
        "USD{n}",
        "a budget of {n}k",
        "the fee is {n} K",
        "pay them {n}k",
        "{n}k for the invoice",
        "{n} lakh",
        "{n} lakhs",
        "{n} lacs",
        "{n} crore",
        "{n} cr",
        "{n} rupees",
        "{n} dollars",
        "{n} INR",
        "{n} bucks",
        "{w} rupees",
        "{w} lakh",
        "{w} crore",
        "{w} dollars",
        "Rupees {n}",
        "Rupees {w}",
        "{n}$",
        "{n} €",
      ]),
    ],
    ([[before, after], n, w, form]) =>
      Effect.gen(function* () {
        yield* install(emptyWorld);
        const text = `${before}${form.replace("{n}", n).replace("{w}", w)}${after}`;
        assert.isDefined(yield* tell(text), text);
      }),
  );

  it.effect("a figure that is a sum they can't see is refused, however it is written", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const invoice = (id: string, project: string) => ({
        ...rowsOf(emptyWorld)[0]!,
        id,
        list: "invoices",
        sensitive: true,
        project,
        title: `Invoice ${id}`,
      });
      yield* install(
        {
          ...emptyWorld,
          projects: [{ ...emptyWorld.projects[0]!, lead: "ana" }, emptyWorld.projects[1]!],
        },
        [
          invoice("hidden", "p2"),
          invoice("led", "p1"),
          invoice("yen", "p2"),
          invoice("dinar", "p2"),
        ],
      );
      // Minor units follow each currency's decimals: none for yen, three for the Kuwaiti dinar.
      yield* sql`UPDATE kin_records SET amount_minor = 150000, currency = 'JPY'
        WHERE record_id = 'yen'`;
      yield* sql`UPDATE kin_records SET amount_minor = 2750500, currency = 'KWD'
        WHERE record_id = 'dinar'`;
      yield* sql`UPDATE kin_records SET amount_minor = 98765400, currency = 'INR'
        WHERE record_id = 'hidden'`;
      yield* sql`UPDATE kin_records SET amount_minor = 4320000, currency = 'INR'
        WHERE record_id = 'led'`;
      yield* sql`UPDATE kin_records SET fields_json = '{"terms":"Retainer of 1,25,000 a month"}'
        WHERE record_id = 'c1'`;
      const to = (who: Member, text: string) => unreadableBy(orgId, KinPersonId.make(who), text);
      for (const text of [
        "The agreed price is 987654.",
        "The agreed price is 987.654,00 €.",
        "The agreed price is 987.654,00.",
        "The agreed price is nine hundred eighty-seven thousand six hundred fifty-four.",
        "They pay 125000 every month.",
        "The yen invoice is 150000.",
        "The dinar invoice is 2750.",
        "The dinar invoice is 2750.500.",
      ])
        assert.isDefined(yield* to("ana", text), text);
      // A count that is no hidden sum goes; a sum she may see, on the project she leads, goes too.
      assert.isUndefined(yield* to("ana", "We have 4321 users and 98 tasks."));
      assert.isUndefined(yield* to("ana", "We printed 1500 posters."));
      assert.isUndefined(yield* to("ana", "The milestone invoice is 43200."));
      assert.isDefined(yield* to("ben", "The milestone invoice is 43200."));
      // Ben's own words, relayed for him, are held only against what he sees: a refusal would
      // tell him his guess is some sum hidden from him.
      assert.isUndefined(
        yield* unreadableBy(
          orgId,
          KinPersonId.make("ana"),
          "Is it 987654?",
          KinPersonId.make("ben"),
        ),
      );
      // Her own figure is lifted out of what is held against her; an entry key's number never is.
      assert.strictEqual(
        withoutOwnFigures("INV-3 for 3 seats at 2,50,000", "3 seats at 250000"),
        "INV-3 for  seats at ",
      );
    }),
  );

  it.effect.prop(
    "a plain count goes through",
    [
      around,
      number,
      said,
      pick([
        "{w} users",
        "{n} users",
        "{n} tasks",
        "{w} people signed up",
        "{n} days",
        "version {n}",
        "{n} of the {n} pages",
        "at 5pm",
        "{n}k followers",
        "{n}k copies of the poster",
        "proof ab{n}k: can W-3 move",
        "run r{n}k",
      ]),
    ],
    ([[before, after], n, w, form]) =>
      Effect.gen(function* () {
        yield* install(emptyWorld);
        const text = `${before}${form.replaceAll("{n}", n).replace("{w}", w)}${after}`;
        assert.isUndefined(yield* tell(text), text);
      }),
  );

  it.effect(
    "a member on a private task sees it but can only leave, and only while on the team",
    () =>
      Effect.gen(function* () {
        const records = yield* KinRecords.KinRecords;
        const sql = yield* SqlClient.SqlClient;
        const task: Row = {
          id: "e1",
          list: "work",
          owner: "owner",
          createdBy: "owner",
          assignedBy: null,
          sensitive: true,
          shared: false,
          project: null,
          party: null,
          fields: { alsoOn: ["person:ana"] },
          title: "Plan launch 1",
        };
        yield* install(emptyWorld, [task]);
        const writer = (viewer: Member) => {
          const personId = KinPersonId.make(viewer);
          return {
            actor: { _tag: "person" as const, personId },
            via: "owner" as const,
            teammate: true,
          };
        };
        const renames = (viewer: Member) =>
          records
            .update(orgId, writer(viewer), "E-1", { title: "Plan launch again" })
            .pipe(Effect.exit);
        const leaves = (viewer: Member) =>
          records
            .update(orgId, writer(viewer), "E-1", { fields: { alsoOn: [] } })
            .pipe(Effect.exit);
        const edits = Effect.fn(function* (viewer: Member) {
          const detail = yield* records.detail((yield* records.getById(orgId, "e1"))!, 1);
          const can = yield* teamCan(orgId, KinPersonId.make(viewer), [
            { ...detail, states: ["open", "doing", "waiting", "done", "dropped"] },
          ]);
          return can.get(detail.recordId)!.edit;
        });
        assert.isTrue((yield* seen("ana")).has("e1"));
        assert.isFalse(yield* edits("ana"));
        assert.isTrue(Exit.isFailure(yield* renames("ana")));
        assert.isFalse((yield* seen("ben")).has("e1"));
        assert.isFalse(yield* edits("ben"));
        assert.isTrue(Exit.isFailure(yield* renames("ben")));
        assert.isTrue(Exit.isFailure(yield* leaves("ben")));
        const away = (gone: boolean) =>
          sql`UPDATE kin_session_bindings SET revoked_at = ${gone ? 1 : null}
          WHERE org_id = ${orgId} AND person_id = 'ana'`;
        yield* away(true);
        yield* Effect.gen(function* () {
          assert.isFalse(yield* edits("ana"));
          assert.isTrue(Exit.isFailure(yield* renames("ana")));
          assert.isTrue(Exit.isFailure(yield* leaves("ana")));
        }).pipe(Effect.ensuring(away(false).pipe(Effect.orDie)));
        assert.isTrue(Exit.isSuccess(yield* leaves("ana")));
        assert.isFalse((yield* seen("ana")).has("e1"));
      }),
  );

  it.effect.prop(
    "every control a teammate's sheet offers is one their write is let through",
    [world],
    ([w]) =>
      Effect.gen(function* () {
        const records = yield* KinRecords.KinRecords;
        const sql = yield* SqlClient.SqlClient;
        yield* install(w);
        for (const viewer of MEMBERS) {
          const personId = KinPersonId.make(viewer);
          const writer = {
            actor: { _tag: "person" as const, personId },
            via: "owner" as const,
            askedBy: personId,
            teammate: true,
          };
          for (const id of yield* seen(viewer)) {
            const row = yield* records.getById(orgId, id);
            // The world makes contacts under projects or with no client, which Kin never writes.
            if (
              row === undefined ||
              (row.registerId === "contacts" && (row.projectId !== null || row.partyId === null))
            )
              continue;
            const detail = yield* records.detail(row, 1);
            const def = yield* listDef(orgId, row.registerId);
            // `canOf` offers nothing on an entry whose list can't be read, such as this fake one.
            if (def === undefined) continue;
            const can = (yield* teamCan(orgId, personId, [{ ...detail, states: def.states }])).get(
              detail.recordId,
            )!;
            const led = rowsOf(w).find((r) => r.list === "projects" && r.owner === viewer);
            const other = viewer === "ana" ? "ben" : "ana";
            const writes: ReadonlyArray<readonly [boolean, KinRecords.Patch]> = [
              ...can.states.map((state) => [true, { state }] as const),
              [can.edit, { title: "Renamed" }],
              [can.project, { projectId: led?.id ?? null }],
              [can.clearProject, { projectId: null }],
              [can.give, { owner: { _tag: "person", personId: KinPersonId.make(other) } }],
              [can.takeBack, { owner: { _tag: "person", personId } }],
              [can.mark, { sensitive: true }],
            ];
            for (const [offered, patch] of writes) {
              if (!offered) continue;
              // Rolled back, so each write starts from the same world.
              let exit: Exit.Exit<unknown, unknown> = Exit.void;
              yield* sql
                .withTransaction(
                  records.update(orgId, writer, row.key, patch).pipe(
                    Effect.exit,
                    Effect.flatMap((out) => {
                      exit = out;
                      return Effect.fail("rolled back");
                    }),
                  ),
                )
                .pipe(Effect.ignore);
              // Closing a project with open work is refused for what it holds, not who asks.
              const held = Exit.isFailure(exit) && /still has \d+ open entries/.test(String(exit));
              assert.isTrue(
                Exit.isSuccess(exit) || held,
                `${viewer} offered ${JSON.stringify(patch)} on ${row.key}: ${String(exit)}`,
              );
            }
          }
        }
      }),
  );
});

const emptyWorld: World = {
  clients: [
    { sensitive: false, shared: false },
    { sensitive: false, shared: false },
  ],
  projects: [
    { lead: "owner", party: null, members: [], sensitive: false, shared: false },
    { lead: "owner", party: null, members: [], sensitive: false, shared: false },
  ],
  places: [
    { clients: false, docs: false, money: false },
    { clients: false, docs: false, money: false },
  ],
  entries: [],
};

// Work's live stream (`workStream.ts`): each viewer's screen, folded from the stream with the
// client's own reducers (`kinWorkRows.ts`), equals a fresh read after every step of a history, and
// no event a teammate gets names or carries an entry she may not see. Ticks are driven one step at
// a time through the stream's own session, so no timer decides what is compared.

const Pick = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 }));
const Person = Schema.Literals(["owner", "ana", "ben"]);
const Op = Schema.Union([
  Schema.TaggedStruct("create", {
    by: Person,
    owner: Person,
    project: Schema.NullOr(Schema.Literals(["P-1", "P-2"])),
    due: Schema.NullOr(Schema.Literals([-2, 0, 3])),
  }),
  Schema.TaggedStruct("edit", {
    pick: Pick,
    by: Person,
    state: Schema.Literals(["open", "doing", "waiting", "done"]),
    due: Schema.NullOr(Schema.Literals([-1, 2])),
  }),
  Schema.TaggedStruct("assign", { pick: Pick, by: Person, to: Person }),
  Schema.TaggedStruct("handBack", { pick: Pick, by: Schema.Literals(["ana", "ben"]) }),
  Schema.TaggedStruct("private", { pick: Pick, on: Schema.Boolean }),
  Schema.TaggedStruct("share", { pick: Pick, on: Schema.Boolean }),
  Schema.TaggedStruct("move", {
    pick: Pick,
    to: Schema.NullOr(Schema.Literals(["P-1", "P-2"])),
  }),
  Schema.TaggedStruct("members", {
    project: Schema.Literals(["P-1", "P-2"]),
    ana: Schema.Boolean,
    ben: Schema.Boolean,
  }),
  Schema.TaggedStruct("role", {
    who: Schema.Literals(["ben", CO_OWNER]),
    coOwner: Schema.Boolean,
  }),
  Schema.TaggedStruct("places", {
    who: Schema.Literals(["ana", "ben"]),
    clients: Schema.Boolean,
    docs: Schema.Boolean,
    money: Schema.Boolean,
  }),
  Schema.TaggedStruct("remove", { who: Schema.Literals(["ana", "ben"]) }),
  Schema.TaggedStruct("delete", { pick: Pick }),
]);
type Op = typeof Op.Type;
const VIEWERS = ["owner", CO_OWNER, ...MEMBERS] as const;
/** Each step's change, and someone whose socket was down for it, who then resumes. */
const history = Arbitrary.array(
  Arbitrary.all({
    op: Arbitrary.schema(Op),
    away: Arbitrary.schema(Schema.NullOr(Schema.Literals(VIEWERS))),
  }),
  { minLength: 4, maxLength: 14 },
);

type Viewing = (typeof VIEWERS)[number];
/** Screens as clients ask for them: the task page, everything, one's own, under way, a project. */
const PAGES: ReadonlyArray<{
  readonly name: string;
  readonly limit: number;
  readonly input: (me: Viewing) => Omit<KinWorkListInput, "orgId">;
}> = [
  { name: "open", limit: 2, input: () => ({ open: true }) },
  { name: "all", limit: 100, input: () => ({}) },
  {
    name: "mine",
    limit: 1,
    input: (me) => ({ owner: { _tag: "person", personId: KinPersonId.make(me) }, open: true }),
  },
  { name: "underWay", limit: 1, input: () => ({ states: ["doing", "waiting"] }) },
  { name: "dueSoon", limit: 1, input: () => ({ open: true, late: false, dueBy: dueBy }) },
  { name: "project", limit: 3, input: () => ({ project: "P-1" }) },
];
const SENTINEL = "S-1";
const dueBy = DateTime.formatIso(DateTime.makeUnsafe(at + 3 * 86_400_000));

interface Screen {
  /** The level the stream last served them at. */
  teammate: boolean;
  session: Effect.Success<ReturnType<typeof WorkStream.makeWorkStream>>;
  rows: KinWorkRows;
  counts: KinWorkSummary | null;
  pages: Map<string, KinWorkHeldPage>;
  /** The last `counts` or `synchronized` number: where a reconnect resumes. */
  cursor: number;
  /** That number is their own, as a teammate's. */
  cursorTeam: boolean;
  /** Every key they could ever have been shown: their first read's, then each upsert's. */
  held: Set<string>;
}

const peopleOf = (who: Viewing | Who) => [
  { _tag: "person" as const, orgId, personId: KinPersonId.make(who === "agent" ? "owner" : who) },
];

/** A done task in a project its giver then joins (the stream property's seed `-2135024431745369`). */
const PINNED_JOIN: readonly [World, ReadonlyArray<Step>] = [
  {
    clients: [
      {
        sensitive: true,
        shared: false,
      },
      {
        sensitive: false,
        shared: false,
      },
    ],
    projects: [
      {
        lead: "agent",
        party: "c1",
        members: [],
        sensitive: false,
        shared: false,
      },
      {
        lead: "owner",
        party: null,
        members: [],
        sensitive: false,
        shared: false,
      },
    ],
    places: [
      {
        clients: false,
        docs: false,
        money: false,
      },
      {
        clients: false,
        docs: false,
        money: false,
      },
    ],
    entries: [
      {
        list: "work",
        owner: "ben",
        createdBy: "ana",
        assignedBy: "ana",
        sensitive: false,
        shared: false,
        project: "p1",
        party: null,
        attendees: [],
        alsoOn: [],
        company: false,
        title: "Call vendor",
      },
    ],
  },
  [
    {
      op: {
        _tag: "edit",
        pick: 0,
        by: "owner",
        state: "done",
        due: -1,
      },
      away: "cora",
    },
    {
      op: {
        _tag: "members",
        project: "P-1",
        ana: true,
        ben: false,
      },
      away: null,
    },
    {
      op: {
        _tag: "edit",
        pick: 0,
        by: "ana",
        state: "open",
        due: -1,
      },
      away: null,
    },
    {
      op: {
        _tag: "private",
        pick: 0,
        on: false,
      },
      away: "ben",
    },
  ],
];

/** A task leaving a teammate takes the project off their other tasks there. */
const PINNED_MOVE: readonly [World, ReadonlyArray<Step>] = [
  {
    clients: [
      { sensitive: false, shared: false },
      { sensitive: false, shared: false },
    ],
    projects: [
      { lead: "owner", party: "c1", members: [], sensitive: false, shared: false },
      { lead: "agent", party: null, members: [], sensitive: false, shared: false },
    ],
    places: [
      { clients: false, docs: false, money: false },
      { clients: false, docs: false, money: false },
    ],
    entries: [
      {
        list: "work",
        owner: "owner",
        createdBy: "ben",
        assignedBy: "ana",
        sensitive: false,
        shared: false,
        project: null,
        party: null,
        attendees: [],
        alsoOn: [],
        company: false,
        title: "Fix login",
      },
      {
        list: "work",
        owner: "ana",
        createdBy: "agent",
        assignedBy: null,
        sensitive: false,
        shared: false,
        project: null,
        party: null,
        attendees: [],
        alsoOn: [],
        company: false,
        title: "Call vendor",
      },
      {
        list: "work",
        owner: "ana",
        createdBy: "agent",
        assignedBy: null,
        sensitive: false,
        shared: false,
        project: "p1",
        party: "c2",
        attendees: [],
        alsoOn: [],
        company: false,
        title: "Call vendor",
      },
    ],
  },
  [
    { op: { _tag: "move", pick: 0, to: "P-1" }, away: null },
    { op: { _tag: "assign", pick: 20, by: "owner", to: "ben" }, away: "cora" },
    { op: { _tag: "edit", pick: 0, by: "owner", state: "open", due: 2 }, away: "owner" },
    { op: { _tag: "move", pick: 0, to: null }, away: "owner" },
  ],
];

/** Folds each viewer's stream through `ops` on `w`, checking it against a fresh read at each step. */
type Step = { readonly op: Op; readonly away: Viewing | null };
const streamCase = ([w, ops]: readonly [World, ReadonlyArray<Step>]) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(at + 3_600_000);
      yield* install(w, [
        {
          ...rowsOf(emptyWorld)[0]!,
          id: "s1",
          list: "clients",
          title: "Sentinel",
          sensitive: false,
          shared: false,
        },
      ]);
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      // Every entry carries an amount no other value has (`canary`).
      for (const [index, row] of rowsOf(w).entries())
        yield* sql`UPDATE kin_records SET amount_minor = ${canary(index)}, currency = 'INR'
          WHERE org_id = ${orgId} AND record_id = ${row.id}`;
      const pull = yield* Stream.toPull(records.changes(orgId));
      const first = yield* pull;
      const opening = first[0]!.seq;

      const fresh = (who: Viewing, page: (typeof PAGES)[number], limit: number) =>
        OwnerWork.list(peopleOf(who), {
          orgId,
          ...page.input(who),
          limit,
          acceptCompactRows: true,
        }).pipe(Effect.map((result) => kinRestoreWorkList(result, orgId)));
      const read = (who: Viewing, screen: Screen, page: (typeof PAGES)[number]) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(fresh(who, page, page.limit));
          const value =
            result._tag === "Success"
              ? result.success
              : { records: [], total: 0, nextCursor: null, seq: 0, asOf: null };
          screen.pages.set(
            page.name,
            kinWorkHeldPage(
              {
                records: value.records,
                total: value.total,
                more: value.nextCursor !== null,
              },
              { seq: value.seq, asOf: value.asOf, epoch: screen.rows.epoch },
            ),
          );
        });

      const screens = new Map<Viewing, Screen>();
      const fold = (who: Viewing, screen: Screen, events: ReadonlyArray<KinWorkEvent>) =>
        Effect.gen(function* () {
          const teammate = (yield* OwnerWork.viewerOf(peopleOf(who), orgId)).teammate;
          const sees = teammate ? yield* seenKeys(who) : null;
          let reread = false;
          for (const event of events) {
            if (sees !== null && event._tag !== "snapshot-required") {
              // Nothing hidden is named or carried, by key or by amount.
              if (event._tag === "upsert")
                assert.isTrue(sees.has(event.record.key), `${who} told of ${event.record.key}`);
              if (event._tag === "removed")
                assert.isTrue(screen.held.has(event.key), `${who} told ${event.key} went`);
              for (const [index, row] of rowsOf(w).entries())
                if (!sees.has(keyOf(row.id)))
                  assert.isFalse(leaks(event, canary(index)), `${who} reads ${row.id}'s amount`);
            }
            switch (event._tag) {
              case "upsert":
                screen.held.add(event.record.key);
                screen.rows = kinApplyWorkRow(screen.rows, event, orgId);
                break;
              case "removed":
                screen.rows = kinApplyWorkRow(screen.rows, event, orgId);
                break;
              case "counts": {
                const next = kinApplyWorkCounts(screen.counts, event);
                assert.isNotNull(next, `${who} counts arrived without a base`);
                screen.counts = next;
                screen.cursor = event.seq;
                screen.cursorTeam = event.team === true;
                break;
              }
              case "synchronized":
                screen.cursor = event.seq;
                screen.cursorTeam = event.team === true;
                break;
              case "snapshot-required":
                screen.rows = kinWorkRowsStart(event.seq, screen.rows.epoch + 1);
                screen.counts = null;
                screen.cursor = event.seq;
                screen.cursorTeam = event.team === true;
                screen.held = sees ?? new Set();
                reread = true;
                break;
              case "changed":
                assert.fail(`${who} got a legacy change on the row stream`);
            }
          }
          for (const page of PAGES) {
            const held = screen.pages.get(page.name);
            // Before the first read there is nothing on screen to keep.
            if (held === undefined) continue;
            const patched = reread ? null : kinPatchWorkPage(held, page.input(who), screen.rows);
            if (patched === null) yield* read(who, screen, page);
            else screen.pages.set(page.name, patched.page);
          }
        });
      const seenKeys = (who: Viewing) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
            WHERE r.org_id = ${orgId} AND ${personSees(sql, KinPersonId.make(who))}`;
          return new Set(rows.map((row) => row.key));
        });
      const open = (who: Viewing, after?: { readonly seq: number; readonly team: boolean }) =>
        Effect.gen(function* () {
          const session = yield* WorkStream.makeWorkStream(peopleOf(who), {
            orgId,
            acceptRows: true,
            ...(after === undefined ? {} : { afterSeq: after.seq, afterTeam: after.team }),
          });
          const events = yield* session.start(yield* records.seq(orgId));
          return { session, events };
        });
      for (const who of VIEWERS) {
        const { session, events } = yield* open(who);
        const teammate = (yield* OwnerWork.viewerOf(peopleOf(who), orgId)).teammate;
        const start = events.find((one) => one._tag === "counts")?.seq ?? opening;
        const screen: Screen = {
          teammate,
          session,
          rows: kinWorkRowsStart(start),
          counts: null,
          pages: new Map(),
          cursor: start,
          cursorTeam: teammate,
          held: teammate ? yield* seenKeys(who) : new Set(),
        };
        yield* fold(who, screen, events);
        for (const page of PAGES) yield* read(who, screen, page);
        screens.set(who, screen);
      }

      const workKeys = Effect.gen(function* () {
        const rows = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
          WHERE org_id = ${orgId} AND register_id = 'work' ORDER BY key`;
        return rows;
      });
      const pick = (index: number) =>
        Effect.map(workKeys, (rows) => (rows.length === 0 ? undefined : rows[index % rows.length]));
      const person = (who: "owner" | Member) =>
        ({ _tag: "person", personId: KinPersonId.make(who) }) as const;
      const due = (days: number | null) =>
        days === null
          ? null
          : DateTime.formatIso(DateTime.makeUnsafe(at + 3_600_000 + days * 86_400_000));
      const moved = <E>(who: string, change: Effect.Effect<unknown, E>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* change;
            yield* records.peopleMoved(orgId, [who]);
          }),
        );
      let made = 0;
      const apply = (op: Op) =>
        Effect.gen(function* () {
          switch (op._tag) {
            case "create":
              made += 1;
              return yield* OwnerWork.create(peopleOf(op.by), {
                orgId,
                clientRequestId: `stream-${made}`,
                title: `Made ${made}`,
                owner: person(op.owner),
                ...(op.project === null ? {} : { project: op.project }),
                ...(op.due === null ? {} : { dueAt: due(op.due)! }),
              });
            case "edit": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.update(peopleOf(op.by), {
                orgId,
                key: KinRecordKey.make(one.key),
                rev: one.rev,
                state: op.state,
                ...(op.state === "waiting" ? { waitingOn: person("owner") } : {}),
                dueAt: due(op.due),
              });
            }
            case "assign": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.assign(peopleOf(op.by), {
                orgId,
                key: KinRecordKey.make(one.key),
                to: person(op.to),
              });
            }
            case "handBack": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.handBack(peopleOf(op.by), {
                orgId,
                key: KinRecordKey.make(one.key),
              });
            }
            case "private": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.update(peopleOf("owner"), {
                orgId,
                key: KinRecordKey.make(one.key),
                rev: one.rev,
                sensitive: op.on,
              });
            }
            case "share": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.share(peopleOf("owner"), {
                orgId,
                keys: [KinRecordKey.make(one.key)],
                shared: op.on,
              });
            }
            case "move": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              return yield* OwnerWork.update(peopleOf("owner"), {
                orgId,
                key: KinRecordKey.make(one.key),
                rev: one.rev,
                project: op.to === null ? null : KinRecordKey.make(op.to),
              });
            }
            case "members": {
              const [project] = yield* sql<{ rev: number }>`SELECT rev FROM kin_records
                WHERE org_id = ${orgId} AND key = ${op.project}`;
              if (project === undefined) return;
              return yield* OwnerClients.updateProject(peopleOf("owner"), {
                orgId,
                key: KinRecordKey.make(op.project),
                rev: project.rev,
                members: MEMBERS.filter((m) => op[m]).map(person),
              });
            }
            case "role":
              return yield* moved(
                op.who,
                sql`UPDATE kin_people SET access = ${op.coOwner ? "co_owner" : "member"}
                  WHERE person_id = ${op.who}`,
              );
            case "places":
              return yield* moved(
                op.who,
                sql`UPDATE kin_people SET sees_clients = ${op.clients ? 1 : 0},
                  sees_docs = ${op.docs ? 1 : 0}, sees_money = ${op.money ? 1 : 0}
                  WHERE person_id = ${op.who}`,
              );
            case "remove":
              // As `KinPeople.removeAccess` leaves them.
              return yield* moved(
                op.who,
                sql`UPDATE kin_people SET access = 'member', sees_clients = 1, sees_docs = 1,
                  sees_money = 0 WHERE person_id = ${op.who}`,
              );
            case "delete": {
              const one = yield* pick(op.pick);
              if (one === undefined) return;
              // As an import's undo takes an entry away: its changes go with it.
              yield* sql`DELETE FROM kin_record_changes WHERE org_id = ${orgId}
                AND record_id IN (SELECT record_id FROM kin_records WHERE key = ${one.key})`;
              yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId} AND key = ${one.key}`;
              return yield* records.announce(orgId);
            }
          }
        });

      for (const [step, { op, away }] of ops.entries()) {
        yield* Effect.exit(apply(op));
        // The owner's own edit marks the end of the step's ticks.
        yield* records.update(
          orgId,
          { actor: { _tag: "person", personId: ownerId }, via: "owner" },
          SENTINEL,
          { title: `Sentinel ${step}` },
        );
        const mark = yield* records.seq(orgId);
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.key === SENTINEL && tick.seq >= mark))
          ticks.push(...(yield* pull));
        for (const who of VIEWERS) {
          const screen = screens.get(who)!;
          if (away === who) {
            // Away for this step's ticks: a new socket resumes from the last number held, and
            // the screen keeps its rows.
            const { session, events } = yield* open(who, {
              seq: screen.cursor,
              team: screen.cursorTeam,
            });
            const now = (yield* OwnerWork.viewerOf(peopleOf(who), orgId)).teammate;
            if (now !== screen.teammate) {
              assert.strictEqual(events[0]?._tag, "snapshot-required", `${who} resumed rows`);
              screen.teammate = now;
            }
            screen.session = session;
            yield* fold(who, screen, events);
            continue;
          }
          const now = (yield* OwnerWork.viewerOf(peopleOf(who), orgId)).teammate;
          const items = ticks.flatMap((tick) => screen.session.pendingOf(tick));
          // Who they are changed: the stream must hear of it.
          if (now !== screen.teammate) assert.isNotEmpty(items, `${who} not told of their level`);
          if (items.length === 0) continue;
          // Even steps arrive as one burst with the latest per entry, as a slow client would;
          // odd ones one at a time.
          const bursts =
            step % 2 === 0
              ? [[...new Map(items.map((one) => [one.key, one])).values()]]
              : items.map((one) => [one]);
          let restarted = false;
          for (const burst of bursts) {
            const events = yield* screen.session.batch(burst);
            restarted ||= events.some((event) => event._tag === "snapshot-required");
            if (now !== screen.teammate) {
              // Before anything else, everything they held goes.
              assert.strictEqual(events[0]?._tag, "snapshot-required", `${who} kept rows`);
              screen.teammate = now;
            }
            yield* fold(who, screen, events);
          }
          // Their own places moved: all they hold is read again, an open client page included.
          if (op._tag === "places" && op.who === who && now)
            assert.isTrue(restarted, `${who} not told their places moved`);
        }
        for (const who of VIEWERS) {
          const screen = screens.get(who)!;
          const summary = yield* OwnerWork.summary(peopleOf(who), { orgId });
          const { seq: _seq, asOf: _asOf, ...want } = summary;
          const { seq: _held, asOf: _heldAt, ...got } = screen.counts!;
          assert.deepStrictEqual(got, want, `${who}'s counts after ${op._tag}`);
          for (const page of PAGES) {
            const held = screen.pages.get(page.name)!;
            const result = yield* Effect.result(fresh(who, page, Math.max(1, held.records.length)));
            const now = result._tag === "Success" ? result.success : { records: [], total: 0 };
            assert.deepStrictEqual(
              held.records.map((record) => record.key),
              now.records.slice(0, held.records.length).map((record) => record.key),
              `${who}'s ${page.name} rows after ${op._tag} (step ${step})`,
            );
            assert.deepStrictEqual(held.records, now.records.slice(0, held.records.length));
            assert.strictEqual(
              held.total,
              now.total,
              `${who}'s ${page.name} total after ${op._tag}`,
            );
          }
        }
      }
    }),
  );

layer(testLayer)("Work's live stream", (it) => {
  it.effect.prop(
    "folding each viewer's stream equals a fresh read, and names nothing they may not see",
    [world, history],
    streamCase,
    { arbitrary: { runs: 60 } },
  );

  // Found by the property above: a closed task in a project, then its giver joins the project.
  it.effect("a teammate added to a project reads its total as a fresh read does", () =>
    streamCase(PINNED_JOIN),
  );
  it.effect("a teammate whose task in a project leaves them reads its other tasks afresh", () =>
    streamCase(PINNED_MOVE),
  );

  it.effect("a late tick can't let a resume skip its change, or use up a removal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at + 3_600_000);
        yield* install(emptyWorld);
        const records = yield* KinRecords.KinRecords;
        const pull = yield* Stream.toPull(records.changes(orgId));
        const opening = (yield* pull)[0]!.seq;
        const sessions = yield* Effect.forEach(["owner", "ana"] as const, (who) =>
          Effect.gen(function* () {
            const session = yield* WorkStream.makeWorkStream(peopleOf(who), {
              orgId,
              acceptRows: true,
            });
            yield* session.start(opening);
            return { who, session };
          }),
        );
        const made = (n: number) =>
          OwnerWork.create(peopleOf("owner"), {
            orgId,
            clientRequestId: `overtaken-${n}`,
            title: `Overtaken ${n}`,
            owner: { _tag: "person", personId: KinPersonId.make("ana") },
          });
        const first = yield* made(1);
        const second = yield* made(2);
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.key === second.key)) ticks.push(...(yield* pull));
        for (const { who, session } of sessions) {
          // The second commit's tick arrives; the first's is still on its way when the socket drops.
          const items = ticks
            .filter((tick) => tick.key === second.key)
            .flatMap((tick) => session.pendingOf(tick));
          const sent = yield* session.batch(items);
          const close = sent.at(-1);
          assert.isTrue(close?._tag === "counts" || close?._tag === "synchronized");
          if (close?._tag !== "counts" && close?._tag !== "synchronized") return;
          const resumed = yield* WorkStream.makeWorkStream(peopleOf(who), {
            orgId,
            acceptRows: true,
            afterSeq: close.seq,
            ...(close.team === true ? { afterTeam: true } : {}),
          });
          const events = yield* resumed.start(yield* records.seq(orgId));
          // The first task comes back on the resume, or the client reads everything again.
          assert.isTrue(
            events[0]?._tag === "snapshot-required" ||
              events.some((event) => event._tag === "upsert" && event.record.key === first.key),
            `${who} resumed past ${first.key}: ${JSON.stringify(events.map((one) => one._tag))}`,
          );
        }

        // Her screen starts over, then the task leaves her view while its earlier tick is late: the
        // late tick must still bring the removal at a number her screen applies.
        const late = yield* made(3);
        const ana = yield* WorkStream.makeWorkStream(peopleOf("ana"), { orgId, acceptRows: true });
        const opened = yield* ana.start(yield* records.seq(orgId));
        const readAt = opened.find((event) => event._tag === "counts")?.seq ?? 0;
        yield* OwnerWork.assign(peopleOf("owner"), {
          orgId,
          key: late.key,
          to: { _tag: "person", personId: KinPersonId.make("owner") },
        });
        const more: Array<KinRecords.Tick> = [...ticks];
        while (more.filter((tick) => tick.key === late.key).length < 2) more.push(...(yield* pull));
        const sent = [];
        for (const tick of more.filter((one) => one.key === late.key))
          sent.push(...(yield* ana.batch(ana.pendingOf(tick))));
        assert.isTrue(
          sent.some(
            (event) => event._tag === "removed" && event.key === late.key && event.seq > readAt,
          ),
          `ana kept ${late.key}: ${JSON.stringify(sent)}`,
        );
      }),
    ),
  );

  it.effect("one change is counted once for every owner-level screen, and a member her own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at + 3_600_000);
        yield* install(emptyWorld);
        const records = yield* KinRecords.KinRecords;
        const pull = yield* Stream.toPull(records.changes(orgId));
        const opening = (yield* pull)[0]!.seq;
        const task = (title: string, owner: string) =>
          OwnerWork.create(peopleOf("owner"), {
            orgId,
            clientRequestId: `counted-${title}`,
            title,
            owner: { _tag: "person", personId: KinPersonId.make(owner) },
          });
        yield* task("The owner's own", "owner");
        const screens = yield* Effect.forEach(["owner", CO_OWNER, "owner", "ana"] as const, (who) =>
          Effect.gen(function* () {
            const session = yield* WorkStream.makeWorkStream(peopleOf(who), {
              orgId,
              acceptRows: true,
            });
            yield* session.start(opening);
            return { who, session };
          }),
        );
        const made = yield* task("Hers", "ana");
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.key === made.key)) ticks.push(...(yield* pull));
        let counted = 0;
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              const text = span.attributes.get("db.query.text");
              if (typeof text === "string" && text.includes("SUM(r.state = 'doing')")) counted += 1;
            };
            return span;
          },
        });
        const open = new Map<string, number>();
        for (const { who, session } of screens) {
          const sent = yield* session
            .batch(ticks.flatMap((tick) => session.pendingOf(tick)))
            .pipe(Effect.withTracer(tracer));
          const counts = sent.find((event) => event._tag === "counts");
          if (counts !== undefined) open.set(who, counts.open);
        }
        assert.strictEqual(counted, 2, "one read for the owner-level screens, one for hers");
        assert.strictEqual(open.get(CO_OWNER), 2);
        assert.strictEqual(open.get("owner"), 2);
        const hers = yield* OwnerWork.summary(peopleOf("ana"), { orgId });
        assert.strictEqual(open.get("ana"), hers.open);
        assert.strictEqual(hers.open, 1, "a member's counts are her own");
      }),
    ),
  );

  it.effect("a project she joins shows on her tasks, its ticks arriving one by one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(at + 3_600_000);
        yield* install(emptyWorld);
        const records = yield* KinRecords.KinRecords;
        const sql = yield* SqlClient.SqlClient;
        const pull = yield* Stream.toPull(records.changes(orgId));
        yield* pull;
        const task = yield* OwnerWork.create(peopleOf("owner"), {
          orgId,
          clientRequestId: "joins-p1",
          title: "Under P-1",
          owner: { _tag: "person", personId: KinPersonId.make("ana") },
          project: "P-1",
        });
        // Her screen opens after the task's own tick, holding it without the project she can't see.
        const before: Array<KinRecords.Tick> = [];
        while (!before.some((tick) => tick.key === task.key)) before.push(...(yield* pull));
        const ana = yield* WorkStream.makeWorkStream(peopleOf("ana"), { orgId, acceptRows: true });
        const opened = yield* ana.start(yield* records.seq(orgId));
        let rows = kinWorkRowsStart(opened.find((event) => event._tag === "counts")?.seq ?? 0);
        const [project] = yield* sql<{ rev: number }>`SELECT rev FROM kin_records
          WHERE org_id = ${orgId} AND key = 'P-1'`;
        yield* OwnerClients.updateProject(peopleOf("owner"), {
          orgId,
          key: KinRecordKey.make("P-1"),
          rev: project!.rev,
          members: [{ _tag: "person", personId: KinPersonId.make("ana") }],
        });
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.key === "P-1")) ticks.push(...(yield* pull));
        // A slow burst splits the project's own change from the rescan it brings.
        for (const tick of ticks)
          for (const one of ana.pendingOf(tick))
            for (const event of yield* ana.batch([one]))
              if (event._tag === "upsert" || event._tag === "removed")
                rows = kinApplyWorkRow(rows, event, orgId);
        const read = kinRestoreWorkList(
          yield* OwnerWork.list(peopleOf("ana"), { orgId, acceptCompactRows: true }),
          orgId,
        );
        const now = read.records.find((record) => record.key === task.key);
        assert.isDefined(now?.project, "a member of P-1 sees it on the task");
        assert.deepStrictEqual(rows.entries.get(task.key)?.record, now);
      }),
    ),
  );
});
