// @effect-diagnostics globalDate:off -- fixed invented dates.
// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_MONEY_PARTS,
  KinChatError,
  type KinMoneyEvent,
  type KinMoneyLive,
  type KinMoneyPart,
  KinOrgId,
  KinPersonId,
  kinMoneyApply,
  kinMoneySettled,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Goals from "./goals.ts";
import * as KinImport from "./KinImport.ts";
import * as KinRecords from "./KinRecords.ts";
import { demandOfTick, makeMoneyStream, type MoneyDemand } from "./moneyStream.ts";
import * as Money from "./ownerMoney.ts";
import * as MoneyAnswers from "./ownerMoneyAnswers.ts";
import * as Work from "./ownerWork.ts";

// Money's live stream (`moneyStream.ts`): the parts each owner-level screen holds, folded from its
// stream with the client's own `kinMoneyApply`, equal a fresh read of each after every step of a
// history; a lead or a member is refused it and is sent no figure. Invented org, people, amounts.

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const created = "2026-01-01T00:00:00.000Z";
const DAY = 86_400_000;
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)) as never;
const day = (offset: number) => new Date(NOW + offset * DAY).toISOString().slice(0, 10);

const PEOPLE = [
  ["owner", "owner"],
  ["cora", "co_owner"],
  ["dev", "member"],
  ["mate", "member"],
] as const;
type Who = (typeof PEOPLE)[number][0];
const OWNER_LEVEL: ReadonlyArray<Who> = ["owner", "cora"];
const TEAM: ReadonlyArray<Who> = ["dev", "mate"];
const as = (who: Who): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId, personId: KinPersonId.make(who) },
];
const ownerWriter = {
  actor: { _tag: "person" as const, personId: ownerId },
  via: "owner" as const,
};

