// @effect-diagnostics globalDate:off -- fixed invented dates.
// Loaded first: the chat and trigger modules import each other.
import "./chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinChatError,
  KinDocsEvent,
  KinDocsRpcs,
  KinFinanceRpcs,
  KinMoneyEvent,
  KinOrgId,
  KinPersonId,
  KinPulseRpcs,
  KinPulseEvent,
  KinRefreshes,
  KinWorkEvent,
  KinWorkRpcs,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { KinIdentity, type PersonIdentity } from "./chat/KinIdentity.ts";
import * as RefreshHub from "./chat/KinRefreshHub.ts";
import * as KinEventQueue from "./lead/KinEventQueue.ts";
import { KinLevelGate } from "./lead/LevelGate.ts";
import * as KinPersistence from "./persistence/KinPersistence.ts";
import * as Pulse from "./pulse/people.ts";
import * as Docs from "./work/docs.ts";
import * as KinImport from "./work/KinImport.ts";
import * as KinRecords from "./work/KinRecords.ts";
import * as Clients from "./work/ownerClients.ts";
import * as OwnerDocs from "./work/ownerDocs.ts";
import * as Money from "./work/ownerMoney.ts";
import * as Work from "./work/ownerWork.ts";

// The wire budget's invented company and Kin's hot reads, shared by wireBudget.test.ts (at
// BASE_SIZE, pinned in kinWireBudget.json) and scripts/kin-wire-scaled.ts (at a real size).

export const orgId = KinOrgId.make("org");
export const ownerId = KinPersonId.make("owner");
export const coOwnerId = KinPersonId.make("meera");
export const memberId = KinPersonId.make("zoya");
export const NOW = Date.parse("2026-11-12T06:00:00.000Z");
export const created = "2026-01-01T00:00:00.000Z";
/** An answer with no `limit` a client could pass; paged answers are bounded by their page. */
export const UNPAGED_CEILING = 32 * 1024;
const PAGE_CEILING = 64 * 1024;

export interface SeedSize {
  readonly clients: number;
  readonly projects: number;
  readonly tasks: number;
  readonly invoices: number;
  readonly expenses: number;
  readonly docs: number;
}

export const BASE_SIZE: SeedSize = {
  clients: 60,
  projects: 12,
  tasks: 200,
  invoices: 60,
  expenses: 60,
  docs: 100,
};

export const day = (offset: number) =>
  new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);
const pick = <A>(list: ReadonlyArray<A>, index: number) => list[index % list.length]!;
const THINGS = ["the booking API", "the pricing page", "the release notes", "the clinic dashboard"];

/** The bench seed's shape: clients, projects, tasks and a year of money, however many there are. */
function importLines(size: SeedSize): ReadonlyArray<string> {
  const rows: Array<unknown> = [
    {
      format: "kin-import",
      version: 1,
      batch: "wire-budget",
      source: "wire budget",
      lists: [
        { list: "invoices", template: "invoices" },
        { list: "expenses", template: "expenses" },
      ],
    },
  ];
  for (let i = 0; i < size.clients; i++)
    rows.push({
      client: { source: `c${i}`, name: `Invented Client ${i + 1}`, createdAt: day(-300) },
    });
  for (let i = 0; i < size.projects; i++)
    rows.push({
      project: {
        source: `p${i}`,
        name: `Project ${i + 1}`,
        client: `c${(i * 5) % size.clients}`,
        createdAt: day(-200),
      },
    });
  for (let i = 0; i < size.tasks; i++)
    rows.push({
      entry: {
        source: `t${i}`,
        list: "work",
        title: `${pick(["Design", "Review", "Ship", "Fix"], i)} ${pick(THINGS, i)} (${i + 1})`,
        project: `p${i % size.projects}`,
        state: i % 3 === 0 ? "done" : i % 5 === 0 ? "waiting" : "open",
        due: day((i % 60) - 20),
        createdAt: day(-90),
        ...(i % 3 === 0 ? { closedAt: day(-2) } : {}),
      },
    });
  // Money spans one year at any size; amounts repeat every 300 entries.
  const dated = (i: number) => -((6 * i) % 365);
  for (let i = 0; i < size.invoices; i++) {
    const paid = i % 4 !== 0;
    const amount = `${20_000 + (i % 300) * 1_000}.00`;
    rows.push({
      entry: {
        source: `i${i}`,
        list: "invoices",
        title: `Invoice ${i + 1}`,
        client: `c${i % size.clients}`,
        project: `p${i % size.projects}`,
        state: paid ? "done" : "waiting",
        date: day(dated(i)),
        due: day(dated(i) + 15),
        amount,
        number: `WB/${i + 1}`,
        createdAt: day(dated(i)),
        ...(paid ? { payments: [{ source: `pay${i}`, amount, paidOn: day(dated(i) + 5) }] } : {}),
      },
    });
  }
  for (let i = 0; i < size.expenses; i++)
    rows.push({
      entry: {
        source: `e${i}`,
        list: "expenses",
        title: `Expense ${i + 1}`,
        category: pick(["software", "travel", "rent"], i),
        state: "done",
        date: day(dated(i)),
        amount: `${500 + (i % 300) * 100}.00`,
        createdAt: day(dated(i)),
      },
    });
  return rows.map((row) => JSON.stringify(row));
}

