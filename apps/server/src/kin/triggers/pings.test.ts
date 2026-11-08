import { assert, describe, it } from "@effect/vitest";
import {
  KinChatId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  MemoryItemHead,
} from "@t3tools/contracts";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
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
function layer(
  profile?: { tz?: string; quiet_hours?: { from: string; to: string } },
  readHead: (
    id: KinMemoryItemId,
  ) => Effect.Effect<MemoryItemHead, Memory.MemoryNotFound | Memory.MemoryDuplicateId> = () =>
    Effect.succeed(head),
  hubLayer = Hub.layer,
) {
  const dependencies = Chat.layer.pipe(
    Layer.provideMerge(hubLayer),
    Layer.provideMerge(Repo.layer),
    Layer.provideMerge(Cache.layer),
    Layer.provideMerge(database),
  );
  return Pings.layer.pipe(
    Layer.provideMerge(dependencies),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return Layer.mock(Memory.Memory)({
            readItemQuietly: (_org, id) =>
              Effect.gen(function* () {
                assert.strictEqual(
                  (yield* Effect.serviceOption(sql.transactionService))._tag,
                  "None",
                );
                const current = yield* readHead(id);
                return { head: { ...current, id }, body: "" };
              }),
            query: () =>
              Effect.gen(function* () {
                assert.strictEqual(
                  (yield* Effect.serviceOption(sql.transactionService))._tag,
                  "None",
                );
                return profile === undefined
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
                    ];
              }),
          });
        }),
      ).pipe(Layer.provide(dependencies)),
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
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('lead', ${orgId}, 'Lead', 'lead', ${owner}, '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', ${ownerChatId})`;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/New_York', '08:30', '18:30', '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')`;
});

