import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { admitted, layer, team } from "../tasksKey/tasksKey.testkit.ts";
import * as TasksKeys from "../tasksKey/TasksKeys.ts";
import { asPerson } from "../tasksKey/tasks.ts";
import { CodingAgentCall } from "./keyCall.ts";
import * as Work from "./ownerWork.ts";

const setup = Effect.gen(function* () {
  const { orgId, zoya } = yield* team;
  const { owner } = yield* KinIdentity;
  const mate = { ...owner, personId: zoya.personId };
  const task = yield* Work.create([owner], {
    orgId,
    clientRequestId: "01KAK0XMVCXC4FF969979K33DC",
    title: "Check Juniper Cold Chain's packing list",
    owner: { _tag: "person", personId: zoya.personId },
  });
  const input = { orgId, recordId: task.recordId };
  const sql = yield* SqlClient.SqlClient;
  const time = (personId: typeof zoya.personId) =>
    sql<{ lookedAt: number }>`SELECT looked_at AS "lookedAt" FROM kin_looks
      WHERE org_id = ${orgId} AND person_id = ${personId} AND record_id = ${task.recordId}`.pipe(
      Effect.map(([row]) => row?.lookedAt),
    );
  return { owner, mate, task, input, time, sql, zoya };
});

it.effect("an older mark from a second device cannot move a person's mark back", () =>
  Effect.gen(function* () {
    const { mate, input, time } = yield* setup;
    yield* TestClock.adjust(200);
    yield* Work.looked([mate], { ...input, upTo: "1970-01-01T00:00:00.120Z" });
    yield* Work.looked([mate], { ...input, upTo: "1970-01-01T00:00:00.100Z" });
    assert.strictEqual(yield* time(mate.personId), 120);
  }).pipe(Effect.provide(layer)),
);

it.effect("a future mark stops at the host clock", () =>
  Effect.gen(function* () {
    const { mate, input, time } = yield* setup;
    yield* TestClock.adjust(200);
    yield* Work.looked([mate], { ...input, upTo: "1970-01-01T00:00:01.000Z" });
    assert.strictEqual(yield* time(mate.personId), 200);
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate cannot mark a record the teammate cannot see", () =>
  Effect.gen(function* () {
    const { owner, mate, input, task, time } = yield* setup;
    yield* Work.update([owner], {
      orgId: input.orgId,
      key: task.key,
      rev: task.rev,
      sensitive: true,
      alsoOn: [],
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_records SET owner_id = ${owner.personId} WHERE record_id = ${task.recordId}`;
    const mark = { ...input, upTo: "1970-01-01T00:00:00.000Z" };
    assert.strictEqual((yield* Effect.flip(Work.looked([mate], mark))).reason, "not_found");
    assert.isUndefined(yield* time(mate.personId));
    assert.deepStrictEqual(yield* Work.looked([owner], mark), {});
  }).pipe(Effect.provide(layer)),
);

it.effect("an admitted coding-agent call still cannot mark the person's task", () =>
  Effect.gen(function* () {
    const { mate, input, time } = yield* setup;
    const error = yield* Work.looked([mate], { ...input, upTo: "1970-01-01T00:00:00.000Z" }).pipe(
      Effect.provideService(CodingAgentCall, "01KAK0XMVCXC4FF969979K33DC"),
      Effect.flip,
    );
    assert.strictEqual(error.reason, "not_found");
    assert.isUndefined(yield* time(mate.personId));
  }).pipe(Effect.provide(layer)),
);

it.effect("opening an entry gives an independent first-visit mark for each person", () =>
  Effect.gen(function* () {
    const { owner, mate, input } = yield* setup;
    const upTo = "1970-01-01T00:00:00.100Z";
    yield* TestClock.adjust(100);
    assert.isNull((yield* Work.get([owner], input)).lookedAt);
    yield* Work.looked([owner], { ...input, upTo });
    assert.strictEqual((yield* Work.get([owner], input)).lookedAt, upTo);
    assert.isNull((yield* Work.get([mate], input)).lookedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("reading an entry as the owner and as a teammate leaves the mark table empty", () =>
  Effect.gen(function* () {
    const { owner, mate, input, sql } = yield* setup;
    yield* Work.get([owner], input);
    yield* Work.get([mate], input);
    assert.deepStrictEqual(yield* sql`SELECT looked_at FROM kin_looks`, []);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["through its connection", "inside its call"] as const)(
  "a coding-agent key %s leaves the mark out of the entry",
  (path) =>
    Effect.gen(function* () {
      const { mate, input, zoya } = yield* setup;
      yield* Work.looked([mate], { ...input, upTo: "1970-01-01T00:00:00.000Z" });
      const key = yield* admitted(
        (yield* TasksKeys.issue(zoya.app, { orgId: input.orgId })).secret,
      );
      const { people, connection } = asPerson(key);
      const read =
        path === "through its connection"
          ? Work.get(people, input, connection)
          : Work.get(people, input).pipe(Effect.provideService(CodingAgentCall, key.sessionId));
      assert.notProperty(yield* read, "lookedAt");
    }).pipe(Effect.provide(layer)),
);