export const ownerWriter = {
  actor: { _tag: "person" as const, personId: ownerId },
  via: "owner" as const,
};

export const seed = Effect.fn("KinWireBudget.seed")(function* (size: SeedSize) {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${created})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [person, access] of [
    [ownerId, "owner"],
    [coOwnerId, "co_owner"],
    [memberId, "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
        sees_docs, sees_clients)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${created}, ${access}, 1, 1)`;
  // Change numbers are kept for teammates who have signed in.
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('session-zoya', ${orgId}, ${memberId}, 0)`;
  yield* (yield* KinImport.KinImport).apply(orgId, ownerId, Stream.fromIterable(importLines(size)));
  for (let i = 0; i < size.docs; i++)
    yield* Docs.create(
      orgId,
      ownerWriter,
      {},
      {
        title: `Invented doc ${i + 1}`,
        body: `# Invented doc ${i + 1}\n\nWhat was agreed, in a few invented lines.\n`,
        owner: { _tag: "person", personId: ownerId },
        summary: "Created",
        originKey: `wire-budget:doc:${i}`,
        ...(i % 4 === 0 ? { company: true } : {}),
      },
    );
  // Some open tasks are the member's, as the owner hands them out.
  const open = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND state NOT IN ('done', 'dropped')
    ORDER BY key LIMIT 30`;
  for (const { key } of open.filter((_, i) => i % 2 === 0))
    yield* Work.assign(as(ownerId), {
      orgId,
      key,
      to: { _tag: "person", personId: memberId },
    });
});

export const as = (personId: KinPersonId): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId, personId },
];

export const successOf = (
  rpcs: ReadonlyArray<{ readonly _tag: string; readonly successSchema: Schema.Top }>,
  tag: string,
) => rpcs.find((rpc) => rpc._tag === tag)!.successSchema;
/** Bytes of the JSON the socket carries: the RPC's success schema, encoded. */
export const wireBytes = (schema: Schema.Top, value: unknown) =>
  Buffer.byteLength(
    JSON.stringify(Schema.encodeUnknownSync(schema as Schema.Codec<unknown>)(value)),
  );

export const SCHEMAS = {
  list: successOf(KinWorkRpcs, "kin.work.list"),
  summary: successOf(KinWorkRpcs, "kin.work.summary"),
  parties: successOf(KinWorkRpcs, "kin.work.parties"),
  projects: successOf(KinWorkRpcs, "kin.work.projects"),
  subscribe: KinWorkEvent,
  money: successOf(KinFinanceRpcs, "kin.work.money"),
  lists: successOf(KinFinanceRpcs, "kin.work.lists"),
  docs: successOf(KinDocsRpcs, "kin.docs.list"),
  pulse: successOf(KinPulseRpcs, "kin.pulse.read"),
  pulseEvent: KinPulseEvent,
  docsEvent: KinDocsEvent,
  moneyEvent: KinMoneyEvent,
  refreshes: KinRefreshes,
};

export type Services = Layer.Success<typeof layer>;
type Run = (
  people: ReadonlyArray<PersonIdentity>,
  me: KinPersonId,
) => Effect.Effect<object, unknown, Services>;

interface Read {
  readonly name: string;
  /** A client can pass a `limit`; unpaged answers are held under `UNPAGED_CEILING`. */
  readonly paged: boolean;
  /** A list the person asked to see all of: the one kind of read `byteCeiling` lets grow. */
  readonly grows?: true;
  readonly schema: Schema.Top;
  /** The answer's field that holds its rows; none for a summary. */
  readonly rows?: string;
  readonly run: Run;
}

const endOfToday = new Date(NOW + 86_400_000).toISOString();
const weekAgo = new Date(NOW - 7 * 86_400_000).toISOString();

/** Each hot read as today's web and phone ask it; `Legacy` ones as an older phone app still does. */
export const READS: ReadonlyArray<Read> = [
  {
    name: "taskPage",
    paged: true,
    schema: SCHEMAS.list,
    rows: "rows",
    run: (people) => Work.list(people, { orgId, open: true, acceptCompactRows: true }),
  },
  {
    name: "taskPageLegacy",
    paged: true,
    schema: SCHEMAS.list,
    rows: "records",
    run: (people) => Work.list(people, { orgId, open: true }),
  },
  {
    name: "dueToday",
    paged: true,
    schema: SCHEMAS.list,
    rows: "rows",
    run: (people, me) =>
      Work.list(people, {
        orgId,
        owner: { _tag: "person", personId: me },
        open: true,
        dueBy: endOfToday,
        limit: 20,
        acceptCompactRows: true,
      }),
  },
  {
    name: "summary",
    paged: false,
    schema: SCHEMAS.summary,
    run: (people) => Work.summary(people, { orgId }),
  },
  {
    name: "money",
    paged: false,
    schema: SCHEMAS.money,
    run: (people) => Money.money(people, { orgId, upcomingRows: false }),
  },
  {
    name: "moneyLegacy",
    paged: true,
    schema: SCHEMAS.money,
    rows: "upcoming",
    run: (people) => Money.money(people, { orgId }),
  },
  {
    name: "lists",
    paged: false,
    schema: SCHEMAS.lists,
    rows: "lists",
    run: (people) => Money.lists(people, { orgId }),
  },
  {
    name: "docsPage",
    paged: true,
    schema: SCHEMAS.docs,
    rows: "docs",
    run: (people) => OwnerDocs.list(people, { orgId, acceptSlimLatest: true }),
  },
  {
    name: "docsPageLegacy",
    paged: true,
    schema: SCHEMAS.docs,
    rows: "docs",
    run: (people) => OwnerDocs.list(people, { orgId }),
  },
  {
    name: "docsTotal",
    paged: false,
    schema: SCHEMAS.docs,
    run: (people) => OwnerDocs.list(people, { orgId, limit: 1, acceptSlimLatest: true }),
  },
  {
    name: "docsChangedThisWeek",
    paged: false,
    schema: SCHEMAS.docs,
    run: (people) =>
      OwnerDocs.list(people, { orgId, limit: 1, changedSince: weekAgo, acceptSlimLatest: true }),
  },
  {
    name: "needsYou",
    paged: true,
    schema: SCHEMAS.pulse,
    rows: "facts",
    run: (people) => Pulse.read(people, { orgId, includeHandled: true, limit: 8 }),
  },
  {
    name: "attentionAll",
    paged: true,
    grows: true,
    schema: SCHEMAS.pulse,
    rows: "facts",
    run: (people) => Pulse.read(people, { orgId, includeHandled: true }),
  },
  {
    name: "attentionMoney",
    paged: true,
    grows: true,
    schema: SCHEMAS.pulse,
    rows: "facts",
    run: (people) =>
      Pulse.read(people, { orgId, includeHandled: true, scope: { family: "money" } }),
  },
  {
    name: "clients",
    paged: true,
    schema: SCHEMAS.parties,
    rows: "parties",
    run: (people) => Clients.parties(people, { orgId }),
  },
  {
    name: "projects",
    paged: true,
    schema: SCHEMAS.projects,
    rows: "projects",
    run: (people) => Clients.projects(people, { orgId }),
  },
];

/**
 * What a read may send at any company size. Only a list the person asked to see all of grows with
 * the company; every other read is a screen's first payload or one page, and must not.
 */
export const byteCeiling = (read: Read) =>
  read.grows === true ? undefined : read.paged ? PAGE_CEILING : UNPAGED_CEILING;

export const rowsOf = (value: object, field: string | undefined) => {
  if (field === undefined) return 1;
  const held: unknown = (value as Record<string, unknown>)[field];
  return Array.isArray(held) ? held.length : 0;
};

export const VIEWERS = [
  ["owner", ownerId],
  ["coOwner", coOwnerId],
  ["member", memberId],
] as const;

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
export const layer = KinImport.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(KinRecords.layer, identity, gate)),
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-wire-budget-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);
