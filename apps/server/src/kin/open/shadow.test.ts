// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Shadow from "./shadow.ts";

// Invented company and people only: Ambermill.
const orgId = KinOrgId.make("ambermill");
const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const NOW = Date.UTC(2026, 10, 19, 9, 15);
const stamp = "2026-10-01T00:00:00.000Z";

const base: Shadow.ShadowInput = {
  level: "member",
  old: {
    facts: ["fact:task_late:W-1"],
    records: new Set(["W-1"]),
    factRecords: new Map([["fact:task_late:W-1", "W-1"]]),
    waiting: ["wait-1"],
    mine: ["W-1", "W-2"],
    owed: false,
    briefWaiting: 0,
  },
  next: {
    facts: ["fact:task_late:W-1"],
    waiting: ["wait-1"],
    mine: ["W-2"],
    owed: false,
    needsYou: 3,
    waitingCount: 1,
  },
  settled: new Map(),
};
const decodeLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ viewer: Schema.String, level: Schema.String, ok: Schema.Boolean }),
  ),
);
const keys = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => `W-${from + index}`);

describe("compare", () => {
  it.each([
    { name: "the same list", input: base, ok: true, unexplained: [] },
    {
      name: "a card whose send was voided is intended",
      input: {
        ...base,
        old: { ...base.old, waiting: ["wait-1", "wait-2"] },
        settled: new Map([["wait-2", "send_not_open" as const]]),
      },
      ok: true,
      unexplained: [],
      intended: { approval_not_live: 0, send_not_open: 1, question_settled: 0 },
    },
    {
      name: "tasks past today's cap of 20 are intended",
      input: {
        ...base,
        old: { ...base.old, mine: keys(20, 10) },
        next: { ...base.next, mine: keys(23, 10) },
      },
      ok: true,
      unexplained: [],
      overCap: 3,
    },
    {
      name: "a waiting card only the new list has is unexplained",
      input: { ...base, next: { ...base.next, waiting: ["wait-1", "wait-9"] } },
      ok: false,
      unexplained: ["+waiting:wait-9"],
    },
    {
      name: "a task only the old list had is unexplained",
      input: { ...base, next: { ...base.next, mine: [] } },
      ok: false,
      unexplained: ["-task:W-2"],
    },
  ])("$name", ({ input, ok, unexplained, intended, overCap }) => {
    const line = Shadow.compare(input);
    assert.strictEqual(line.ok, ok);
    assert.deepStrictEqual(
      [
        ...line.facts.unexplained,
        ...line.waiting.unexplained,
        ...line.mine.unexplained,
        ...line.money.unexplained,
      ],
      unexplained,
    );
    if (intended !== undefined) assert.deepStrictEqual(line.waiting.intended, intended);
    if (overCap !== undefined) assert.strictEqual(line.mine.intended.over_cap, overCap);
  });

  it("totals pair today's numbers with the list's, where each applies", () => {
    assert.deepStrictEqual(Shadow.compare(base).totals, {
      badge: [2, 3],
      pane: [3, 3],
      tasksBlock: null,
      briefWaiting: null,
    });
    assert.deepStrictEqual(
      Shadow.compare({ ...base, level: "owner", old: { ...base.old, briefWaiting: 2 } }).totals,
      { badge: [1, 3], pane: [3, 3], tasksBlock: [1, 3], briefWaiting: [2, 1] },
    );
  });
});

describe("layer", () => {
  const ticks = new Map<string, Effect.Effect<void>>();
  const scheduler = Layer.succeed(Scheduler.Scheduler, {
    register: Effect.fn("KinOpenShadowTest.register")(function* <E, R>(
      name: string,
      work: Effect.Effect<void, E, R>,
    ) {
      const context = yield* Effect.context<R>();
      ticks.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
    }),
  });
  const identity = Layer.mock(KinIdentity)({
    owner: { _tag: "person" as const, orgId, personId: rhea },
    isAgentThread: () => false,
    isLeadThread: () => false,
  });
  const layer = Shadow.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(scheduler, identity, KinChatRepository.layer)),
    Layer.provideMerge(KinPersistence.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-open-shadow-" })),
    Layer.provideMerge(NodeServices.layer),
  );

  it.effect("each pass writes one line per person, and passes run 15 minutes apart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(NOW);
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief,
          evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check,
          quiet_hours_json)
        VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '[]')`;
      for (const [person, access, removed] of [
        [rhea, "owner", null],
        [meera, "member", null],
        ["dev", "member", NOW - 1],
      ] as const)
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access, removed_at)
          VALUES (${person}, ${orgId}, ${person}, ${person}, ${stamp}, ${access}, ${removed})`;
      const tick = ticks.get("kin-open-shadow");
      if (tick === undefined) return yield* Effect.die(new Error("Not registered."));
      const { serverTracePath } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const file = path.join(path.dirname(serverTracePath), Shadow.SHADOW_FILE);
      const lines = Effect.map((yield* FileSystem.FileSystem).readFileString(file), (text) =>
        text
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => decodeLine(line)),
      );

      yield* tick;
      const first = yield* lines;
      assert.deepStrictEqual(
        first.map((line) => [line.viewer, line.level, line.ok]),
        [
          ["meera", "member", true],
          ["rhea", "owner", true],
        ],
      );
      yield* tick;
      assert.lengthOf(yield* lines, 2, "a tick inside the 15 minutes writes nothing");
      yield* TestClock.adjust("15 minutes");
      yield* tick;
      assert.lengthOf(yield* lines, 4);
    }).pipe(Effect.provide(layer)),
  );
});