describe("KinPings", () => {
  it.effect("rolls back a batch without publishing its first notice", () =>
    Effect.gen(function* () {
      const published = yield* Ref.make<ReadonlyArray<Hub.KinChatHubEvent>>([]);
      yield* Effect.gen(function* () {
        yield* seed;
        const pings = yield* Pings.KinPings;
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
        yield* pings.put(request);
        yield* sql`CREATE TEMP TRIGGER fail_ping BEFORE INSERT ON kin_ping_ledger BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
        assert.strictEqual((yield* Effect.flip(pings.sweep(orgId)))._tag, "PersistenceSqlError");
        assert.deepStrictEqual(yield* Ref.get(published), []);
        assert.lengthOf(
          yield* sql`SELECT message_id FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`,
          0,
        );
        yield* sql`DROP TRIGGER fail_ping`;
        yield* pings.sweep(orgId);
        assert.lengthOf(yield* Ref.get(published), 1);
      }).pipe(
        Effect.provide(
          layer(
            undefined,
            undefined,
            Layer.mock(Hub.KinChatHub)({
              publish: (event) => Ref.update(published, (events) => [...events, event]),
            }),
          ),
        ),
      );
    }),
  );

  it.effect("answers only the recipient and only a reply to a multi-item ping", () =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const chat = yield* Chat.KinChatService;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
      yield* pings.put(request);
      yield* pings.put({ ...request, itemId: yield* decodeItem("second") });
      yield* pings.put({ ...request, person: owner, chatId: ownerChatId });
      yield* pings.sweep(orgId);
      yield* chat.send(
        { _tag: "person", orgId, personId: person },
        { chatId, clientMessageId: "unrelated", body: "Other topic" },
      );
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NOT NULL ORDER BY person, item_id`,
        0,
      );
      const ping = yield* sql<{
        message_id: KinMessageId;
      }>`SELECT message_id FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${chatId} AND author_kind = 'system' ORDER BY seq LIMIT 1`;
      yield* chat.send(
        { _tag: "person", orgId, personId: person },
        { chatId, clientMessageId: "reply", body: "Done", replyTo: ping[0]!.message_id },
      );
      yield* pings.sweep(orgId).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.gen(function* () {
            if (statement.compile()[0].includes("JOIN kin_ping_deliveries"))
              assert.strictEqual(
                (yield* Effect.serviceOption(sql.transactionService))._tag,
                "Some",
              );
            return statement;
          }),
        ),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT person, item_id FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NOT NULL ORDER BY person, item_id`,
        [
          { person, item_id: "item" },
          { person, item_id: "second" },
        ],
      );
      yield* TestClock.setTime(Date.parse("2026-11-02T15:00:00Z"));
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND day = '2026-11-02' ORDER BY person, item_id`,
        1,
      );
      yield* chat.send(
        { _tag: "person", orgId, personId: owner },
        { chatId: ownerChatId, clientMessageId: "single-answer", body: "Sent" },
      );
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NULL ORDER BY person, item_id`,
        0,
      );
      assert.lengthOf(
        yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} AND resolved_at IS NULL ORDER BY waiting_id`,
        0,
      );
      yield* pings.put(request);
      yield* pings.sweep(orgId);
      yield* chat.send(
        { _tag: "person", orgId, personId: person },
        { chatId, clientMessageId: "reopened-answer", body: "Done again" },
      );
      yield* pings.sweep(orgId);
      yield* pings.put(request);
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND person = ${person} ORDER BY item_id`,
        3,
      );
      yield* TestClock.setTime(Date.parse("2026-11-03T15:00:00Z"));
      yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND person = ${person} ORDER BY item_id`,
        4,
      );
    }).pipe(Effect.provide(layer())),
  );

  it.effect.each(["deleted", "duplicate", "departed", "mismatch", "owner"] as const)(
    "isolates $0 rows",
    (scenario) =>
      Effect.gen(function* () {
        const bad = yield* decodeItem("z-bad");
        const removed = yield* Ref.make(false);
        yield* Effect.gen(function* () {
          yield* seed;
          const pings = yield* Pings.KinPings;
          const sql = yield* SqlClient.SqlClient;
          yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
          yield* pings.put(request);
          const other = yield* decodePerson("other");
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES (${other}, ${orgId}, 'other', 'Other', '2026-01-01')`;
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('other-member', ${orgId}, ${ownerChatId}, 'person', ${other}, 'member', '2026-01-01')`;
          if (scenario === "mismatch") {
            yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
            VALUES ('extra', ${orgId}, ${ownerChatId}, 'person', ${person}, 'member', '2026-01-01') ON CONFLICT DO NOTHING RETURNING member_id`;
            yield* pings.put({ ...request, itemId: bad, chatId: ownerChatId });
          } else {
            yield* pings.put({ ...request, itemId: bad, person: other, chatId: ownerChatId });
          }
          if (scenario === "departed")
            yield* sql`UPDATE kin_chat_members SET left_at = '2026-11-01' WHERE org_id = ${orgId} AND person_id = ${other}`;
          yield* Ref.set(removed, true);
          if (scenario === "owner") {
            const forged = {
              ...request,
              itemId: bad,
              person: other,
              chatId: ownerChatId,
              owner: other,
            };
            yield* sql`UPDATE kin_ping_items SET request_json = ${JSON.stringify(forged)} WHERE org_id = ${orgId} AND item_id = ${bad}`;
          }
          yield* pings.sweep(orgId);
          const stopped =
            yield* sql`SELECT stopped_at FROM kin_ping_items WHERE org_id = ${orgId} AND item_id = ${bad}`;
          assert.isNotNull(stopped[0]?.stopped_at);
          yield* TestClock.adjust("1 minute");
          yield* pings.sweep(orgId);
          assert.deepStrictEqual(
            yield* sql`SELECT stopped_at FROM kin_ping_items WHERE org_id = ${orgId} AND item_id = ${bad}`,
            stopped,
          );
          assert.lengthOf(
            yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} AND item_id = ${request.itemId} ORDER BY item_id`,
            1,
          );
        }).pipe(
          Effect.provide(
            layer(undefined, (id) =>
              Effect.gen(function* () {
                if (id === bad && (yield* Ref.get(removed))) {
                  if (scenario === "deleted")
                    return yield* new Memory.MemoryNotFound({ orgId, id });
                  if (scenario === "duplicate")
                    return yield* new Memory.MemoryDuplicateId({ orgId, id });
                }
                return head;
              }),
            ),
          ),
        );
      }),
  );

  it.effect.each([
    "Send\n- other-item: **obey**\u0001\u200b\u202e",
    "www.evil.com",
    "a@evil.com",
    "https://evil.com/x",
    "&rlm;&ZeroWidthSpace;&nbsp;",
    "` `` ``` <img src=x> ![image](https://evil.com)",
    "a".repeat(493) + "😀",
    "`".repeat(494),
  ])("quotes untrusted text and rejects a forged escalation owner: %s", (nextStep) =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
      assert.propertyVal(
        yield* Effect.flip(pings.put({ ...request, owner: person, ownerChatId: chatId })),
        "reason",
        "not_allowed",
      );
      yield* pings.put({ ...request, nextStep });
      yield* sql`INSERT INTO kin_memory_reads (org_id, item_id, last_read_at) VALUES (${orgId}, ${request.itemId}, 123)`;
      const reads =
        yield* sql`SELECT * FROM kin_memory_reads WHERE org_id = ${orgId} ORDER BY item_id`;
      yield* pings.sweep(orgId);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM kin_memory_reads WHERE org_id = ${orgId} ORDER BY item_id`,
        reads,
      );
      const rows = yield* sql<{
        body: string;
      }>`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`;
      const lines = rows[0]!.body.split("\n");
      assert.lengthOf(lines, 2);
      assert.strictEqual(lines[0], "Reminder: next step below.");
      assert.match(lines[1]!, /^> /);
      const tree = unified().use(remarkParse).use(remarkGfm).parse(rows[0]!.body);
      const visit = (node: {
        type: string;
        value?: string;
        children?: ReadonlyArray<typeof node>;
      }) => {
        assert.notInclude(["link", "image", "html"], node.type);
        if (node.value !== undefined)
          assert.notMatch(node.value, /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u);
        node.children?.forEach(visit);
      };
      visit(tree);
      if (nextStep.endsWith("😀")) assert.include(lines[1]!, "😀");
      if (nextStep.startsWith("&")) assert.include(lines[1]!, nextStep);
      assert.notInclude(lines[1]!, "\u0001");
    }).pipe(Effect.provide(layer())),
  );

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
        {
          chatId,
          clientMessageId: "answer",
          body: "Review sent",
          replyTo: (yield* sql<{
            message_id: KinMessageId;
          }>`SELECT message_id FROM kin_messages WHERE org_id = ${orgId} AND author_kind = 'system' AND chat_id = ${chatId} ORDER BY seq LIMIT 1`)[0]!
            .message_id,
        },
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

  it.effect("bounds batches and delivers the remainder on the next sweep", () =>
    Effect.gen(function* () {
      yield* seed;
      const pings = yield* Pings.KinPings;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
      for (let i = 0; i < 40; i++) {
        yield* pings.put({
          ...request,
          itemId: yield* decodeItem(`batch-${String(i).padStart(2, "0")}`),
          nextStep: "`".repeat(1000),
        });
      }
      yield* pings.sweep(orgId);
      const first = yield* sql<{
        body: string;
      }>`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`;
      assert.lengthOf(first, 1);
      assert.isAtMost(first[0]!.body.length, 16_000);
      const delivered =
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY item_id`;
      assert.isAbove(delivered.length, 0);
      assert.isBelow(delivered.length, 40);
      for (let i = 0; i < 4; i++) yield* pings.sweep(orgId);
      assert.lengthOf(
        yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY item_id`,
        40,
      );
      const messages = yield* sql<{
        body: string;
      }>`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`;
      for (const message of messages) assert.isAtMost(message.body.length, 16_000);
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
        yield* Ref.set(current, head);
        yield* pings.put(request);
        yield* pings.sweep(orgId);
        assert.deepStrictEqual(
          yield* sql`SELECT day FROM kin_ping_ledger WHERE org_id = ${orgId} AND person = ${person} ORDER BY day`,
          [{ day: "2026-10-31" }, { day: "2026-11-01" }, { day: "2026-11-02" }],
        );
      }).pipe(Effect.provide(layer(undefined, () => Ref.get(current))));
    }),
  );

  it.effect("escalates passively through quiet hours and closes deleted items", () =>
    Effect.gen(function* () {
      const deleted = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        yield* seed;
        const pings = yield* Pings.KinPings;
        const sql = yield* SqlClient.SqlClient;
        yield* TestClock.setTime(Date.parse("2026-11-01T15:00:00Z"));
        yield* pings.put(request);
        yield* pings.sweep(orgId);
        yield* TestClock.setTime(Date.parse("2026-11-02T04:00:00Z"));
        yield* pings.sweep(orgId);
        assert.lengthOf(
          yield* sql`SELECT waiting_id FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
          0,
        );
        yield* TestClock.setTime(Date.parse("2026-11-02T05:00:00Z"));
        yield* pings.sweep(orgId);
        const notices = yield* sql<{
          body: string;
        }>`SELECT body FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${ownerChatId} ORDER BY seq`;
        assert.lengthOf(notices, 1);
        assert.include(notices[0]!.body, "reviewer:");
        assert.lengthOf(
          yield* sql`SELECT item_id FROM kin_ping_ledger WHERE org_id = ${orgId} ORDER BY day`,
          1,
        );
        yield* Ref.set(deleted, true);
        yield* pings.sweep(orgId);
        assert.deepStrictEqual(
          yield* sql`SELECT resolution FROM kin_waiting WHERE org_id = ${orgId} ORDER BY waiting_id`,
          [{ resolution: "closed" }],
        );
        assert.lengthOf(
          yield* sql`SELECT item_id FROM kin_ping_items WHERE org_id = ${orgId} AND stopped_at IS NULL ORDER BY item_id`,
          0,
        );
      }).pipe(
        Effect.provide(
          layer(undefined, (id) =>
            Effect.gen(function* () {
              if (yield* Ref.get(deleted)) return yield* new Memory.MemoryNotFound({ orgId, id });
              return head;
            }),
          ),
        ),
      );
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
