import { assert, it } from "@effect/vitest";
import { KinChatId, KinPersonId, type MemoryItemHead } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

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
const testLayer = TriggerService.layer.pipe(
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
  (yield* FollowUps.KinFollowUpItems).remember(orgId, {
    head: "invented",
    items: heads.map((head) => ({ head, body: "" })),
    duplicateIds: new Set(),
  });
  const service = yield* TriggerService.KinTriggerService;
  for (const head of heads) yield* service.syncItem(head);
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
        agent: { agentId: "lead-a", name: "Chief of staff" },
        askedBy: { personId: zoya.personId, name: "Zoya" },
      });
      assert.deepInclude(all[1], { held: { section: "clients", sectionName: "Clients" } });
      assert.deepStrictEqual((yield* FollowUps.list(orgId, zoya)).followUps, [
        { ...all[0], title: "" },
      ]);
      assert.deepStrictEqual((yield* FollowUps.list(otherOrg, rhea)).followUps, []);
    }).pipe(Effect.provide(testLayer)),
);
