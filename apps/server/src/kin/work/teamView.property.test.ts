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

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "./KinRecords.ts";
import { search } from "./search.ts";
import { personSees } from "./teamView.ts";

// Invented org, people and entries only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const MEMBERS = ["ana", "ben"] as const;
type Member = (typeof MEMBERS)[number];
type Who = "owner" | Member | "agent";

const pick = <const L extends ReadonlyArray<string | null>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
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
  assignedBy: pick([null, "owner", "ana", "ben"]),
  sensitive: flag,
  shared: flag,
  project: pick([null, "p1", "p2"]),
  party: pick([null, "c1", "c2"]),
  attendees: someOf,
  company: flag,
  title: pick(["Plan launch", "Fix login", "Call vendor"]),
});
type Entry = typeof entry extends Arbitrary.Arbitrary<infer A> ? A : never;

const project = Arbitrary.all({
  lead: pick(["owner", "ana", "ben", "agent"]),
  party: pick([null, "c1", "c2"]),
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
  for (const person of [ownerId, ...MEMBERS])
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${person}, ${orgId}, ${person}, ${person}, '2026-11-11',
        ${person === ownerId ? "owner" : "member"})`;
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
      ...(e.company ? { home: "company" } : {}),
    },
    title: `${e.title} ${i + 1}`,
  })),
];

/** Replaces the org's entries and the members' places with this world. */
const install = (w: World, extra: ReadonlyArray<Row> = []) =>
  Effect.gen(function* () {
    yield* once;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId}`;
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
        VALUES (${orgId}, ${row.id}, ${row.list}, ${row.id.toUpperCase()}, ${row.title},
          ${ownerKind}, ${owner}, ${row.party}, ${row.project}, ${row.sensitive ? 1 : 0},
          ${row.shared ? 1 : 0}, ${JSON.stringify(row.fields)}, ${createdKind}, ${createdBy},
          ${row.assignedBy}, ${row.id}, ${at}, ${at})`;
    }
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
  (row.owner === viewer || (row.fields["attendees"] as Array<string>).includes(`person:${viewer}`));

layer(testLayer)("personSees", (it) => {
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
      party: pick([null, "c1", "c2"]),
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
            assignedBy: e.assignedBy === null ? null : benGone(e.assignedBy),
            attendees: notBen(e.attendees),
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
              view: [team],
              closed: true,
            });
            for (const hit of hits)
              assert.isTrue(sees.has(hit.recordId), `${viewer} finds ${hit.key}`);
          }
        }
      }),
  );
});
