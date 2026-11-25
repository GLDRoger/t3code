import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinPersonId,
  KinWidgetId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { MemorySyncHooks } from "../memory/Memory.ts";
import { withRuns } from "../triggers/deferralRuns.ts";
import * as TriggerService from "../triggers/KinTriggerService.ts";
import { fixture, item, orgId, otherOrg, seed } from "../triggers/routines.testkit.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import * as FollowUps from "./followUps.ts";

const reader = (name: string, ownerLevel = false) => {
  const personId = KinPersonId.make(name);
  return { personId, viewer: ownerLevel ? KIN_OWNER_LEVEL : viewerOfPeople([personId]) };
};
const rhea = reader("owner-a", true);
const meera = reader("meera", true);
const zoya = reader("zoya");
const arjun = reader("arjun");
const dueAt = "2026-11-25T08:40:00.000Z";
const deferral = (id: string, overrides: Partial<MemoryItemHead> = {}) =>
  item(id, {
    kind: "deferral",
    path: `deferrals/${id}.md`,
    title: "Check the Tidewater Freight draft",
    due: dueAt,
    on_due: "start",
    said_by: "zoya",
    chat: KinChatId.make("chat-a"),
    links: [],
    ...overrides,
  });
const own = deferral("def-1");
const other = deferral("def-2", { said_by: "arjun", due: "2026-11-25T09:40:00.000Z" });
const held = deferral("def-3", { title: "Check C-1", said_by: "arjun" });
const heads = [other, held, own];
const testLayer = FollowUps.rememberSnapshots.pipe(
  Layer.provide(TriggerService.syncHooksLayer),
  Layer.provideMerge(TriggerService.layer),
  Layer.provideMerge(fixture(heads)),
  Layer.provideMerge(FollowUps.itemsLayer),
);

const setup = Effect.fn("test.followUpsSetup")(function* () {
  yield* TestClock.setTime(Date.parse(dueAt));
  yield* seed();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_people SET display_name = 'Rhea', access = 'owner'
    WHERE org_id = ${orgId} AND person_id = ${rhea.personId}`;
  yield* sql`UPDATE kin_agents SET display_name = 'Chief of staff'
    WHERE org_id = ${orgId} AND agent_id = 'lead-a'`;
  yield* sql`UPDATE kin_leads SET name = 'Chief of staff' WHERE org_id = ${orgId} AND agent_id = 'lead-a'`;
  for (const [person, name, access] of [
    [zoya, "Zoya", "member"],
    [arjun, "Arjun", "member"],
    [meera, "Meera", "co_owner"],
  ] as const) {
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
      VALUES (${person.personId}, ${orgId}, ${person.personId}, ${name}, ${access}, ${dueAt})`;
  }
  yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
    VALUES (${orgId}, '[{"id":"clients","on":false}]', 1, ${rhea.personId}, 0)`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'clients', 'Clients', 'C', 1, 0)`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, confirmed, created_by_kind, created_by_id, origin_key, created_at, updated_at, fields_json)
    VALUES (${orgId}, 'tidewater', 'clients', 'C-1', 'Tidewater Freight', 'open', 'person', ${rhea.personId},
      'ours', 1, 'person', ${rhea.personId}, 'invented-tidewater', 0, 0, '{}')`;
  const hooks = yield* MemorySyncHooks;
  yield* hooks.syncItems(orgId, {
    head: "invented",
    items: heads.map((head) => ({ head, body: "" })),
    duplicateIds: new Set(),
  });
});

it.effect(
  "lists one-time follow-ups by due time, scoped to the asker, with the due section hold",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const all = (yield* FollowUps.list(orgId, rhea)).followUps;
      assert.deepStrictEqual(
        all.map((one) => one.itemId),
        [own.id, held.id, other.id],
      );
      assert.deepInclude(all[0], {
        title: own.title,
        dueAt,
        onDue: "start",
        agent: { agentId: KinAgentId.make("lead-a"), name: "Chief of staff" },
        askedBy: { personId: zoya.personId, name: "Zoya" },
      });
      assert.deepInclude(all[1], { held: { section: "clients", sectionName: "Clients" } });
      assert.deepStrictEqual((yield* FollowUps.list(orgId, zoya)).followUps, [
        { ...all[0], title: "" },
      ]);
      assert.deepStrictEqual((yield* FollowUps.list(otherOrg, rhea)).followUps, []);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "stops only an own or owner-level follow-up, leaving the card and memory cancelled once",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const widget = repo.getWidget({
        orgId,
        widgetId: KinWidgetId.make(`deferral:${orgId}:${own.id}`),
      });
      const run = sql`SELECT state, updated_at FROM kin_deferral_runs WHERE org_id = ${orgId}
      AND item_id = ${own.id} ORDER BY item_id`;
      assert.include(yield* FollowUps.stop(orgId, arjun, own.id).pipe(Effect.flip), {
        reason: "not_allowed",
        message: "Only the person who asked for this, or an owner, can stop it.",
      });
      const events = yield* (yield* KinChatHub).subscribeAll;
      yield* FollowUps.stop(orgId, zoya, own.id);
      const closed = Option.getOrThrow(yield* widget);
      assert.equal(closed.closedAt, dueAt);
      assert.deepInclude(Option.getOrThrow(yield* Stream.runHead(events)), {
        type: "widget.updated",
        widget: closed,
      });
      assert.deepInclude(closed.state, { actions: [] });
      const stopped = yield* run;
      assert.deepStrictEqual(stopped, [{ state: "undone", updated_at: Date.parse(dueAt) }]);
      assert.deepStrictEqual(
        yield* sql`SELECT enabled, next_run_at FROM kin_triggers WHERE org_id = ${orgId}
        AND trigger_id IN (${`deferral:${own.id}:heads_up`}, ${`deferral:${own.id}:due`}) ORDER BY trigger_id`,
        [
          { enabled: 0, next_run_at: null },
          { enabled: 0, next_run_at: null },
        ],
      );
      assert.equal((yield* withRuns(orgId, [own]))[0]?.status, "cancelled");
      assert.deepStrictEqual((yield* FollowUps.list(orgId, zoya)).followUps, []);
      yield* TestClock.setTime(Date.parse(dueAt) + 1);
      yield* FollowUps.stop(orgId, zoya, own.id);
      assert.deepStrictEqual(yield* run, stopped);
      assert.deepStrictEqual(Option.getOrThrow(yield* widget), closed);
      assert.include(
        yield* FollowUps.stop(otherOrg, reader("owner-b", true), other.id).pipe(Effect.flip),
        { reason: "not_found" },
      );
      yield* FollowUps.stop(orgId, meera, other.id);
      assert.deepStrictEqual(
        (yield* FollowUps.list(orgId, rhea)).followUps.map((one) => one.itemId),
        [held.id],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
