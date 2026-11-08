import { assert, it } from "@effect/vitest";
import {
  KinChatId,
  KinDeferralCard,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as JudgeShadow from "../floor/JudgeShadow.ts";
import * as Memory from "../memory/Memory.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as TriggerService from "./KinTriggerService.ts";
import { item, orgId, otherOrg, seed } from "./routines.testkit.ts";

const decodeCard = Schema.decodeSync(Schema.fromJsonString(KinDeferralCard));
const now = Date.parse("2026-11-09T09:00:00.000Z");
const due = "2026-11-13T09:00+05:30";
const dueAt = Date.parse("2026-11-13T03:30:00.000Z");

const layer = TriggerService.syncHooksLayer.pipe(
  Layer.provideMerge(TriggerService.layer),
  Layer.provideMerge(
    Chat.layer.pipe(Layer.provide(JudgeShadow.layerOff), Layer.provideMerge(Hub.layer)),
  ),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
);

const deferral = (overrides: Partial<MemoryItemHead> = {}) =>
  item("def-1", {
    kind: "deferral",
    path: "deferrals/def-1.md",
    due,
    on_due: "start",
    chat: KinChatId.make(`chat-${overrides.orgId ?? orgId}`),
    ...overrides,
  });

const setup = Effect.fn("test.deferralSetup")(function* () {
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"21:00","to":"08:00"}')`;
  yield* TestClock.setTime(now);
  return { sql, service: yield* TriggerService.KinTriggerService };
});

const triggers = Effect.fn("test.deferralTriggers")(function* (org: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    id: string;
    enabled: number;
    nextRunAt: number | null;
    updatedAt: number;
  }>`SELECT trigger_id AS id, enabled, next_run_at AS "nextRunAt", updated_at AS "updatedAt"
    FROM kin_triggers WHERE org_id = ${org} ORDER BY trigger_id`;
});

const card = Effect.fn("test.deferralCard")(function* (org: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    revision: number;
    state: string;
    closedAt: string | null;
  }>`SELECT revision, state_json AS state, closed_at AS "closedAt" FROM kin_widgets
    WHERE org_id = ${org} AND type = 'deferral' ORDER BY widget_id`;
  return rows.map((row) => ({ ...row, state: decodeCard(row.state) }));
});

it.effect("arms from front matter, re-arms on edits, and re-syncs without writes", () =>
  Effect.gen(function* () {
    const { sql, service } = yield* setup();
    assert.equal(yield* service.syncItem(deferral()), "armed");
    const armed = yield* triggers(orgId);
    assert.deepEqual(
      armed.map(({ id, enabled, nextRunAt }) => [id, enabled, nextRunAt]),
      [
        ["deferral:def-1:due", 1, dueAt],
        ["deferral:def-1:heads_up", 1, dueAt - 30 * 60_000],
      ],
    );
    const [posted] = yield* card(orgId);
    assert.equal(posted?.state.text, "Deferred to Fri 13 Nov, 9:00. I'll start then.");
    const [message] = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${orgId} AND kind = 'system' ORDER BY message_id`;
    assert.equal(message?.body, posted?.state.text);

    yield* TestClock.adjust("1 minute");
    assert.equal(yield* service.syncItem(deferral()), "unchanged");
    yield* sql`UPDATE kin_triggers SET next_run_at = NULL WHERE org_id = ${orgId} AND trigger_id = 'deferral:def-1:due'`;
    assert.equal(yield* service.syncItem(deferral()), "unchanged");
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ nextRunAt, updatedAt }) => [nextRunAt, updatedAt]),
      [
        [null, now],
        [dueAt - 30 * 60_000, now],
      ],
    );
    assert.equal((yield* card(orgId))[0]?.revision, 1);

    const moved = "2026-11-16T09:00+05:30";
    assert.equal(yield* service.syncItem(deferral({ due: moved })), "armed");
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ nextRunAt }) => nextRunAt),
      [Date.parse(moved), Date.parse(moved) - 30 * 60_000],
    );
    assert.equal(yield* service.syncItem(deferral({ due: moved, on_due: "remind" })), "armed");
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ enabled, nextRunAt }) => [enabled, nextRunAt]),
      [
        [1, Date.parse(moved)],
        [0, null],
      ],
    );
    const [updated] = yield* card(orgId);
    assert.equal(updated?.revision, 3);
    assert.equal(updated?.state.text, "Deferred to Mon 16 Nov, 9:00. I'll remind you then.");
    const [run] = yield* sql<{ state: string; dueAt: number; onDue: string }>`
      SELECT state, due_at AS "dueAt", on_due AS "onDue" FROM kin_deferral_runs
      WHERE org_id = ${orgId} ORDER BY item_id`;
    assert.deepEqual(run, { state: "armed", dueAt: Date.parse(moved), onDue: "remind" });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["done", { status: "done" }],
  ["cancelled", { status: "cancelled" }],
  ["invalid_at", { invalid_at: "2026-11-09T09:00:00.000Z" }],
  ["pre-1970", { due: "1969-12-31" }],
  ["year-0", { due: "0000-01-01" }],
  ["missing", undefined],
] as const)("disarms on %s and re-arms when reopened", ([, overrides]) =>
  Effect.gen(function* () {
    const { sql, service } = yield* setup();
    yield* service.syncItem(deferral());
    if (overrides === undefined) yield* service.syncOrg(orgId, []);
    else assert.equal(yield* service.syncItem(deferral(overrides)), "disarmed");
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ enabled, nextRunAt }) => [enabled, nextRunAt]),
      [
        [0, null],
        [0, null],
      ],
    );
    assert.isNotNull((yield* card(orgId))[0]?.closedAt);
    const [run] = yield* sql<{ state: string }>`SELECT state FROM kin_deferral_runs
      WHERE org_id = ${orgId} ORDER BY item_id`;
    assert.equal(run?.state, "disarmed");
    assert.equal(
      yield* service.syncItem(
        overrides === undefined ? deferral({ status: "done" }) : deferral(overrides),
      ),
      "unchanged",
    );

    yield* service.syncOrg(orgId, [deferral()]);
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ enabled }) => enabled),
      [1, 1],
    );
    const [reopened] = yield* card(orgId);
    assert.isNull(reopened?.closedAt);
    assert.lengthOf(yield* card(orgId), 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps organizations apart", () =>
  Effect.gen(function* () {
    const { sql, service } = yield* setup();
    yield* service.syncItem(deferral());
    yield* service.syncItem(deferral({ orgId: otherOrg }));
    yield* service.syncOrg(orgId, [deferral({ orgId: otherOrg, status: "done" })]);
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ enabled }) => enabled),
      [0, 0],
    );
    assert.deepEqual(
      (yield* triggers(otherOrg)).map(({ enabled }) => enabled),
      [1, 1],
    );
    assert.equal((yield* card(otherOrg))[0]?.closedAt, null);

    const foreign = item("def-foreign", {
      kind: "deferral",
      path: "deferrals/def-foreign.md",
      due,
      chat: KinChatId.make(`chat-${otherOrg}`),
    });
    assert.equal(yield* service.syncItem(foreign), "armed");
    assert.lengthOf(
      yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${orgId} AND state_json LIKE '%def-foreign%' ORDER BY widget_id`,
      0,
    );
    const unknown = yield* service
      .syncItem(deferral({ orgId: KinOrgId.make("z") }))
      .pipe(Effect.flip);
    assert.equal(unknown._tag, "KinTriggerSyncError");
  }).pipe(Effect.provide(layer)),
);