/** Two subscriptions per screen, as the clients hold them: the summary, and the page's others. */
const SCREENS: ReadonlyArray<ReadonlyArray<KinMoneyPart>> = [
  ["summary"],
  KIN_MONEY_PARTS.filter((part) => part !== "summary"),
];

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const testLayer = KinImport.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(KinRecords.layer, identity, gate)),
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-money-stream-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${created})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [who, access] of PEOPLE)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
        sees_docs, sees_clients, sees_money)
      VALUES (${who}, ${orgId}, ${who}, ${who}, ${created}, ${access}, 1, 1, ${who === "mate" ? 1 : 0})`;
  for (const who of TEAM)
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES (${`session-${who}`}, ${orgId}, ${who}, 0)`;
  const lines: Array<unknown> = [
    {
      format: "kin-import",
      version: 1,
      batch: "money-stream",
      source: "money stream property",
      lists: [
        { list: "invoices", template: "invoices" },
        { list: "expenses", template: "expenses" },
      ],
    },
  ];
  for (let i = 0; i < 3; i++)
    lines.push({
      client: { source: `c${i}`, name: `Invented Client ${i + 1}`, createdAt: day(-90) },
    });
  lines.push({
    project: { source: "p0", name: "Invented Project", client: "c0", createdAt: day(-60) },
  });
  for (let i = 0; i < 4; i++) {
    const amount = `${10_000 + i * 1_000}.00`;
    lines.push({
      entry: {
        source: `i${i}`,
        list: "invoices",
        title: `Invoice ${i + 1}`,
        client: `c${i % 3}`,
        ...(i % 2 === 0 ? { project: "p0" } : {}),
        state: i === 0 ? "done" : "waiting",
        date: day(-10 * i),
        due: day(-10 * i + 15),
        amount,
        number: `MS/${i + 1}`,
        createdAt: day(-10 * i),
        ...(i === 0 ? { payments: [{ source: "pay0", amount, paidOn: day(-2) }] } : {}),
      },
    });
  }
  yield* (yield* KinImport.KinImport).apply(
    orgId,
    ownerId,
    Stream.fromIterable(lines.map((line) => JSON.stringify(line))),
  );
  // Dev leads the project, so Money reaches him for its invoices.
  const [project] = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'projects'`;
  const records = yield* KinRecords.KinRecords;
  yield* records.update(orgId, ownerWriter, project!.key, {
    owner: { _tag: "person", personId: KinPersonId.make("dev") },
  });
  for (const [title, measure, target] of [
    ["Invented revenue", "revenue_received", "1 lakh"],
    ["Invented tasks", "tasks_done", "5"],
  ] as const)
    yield* Goals.save(as("owner"), {
      orgId,
      title,
      measure,
      target,
      startsOn: day(-30),
      dueOn: day(60),
      clientRequestId: `money-stream:${measure}`,
    });
});

/** Each part as a fresh read gives it this viewer now. */
const freshOf = (who: Who) =>
  Effect.gen(function* () {
    const people = as(who);
    return {
      summary: yield* Money.money(people, { orgId, upcomingRows: false }),
      cash: yield* MoneyAnswers.cash(people, { orgId }),
      outlook: yield* MoneyAnswers.outlook(people, { orgId }),
      budgets: yield* MoneyAnswers.budgets(people, { orgId }),
      receipts: yield* Money.receipts(people, { orgId }),
      goals: yield* Goals.list(people, orgId),
      lists: yield* Money.lists(people, { orgId }),
    } satisfies KinMoneyLive;
  });

const timeless = (live: KinMoneyLive) =>
  Object.fromEntries(
    KIN_MONEY_PARTS.filter((part) => live[part] !== undefined).map((part) => [
      part,
      kinMoneySettled(part, live[part]),
    ]),
  );

const Pick = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }));
const Days = Schema.Int.check(Schema.isBetween({ minimum: -40, maximum: 45 }));
const Op = Schema.Union([
  Schema.TaggedStruct("invoice", { amount: Pick, due: Days, project: Schema.Boolean }),
  Schema.TaggedStruct("pay", { pick: Pick, whole: Schema.Boolean }),
  Schema.TaggedStruct("expense", { amount: Pick, ago: Pick }),
  Schema.TaggedStruct("task", { due: Days }),
  Schema.TaggedStruct("taskDone", { pick: Pick }),
  Schema.TaggedStruct("taskDue", { pick: Pick, due: Days }),
  Schema.TaggedStruct("renameClient", { pick: Pick }),
]);
type Op = typeof Op.Type;
const history = Arbitrary.array(Arbitrary.schema(Op), { minLength: 2, maxLength: 10 });

const moneyCase = (ops: ReadonlyArray<Op>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const pull = yield* Stream.toPull(records.changes(orgId));
      yield* pull;
      const screens = yield* Effect.forEach(
        OWNER_LEVEL.flatMap((who) => SCREENS.map((parts) => ({ who, parts }))),
        ({ who, parts }) =>
          Effect.gen(function* () {
            const session = yield* makeMoneyStream(as(who), { orgId, parts });
            const first = yield* session.start();
            if (first._tag !== "snapshot") return yield* Effect.die(new Error("No snapshot."));
            return { who, parts, session, held: first.live };
          }),
      );
      const refused = () =>
        Effect.forEach(TEAM, (who) =>
          Effect.gen(function* () {
            const opened = yield* Effect.exit(
              makeMoneyStream(as(who), { orgId, parts: KIN_MONEY_PARTS }),
            );
            assert.isTrue(opened._tag === "Failure", `${who} is refused Money's stream`);
          }),
        );
      yield* refused();

      let made = 0;
      const keysOf = (list: string, open: boolean) =>
        sql<{ key: string; rev: number; partyId: string | null }>`SELECT key, rev,
            party_id AS "partyId" FROM kin_records
          WHERE org_id = ${orgId} AND register_id = ${list}
            AND (${open ? 1 : 0} = 0 OR state NOT IN ('done', 'dropped')) ORDER BY key`;
      const pick = (list: string, index: number, open = true) =>
        Effect.map(keysOf(list, open), (rows) =>
          rows.length === 0 ? undefined : rows[index % rows.length],
        );
      const apply = (op: Op) =>
        Effect.gen(function* () {
          made += 1;
          const now = yield* Clock.currentTimeMillis;
          switch (op._tag) {
            case "invoice": {
              const [party] = yield* keysOf("clients", false);
              const [project] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
                WHERE org_id = ${orgId} AND register_id = 'projects'`;
              const [client] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
                WHERE org_id = ${orgId} AND register_id = 'clients' AND key = ${party!.key}`;
              return yield* records.create(orgId, ownerWriter, {
                list: "invoices",
                title: `Invented invoice ${made}`,
                owner: { _tag: "person", personId: ownerId },
                state: "waiting",
                amount: { minor: (op.amount + 1) * 100_000, currency: "INR" },
                // Every time half a day from a step, so the minute between steps moves nothing.
                dateAt: now - DAY / 2,
                dueAt: now + op.due * DAY + DAY / 2,
                partyId: client!.id,
                ...(op.project ? { projectId: project!.id } : {}),
                fields: { number: `MS/new/${made}` },
                originKey: `money-stream:invoice:${made}`,
              });
            }
            case "pay": {
              const one = yield* pick("invoices", op.pick);
              if (one === undefined) return;
              const [owed] = yield* sql<{
                minor: number;
                paid: number;
              }>`SELECT r.amount_minor AS minor,
                  COALESCE((SELECT SUM(p.amount_minor) FROM kin_record_payments p
                    WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL), 0) AS paid
                FROM kin_records r WHERE r.org_id = ${orgId} AND r.key = ${one.key}`;
              const left = (owed?.minor ?? 0) - (owed?.paid ?? 0);
              if (left <= 0) return;
              return yield* Money.recordPayment(as("owner"), {
                orgId,
                key: one.key as never,
                amount: {
                  minor: op.whole ? left : Math.max(1, Math.floor(left / 3)),
                  currency: "INR",
                },
                paidOn: day(0),
                clientRequestId: `money-stream:pay:${made}`,
              });
            }
            case "expense":
              return yield* records.create(orgId, ownerWriter, {
                list: "expenses",
                title: `Invented expense ${made}`,
                owner: { _tag: "person", personId: ownerId },
                state: "done",
                amount: { minor: (op.amount + 1) * 10_000, currency: "INR" },
                dateAt: now - op.ago * DAY - DAY / 2,
                originKey: `money-stream:expense:${made}`,
              });
            case "task":
              return yield* Work.create(as("owner"), {
                orgId,
                clientRequestId: `money-stream:task:${made}`,
                title: `Invented task ${made}`,
                dueAt: isoAt(now + op.due * DAY + DAY / 2),
              });
            case "taskDone": {
              const one = yield* pick("work", op.pick);
              if (one === undefined) return;
              return yield* Work.update(as("owner"), {
                orgId,
                key: one.key as never,
                rev: one.rev,
                state: "done",
              });
            }
            case "taskDue": {
              const one = yield* pick("work", op.pick);
              if (one === undefined) return;
              return yield* Work.update(as("owner"), {
                orgId,
                key: one.key as never,
                rev: one.rev,
                dueAt: isoAt(now + op.due * DAY + DAY / 2),
              });
            }
            case "renameClient": {
              const one = yield* pick("clients", op.pick, false);
              if (one === undefined) return;
              return yield* records.update(orgId, ownerWriter, one.key, {
                title: `Renamed Client ${made}`,
              });
            }
          }
        });

      for (const [step, op] of ops.entries()) {
        yield* TestClock.adjust(60_000);
        const before = yield* records.seq(orgId);
        yield* Effect.exit(apply(op));
        const after = yield* records.seq(orgId);
        const ticks: Array<KinRecords.Tick> = [];
        while (!ticks.some((tick) => tick.seq >= after) && after > before)
          ticks.push(...(yield* pull));
        const demands = ticks.map(demandOfTick);
        for (const screen of screens) {
          // Even steps arrive as one burst, as the stream's window gathers them; odd ones singly.
          const bursts: ReadonlyArray<MoneyDemand> =
            step % 2 === 0 && demands.length > 0
              ? [new Set(demands.flatMap((one) => [...one]))]
              : demands;
          const events: Array<KinMoneyEvent> = [];
          for (const demand of bursts) events.push(...(yield* screen.session.apply(demand)));
          for (const event of events) {
            if (event._tag !== "changed") return yield* Effect.die(new Error("Not a change."));
            for (const part of KIN_MONEY_PARTS)
              if (event[part] !== undefined)
                assert.include(screen.parts, part, `${screen.who} was sent ${part} unasked`);
            screen.held = kinMoneyApply(screen.held, event);
          }
          const fresh = yield* freshOf(screen.who);
          const asked = Object.fromEntries(screen.parts.map((part) => [part, fresh[part]]));
          assert.deepStrictEqual(
            timeless(screen.held),
            timeless(asked),
            `${screen.who}'s ${screen.parts.join(",")} after ${op._tag} (step ${step})`,
          );
          if (op._tag.startsWith("task"))
            for (const event of events)
              for (const part of ["cash", "outlook", "budgets", "receipts"] as const)
                assert.isTrue(
                  event._tag === "changed" && event[part] === undefined,
                  `a task moved ${part} (step ${step})`,
                );
        }
        yield* refused();
      }
    }),
  );

describe("Money's live stream", () => {
  it.effect("a co-owner made a member mid-stream is sent no more figures", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const session = yield* makeMoneyStream(as("cora"), { orgId, parts: KIN_MONEY_PARTS });
      yield* session.start();
      yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'cora'`;
      const after = yield* Effect.exit(session.apply(new Set(KIN_MONEY_PARTS)));
      // The stream ends; her client subscribes again and is refused, as a member is.
      assert.isTrue(after._tag === "Failure", "figures after she stopped being a co-owner");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.prop(
    "each owner-level screen folded from its stream equals a fresh read after every change",
    [history],
    ([ops]) => moneyCase(ops).pipe(Effect.provide(testLayer)),
    { arbitrary: { runs: 25 } },
  );
});
