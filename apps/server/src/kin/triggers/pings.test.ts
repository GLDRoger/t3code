import { assert, describe, it } from "@effect/vitest";
import {
  KinChatId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repo from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Pings from "./pings.ts";

const decodePerson = Schema.decodeEffect(KinPersonId);
const decodeItem = Schema.decodeEffect(KinMemoryItemId);
const decodeMessage = Schema.decodeEffect(KinMessageId);
const profileId = Schema.decodeSync(KinMemoryItemId)("person-profile");
const orgId = Schema.decodeSync(KinOrgId)("org");
const person = Schema.decodeSync(KinPersonId)("person");
const owner = Schema.decodeSync(KinPersonId)("owner");
const chatId = Schema.decodeSync(KinChatId)("chat");
const ownerChatId = Schema.decodeSync(KinChatId)("owner-chat");
const request = {
  orgId,
  person,
  owner,
  chatId,
  ownerChatId,
  itemId: Schema.decodeSync(KinMemoryItemId)("item"),
  nextStep: "Send the review",
};
const head = Schema.decodeSync(MemoryItemHead)({
  id: "item",
  orgId,
  path: "commitments/item.md",
  kind: "commitment",
  title: "Review",
  status: "open",
  due: null,
  recorded_at: "2026-01-01",
  valid_from: "2026-01-01",
  invalid_at: null,
  superseded_by: null,
  review_by: null,
  source: "fixture",
  said_by: "owner",
  trust: "owner",
  links: [],
});
const database = Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const dependencies = Chat.layer.pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repo.layer),
  Layer.provideMerge(Cache.layer),
  Layer.provideMerge(database),
);
function layer(
  profile?: { tz?: string; quiet_hours?: { from: string; to: string } },
  readHead: () => Effect.Effect<MemoryItemHead> = () => Effect.succeed(head),
) {
  return Pings.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(
      Layer.mock(Memory.Memory)({
        readItem: (_org, id) =>
          readHead().pipe(Effect.map((head) => ({ head: { ...head, id }, body: "" }))),
        query: () =>
          Effect.succeed(
            profile === undefined
              ? []
              : [
                  {
                    ...head,
                    id: profileId,
                    kind: "person",
                    path: "people/reviewer.md",
                    ...profile,
                    duplicate: false,
                  },
                ],
          ),
      }),
    ),
  );
}
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Fixture', '2026-01-01T00:00:00.000Z')`;
  for (const [id, handle] of [
    [person, "reviewer"],
    [owner, "owner"],
  ])
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES (${id}, ${orgId}, ${handle}, ${handle}, '2026-01-01T00:00:00.000Z')`;
  for (const [id, personId] of [
    [chatId, person],
    [ownerChatId, owner],
  ]) {
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at) VALUES (${id}, ${orgId}, 'project_group', 'Fixture', 0, '2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES (${id + "-member"}, ${orgId}, ${id}, 'person', ${personId}, 'owner', '2026-01-01T00:00:00.000Z')`;
  }
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/New_York', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')`;
});

describe("KinPings", () => {
  it.effect("deduplicates, batches, escalates once across DST, and stops after an answer", () =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
      assert.deepStrictEqual(yield* pings.put(request), request);
      assert.deepStrictEqual(yield* pings.put(request), request);
      assert.propertyVal(
        yield* Effect.flip(pings.put({ ...request, nextStep: "Different" })),
        "reason",
        "not_allowed",
      );
      assert.strictEqual(
        (yield* Effect.flip(pings.put({ ...request, person: yield* decodePerson("foreign") })))
          ._tag,
        "KinChatError",
      );
      assert.strictEqual(
        (yield* Effect.flip(pings.put({ ...request, nextStep: " " })))._tag,
        "KinChatError",
      );
      const chat = yield* Chat.KinChatService;
      yield* chat.send(
        { _tag: "person", orgId, personId: person },
        { chatId, clientMessageId: "before", body: "Earlier unrelated message" },
      );
      yield* pings.put({
        ...request,
        itemId: yield* decodeItem("item-2"),
      });
      yield* Effect.all([pings.sweep(orgId), pings.sweep(orgId)], { concurrency: "unbounded" });
      const messages = yield* sql<{
        body: string;
        author_kind: string;
      }>`SELECT body, author_kind FROM kin_messages WHERE org_id = ${orgId} AND author_kind = 'system' ORDER BY seq`;
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]?.author_kind, "system");
      assert.include(messages[0]?.body ?? "", "item-2");
      const noticeRequest = {
        messageId: yield* decodeMessage("activity"),
        orgId,
        chatId,
        body: "System activity is not an answer",
      };
      const notice = yield* chat.notice(noticeRequest);
      assert.deepStrictEqual(yield* chat.notice(noticeRequest), notice);
      assert.strictEqual(
        (yield* Effect.flip(chat.notice({ ...noticeRequest, body: "Changed" })))._tag,
        "KinChatError",
      );
      yield* TestClock.setTime(Date.parse("2026-11-02T15:00:00Z"));
      yield* pings.sweep(orgId);
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
        2,
      );
      yield* TestClock.setTime(Date.parse("2026-11-03T15:00:00Z"));
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
        2,
      );
      yield* chat.send(
        { _tag: "person", orgId, personId: person },
        { chatId, clientMessageId: "answer", body: "Review sent" },
      );
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} AND resolved_at IS NULL ORDER BY waiting_id`,
        0,
      );
      yield* TestClock.setTime(Date.parse("2026-11-04T15:00:00Z"));
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day, item_id`,
        6,
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect("escalates once per item across recipients and resolves on closure", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(head);
      yield* Effect.gen(function* () {
        yield* seed;
        const pings = yield* Pings.KinPings;
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(Date.parse("2026-10-31T14:00:00Z"));
        yield* pings.put(request);
        yield* pings.put({ ...request, person: owner, chatId: ownerChatId });
        yield* pings.sweep(orgId);
        yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
        yield* pings.sweep(orgId);
        assert.lengthOf(
          yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
          1,
        );
        yield* Ref.set(current, { ...head, status: "done" as const });
        yield* pings.sweep(orgId);
        assert.deepStrictEqual(
          yield* sql`SELECT resolution FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
          [{ resolution: "closed" }],
        );
        yield* TestClock.setTime(Date.parse("2026-11-02T15:00:00Z"));
        yield* pings.sweep(orgId);
        assert.lengthOf(
          yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day, person`,
          4,
        );
      }).pipe(Effect.provide(layer(undefined, () => Ref.get(current))));
    }),
  );

  it.effect("uses owner dates, not UTC dates or 24-hour intervals, across fall-back", () =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const sql = yield* SqlClient.SqlClient;
      yield* pings.put(request);
      for (const time of ["2026-11-01T04:30:00Z", "2026-11-02T04:30:00Z"]) {
        yield* TestClock.setTime(Date.parse(time));
        yield* pings.sweep(orgId);
      }
      assert.deepStrictEqual(
        yield* sql`SELECT day FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day`,
        [{ day: "2026-11-01" }],
      );
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
        0,
      );
      yield* TestClock.setTime(Date.parse("2026-11-02T05:00:00Z"));
      yield* pings.sweep(orgId);
      assert.deepStrictEqual(
        yield* sql`SELECT day FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day`,
        [{ day: "2026-11-01" }, { day: "2026-11-02" }],
      );
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
        1,
      );
    }).pipe(Effect.provide(layer({ quiet_hours: { from: "00:00", to: "00:00" } }))),
  );

  it.effect.each([
    {
      name: "overnight start",
      time: "2026-03-08T03:00:00Z",
      quiet: true,
      profile: { tz: "America/New_York", quiet_hours: { from: "22:00", to: "07:00" } },
    },
    { name: "overnight before end", time: "2026-03-08T10:59:00Z", quiet: true, profile: undefined },
    {
      name: "daytime quiet window",
      time: "2026-03-08T13:00:00Z",
      quiet: true,
      profile: { quiet_hours: { from: "08:00", to: "10:00" } },
    },
    {
      name: "equal bounds disable quiet hours",
      time: "2026-03-08T03:00:00Z",
      quiet: false,
      profile: { quiet_hours: { from: "00:00", to: "00:00" } },
    },
    {
      name: "DST quiet end",
      time: "2026-03-08T11:00:00Z",
      quiet: false,
      profile: { tz: "America/New_York", quiet_hours: { from: "22:00", to: "07:00" } },
    },
    {
      name: "invalid zone falls back",
      time: "2026-03-08T01:00:00Z",
      quiet: false,
      profile: { tz: "Invalid/Zone" },
    },
    { name: "missing person file", time: "2026-03-08T03:00:00Z", quiet: true, profile: undefined },
  ])("$name", (scenario) =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse(scenario.time));
      yield* pings.put(request);
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY item_id`,
        scenario.quiet ? 0 : 1,
      );
      if (scenario.quiet) {
        // Reconstruct the service against the same durable database, as after restart.
        yield* TestClock.setTime(Date.parse("2026-03-08T14:00:00Z"));
        yield* Effect.gen(function* () {
          yield* (yield* Pings.KinPings).sweep(orgId);
        }).pipe(Effect.provide(Pings.layer));
        const ledger = yield* sql<{
          day: string;
        }>`SELECT day FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day`;
        assert.deepStrictEqual(ledger, [{ day: "2026-03-08" }]);
      }
    }).pipe(Effect.provide(layer(scenario.profile))),
  );
});