it.effect("syncs each head once, retries failures, and isolates failing items", () =>
  Effect.gen(function* () {
    const { sql } = yield* setup();
    const hooks = yield* Memory.MemorySyncHooks;
    const other = deferral({ id: KinMemoryItemId.make("def-2"), path: "deferrals/def-2.md" });
    const snapshot = (
      head: string,
      items: ReadonlyArray<MemoryItemHead>,
      duplicateIds: ReadonlyArray<string> = [],
    ) => ({
      head,
      items: items.map((head) => ({ head, body: "" })),
      duplicateIds: new Set(duplicateIds),
    });
    const runs = () =>
      sql<{ itemId: string; state: string }>`SELECT item_id AS "itemId", state
        FROM kin_deferral_runs WHERE org_id = ${orgId} ORDER BY item_id`;
    yield* sql`CREATE TRIGGER fail_def_1 BEFORE INSERT ON kin_deferral_runs
      WHEN NEW.item_id = 'def-1' BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
    yield* hooks.syncItems(orgId, snapshot("h1", [deferral(), other]));
    assert.deepEqual(yield* runs(), [{ itemId: "def-2", state: "armed" }]);

    yield* sql`DROP TRIGGER fail_def_1`;
    yield* hooks.syncItems(orgId, snapshot("h1", [deferral(), other]));
    assert.deepEqual(yield* runs(), [
      { itemId: "def-1", state: "armed" },
      { itemId: "def-2", state: "armed" },
    ]);
    yield* sql`UPDATE kin_deferral_runs SET state = 'disarmed' WHERE org_id = ${orgId} AND item_id = 'def-2'`;
    yield* hooks.syncItems(orgId, snapshot("h1", [deferral(), other]));
    assert.equal((yield* runs())[1]?.state, "disarmed");

    const copy = deferral({ path: "deferrals/def-1-copy.md" });
    yield* hooks.syncItems(orgId, snapshot("h2", [deferral(), copy, other], ["def-1"]));
    assert.deepEqual(yield* runs(), [
      { itemId: "def-1", state: "disarmed" },
      { itemId: "def-2", state: "armed" },
    ]);
    assert.deepEqual(
      (yield* triggers(orgId)).map(({ id, enabled }) => [id, enabled]),
      [
        ["deferral:def-1:due", 0],
        ["deferral:def-1:heads_up", 0],
        ["deferral:def-2:due", 1],
        ["deferral:def-2:heads_up", 1],
      ],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses deferral cards from the model and taps until the dispatcher lands", () =>
  Effect.gen(function* () {
    const { service } = yield* setup();
    yield* service.syncItem(deferral());
    const chat = yield* Chat.KinChatService;
    const [posted] = yield* card(orgId);
    const upsert = yield* chat
      .upsertWidget(
        { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
        { chatId: KinChatId.make(`chat-${orgId}`), type: "deferral", state: posted!.state },
      )
      .pipe(Effect.flip);
    assert.equal(upsert._tag === "KinChatError" && upsert.reason, "not_allowed");
    const failure = yield* chat
      .act(
        { _tag: "person", orgId, personId: KinPersonId.make(`owner-${orgId}`) },
        {
          widgetId: KinWidgetId.make(`deferral:${orgId}:def-1`),
          revision: 1,
          actionId: "remind",
          value: KinMemoryItemId.make("def-1"),
          clientActionId: "remind",
        },
      )
      .pipe(Effect.flip);
    assert.equal(failure._tag === "KinChatError" && failure.reason, "not_allowed");
  }).pipe(Effect.provide(layer)),
);
