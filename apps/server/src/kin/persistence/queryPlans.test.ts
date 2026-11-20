// @effect-diagnostics anyUnknownInErrorContext:off -- each hot read fails in its own way, and any failure fails the test.
// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as Work from "../work/ownerWork.ts";
import * as KinPersistence from "./KinPersistence.ts";

// The server's own SQLite on the migrated schema with no statistics, as every host runs once
// startup clears sqlite_stat1 (`Sqlite.ts`): the plan a hot query gets there is the one it ships.

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const memberId = KinPersonId.make("zoya");
const as = (personId: KinPersonId): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId, personId },
];

const layer = Layer.mergeAll(
  KinRecords.layer,
  Layer.mock(KinIdentity)({
    owner: { _tag: "person", orgId, personId: ownerId },
    isAgentThread: () => false,
    isLeadThread: () => false,
  }),
  Layer.mock(KinLevelGate)({
    ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
  }),
).pipe(
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-query-plans-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const created = "2026-01-01T00:00:00.000Z";
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${created})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${created}, 'owner'),
      (${memberId}, ${orgId}, 'zoya', 'Zoya', ${created}, 'member')`;
});

/**
 * A hot query, by the read that runs it: each statement `run` executes whose text matches `match`
 * must have a plan step that searches table alias `alias` with `index`.
 */
interface HotQuery {
  readonly name: string;
  readonly run: Effect.Effect<unknown, unknown, Layer.Success<typeof layer>>;
  readonly match: RegExp;
  readonly alias: string;
  readonly index: string;
}

/** Add a hot query here, one line each, once its index is in a migration. */
const HOT_QUERIES: ReadonlyArray<HotQuery> = [
  {
    name: "Work summary's closed count",
    run: Work.summary(as(ownerId), { orgId }),
    match: /COUNT\(\*\) AS closed/,
    alias: "r",
    index: "idx_kin_records_register",
  },
];

/** The plan steps for each statement `run` executes whose text matches `match`. */
const plansOf = Effect.fn("KinQueryPlans.plansOf")(function* (query: HotQuery) {
  const sql = yield* SqlClient.SqlClient;
  const ran: Array<readonly [string, ReadonlyArray<unknown>]> = [];
  const record: Statement.Transformer = (statement) =>
    Effect.sync(() => {
      const [text, params] = statement.compile();
      if (query.match.test(text)) ran.push([text, params]);
      return statement;
    });
  yield* query.run.pipe(Effect.provideService(Statement.CurrentTransformer, record));
  return yield* Effect.forEach(ran, ([text, params]) =>
    sql
      .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params)
      .pipe(Effect.map((rows) => rows.map((row) => row.detail))),
  );
});

it.effect("each hot Kin query searches with the index it was given", () =>
  Effect.gen(function* () {
    yield* seed;
    for (const query of HOT_QUERIES) {
      const plans = yield* plansOf(query);
      assert.isAbove(plans.length, 0, `${query.name}: no statement matched`);
      const step = new RegExp(`\\bSEARCH ${query.alias} USING (COVERING )?INDEX ${query.index}\\b`);
      for (const plan of plans)
        assert.isTrue(
          plan.some((detail) => step.test(detail)),
          `${query.name}: ${plan.join(" | ")}`,
        );
    }
  }).pipe(Effect.provide(layer)),
);
