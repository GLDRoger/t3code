import { assert, describe, it } from "@effect/vitest";
import { KinChatId, KinMemberId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Hub from "./KinChatHub.ts";

const layer = Layer.provideMerge(Hub.layer, Sqlite.layerMemory);
const orgId = Schema.decodeSync(KinOrgId)("org-a");
const otherOrg = Schema.decodeSync(KinOrgId)("org-b");
const event: Hub.KinChatHubEvent = {
  type: "read.updated",
  orgId,
  chatId: Schema.decodeSync(KinChatId)("chat"),
  memberId: Schema.decodeSync(KinMemberId)("member"),
  seq: 1,
};

describe("KinChatHub", () => {
  it.effect(
    "isolates org subscriptions and delivers only after the outer commit, discarding rollbacks",
    () =>
      Effect.gen(function* () {
        const hub = yield* Hub.KinChatHub;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* hub.subscribe(orgId);
        const second = yield* hub.subscribe(orgId);
        const other = yield* hub.subscribe(otherOrg);
        yield* sql`CREATE TABLE chat_hub_test (seq INTEGER)`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO chat_hub_test VALUES (1)`;
            yield* sql.withTransaction(hub.publish(event));
            assert.deepStrictEqual(yield* PubSub.takeUpTo(first, 10), []);
            yield* sql
              .withTransaction(
                hub
                  .publish({ ...event, seq: 2 })
                  .pipe(Effect.andThen(Effect.fail("nested rollback"))),
              )
              .pipe(Effect.flip);
          }),
        );
        assert.deepStrictEqual(yield* PubSub.take(first), event);
        assert.deepStrictEqual(yield* PubSub.take(second), event);
        assert.deepStrictEqual(yield* sql`SELECT seq FROM chat_hub_test ORDER BY seq`, [
          { seq: 1 },
        ]);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO chat_hub_test VALUES (3)`;
              yield* hub.publish({ ...event, seq: 3 });
              return yield* Effect.fail("outer rollback");
            }),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(yield* PubSub.takeUpTo(first, 10), []);
        assert.deepStrictEqual(yield* PubSub.takeUpTo(second, 10), []);
        assert.deepStrictEqual(yield* PubSub.takeUpTo(other, 10), []);
        yield* hub.publish({ ...event, orgId: otherOrg });
        assert.deepStrictEqual(yield* PubSub.take(other), { ...event, orgId: otherOrg });
        assert.deepStrictEqual(yield* sql`SELECT seq FROM chat_hub_test ORDER BY seq`, [
          { seq: 1 },
        ]);
      }).pipe(Effect.provide(layer)),
  );
});
