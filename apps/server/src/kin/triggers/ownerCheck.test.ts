import { assert, it } from "@effect/vitest";
import {
  KinEvent,
  KinEventId,
  KinChatId,
  KinWidgetId,
  KinPersonId,
  KinWakeupId,
  KinAgentId,
  KinOwnerCheckCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import * as Service from "../chat/KinChatService.ts";
import * as Queue from "../lead/KinEventQueue.ts";
import * as OwnerCheck from "./ownerCheck.ts";
import { fixture, seed, orgId, otherOrg, item } from "./routines.testkit.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCard = Schema.decodeSync(Schema.fromJsonString(KinOwnerCheckCard));
const decodeEvent = Schema.decodeSync(KinEvent);
const now = Date.parse("2026-11-09T09:00:00.000Z");
const memoryItems = [
  item("old-review", { review_by: "2026-11-01" }),
  item("misleading"),
  item("low-trust", { trust: "external" }),
  item("no-evidence", { links: [] }),
  item("last-review", { review_by: "2026-11-02" }),
  item("sixth", { links: [] }),
  item("invalid", { invalid_at: "2026-11-01", review_by: "2026-10-01" }),
  item("other", { orgId: otherOrg, review_by: "2026-10-01" }),
];
it.effect("picks five distinct, valid same-org items in the specified category order", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const report = {
      result: "done",
      summary: "Done",
      evidence: [],
      openQuestions: [],
      memorySuggestions: [],
      misleadingMemory: [{ itemId: "misleading", why: "Wrong evidence" }],
      parsed: true,
    };
    const json = yield* encodeJson(report);
    yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, 'worker-wakeup', 'lead-a', 'fixture', 0, 'completed', '[]')`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, thread_id, kind, model_json, provenance_json, status, report_json, started_at, ended_at) VALUES ('worker', ${orgId}, 'lead-a', 'worker-wakeup', 'thread', 'research', '{}', '{}', 'done', ${json}, 0, ${now})`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, thread_id, kind, model_json, provenance_json, status, report_json, started_at, ended_at) VALUES ('ancient-worker', ${orgId}, 'lead-a', 'worker-wakeup', 'thread-old', 'research', '{}', '{}', 'done', 'invalid ancient report', 0, ${now - 91 * 86_400_000})`;
    yield* TestClock.setTime(now);
    const service = yield* OwnerCheck.OwnerCheck;
    const selected = yield* service.select(orgId);
    assert.deepEqual(
      selected.map((item) => [item.itemId, item.reason]),
      [
        ["old-review", "past_review"],
        ["last-review", "past_review"],
        ["misleading", "misleading"],
        ["low-trust", "old_low_trust"],
        ["no-evidence", "no_evidence"],
      ],
    );
    assert.deepEqual(
      OwnerCheck.pickOwnerCheckItems(orgId, memoryItems.toReversed(), new Set(["misleading"]), now),
      selected,
    );
  }).pipe(Effect.provide(fixture(memoryItems))),
);

it.effect(
  "posts one native card per fire and routes owner taps to the writer without accepting model authority",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* TestClock.setTime(now);
      const service = yield* OwnerCheck.OwnerCheck;
      const chat = yield* Service.KinChatService;
      const queue = yield* Queue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* service.post(orgId, "weekly", yield* service.select(orgId));
      yield* service.post(orgId, "weekly", yield* service.select(orgId));
      const [widget] = yield* sql<{
        state_json: string;
      }>`SELECT state_json FROM kin_widgets WHERE org_id = ${orgId} ORDER BY widget_id`;
      const card = decodeCard(widget!.state_json);
      assert.equal(card.items[0]?.itemId, "old-review");
      assert.lengthOf(
        yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${orgId} ORDER BY widget_id`,
        1,
      );
      yield* chat
        .upsertWidget(
          { _tag: "person", orgId, personId: KinPersonId.make("owner-a") },
          { chatId: KinChatId.make("chat-a"), type: "owner_check", state: card },
        )
        .pipe(Effect.flip);
      yield* chat
        .act(
          { _tag: "person", orgId, personId: KinPersonId.make("owner-a") },
          {
            widgetId: KinWidgetId.make("owner-check:a:weekly"),
            revision: 1,
            actionId: "drop",
            value: "foreign-item",
            clientActionId: "forged-target",
          },
        )
        .pipe(Effect.flip);
      const staged: MemoryWriter.MemoryChange[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = Layer.mock(MemoryWriter.MemoryWriter)({
            stage: (_org, _wakeup, change) =>
              Effect.sync(() => {
                staged.push(change);
              }),
          });
          for (const [index, action] of (["keep", "update", "drop"] as const).entries()) {
            const message = yield* chat.act(
              { _tag: "person", orgId, personId: KinPersonId.make("owner-a") },
              {
                widgetId: KinWidgetId.make("owner-check:a:weekly"),
                revision: index + 1,
                actionId: action,
                value: card.items[index]!.itemId,
                clientActionId: action,
              },
            );
            yield* queue.enqueue(
              decodeEvent({
                _tag: "widget.action",
                orgId,
                eventId: action,
                agentId: "lead-a",
                receivedAt: "2026-11-09T09:00:00.000Z",
                dedupeKey: action,
                provenance: { _tag: "human", personId: "owner-a", memberId: "owner-member-a" },
                chatId: "chat-a",
                messageId: message.messageId,
                actionId: action,
              }),
            );
            yield* TestClock.adjust("20 seconds");
            const wakeupId = KinWakeupId.make(`review-${action}`);
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* queue.claim({
                  orgId,
                  agentId: KinAgentId.make("lead-a"),
                  wakeupId,
                  model: "fixture",
                });
                const result = yield* service
                  .act(orgId, wakeupId, KinEventId.make(action))
                  .pipe(Effect.provide(writer));
                assert.equal(result.action, action);
                const [updated] = yield* sql<{
                  revision: number;
                  closed_at: string | null;
                  state_json: string;
                }>`SELECT revision, closed_at, state_json FROM kin_widgets WHERE org_id = ${orgId} ORDER BY widget_id`;
                assert.equal(updated!.revision, index + 2);
                assert.equal(decodeCard(updated!.state_json).items[index]!.handled, action);
                assert.equal(updated!.closed_at !== null, index === 2);
                yield* queue.finish({ orgId, wakeupId, status: "completed" });
              }),
            );
          }
          assert.lengthOf(staged, 2);
          assert.equal(staged[0]?.sourceEventId, "keep");
          assert.include(staged[0]!.content, "2026-12-09T09:00:20.000Z");
          assert.include(staged[1]!.content, "2026-11-09T09:01:00.000Z");
          for (const [org, eventId, wakeup] of [
            [otherOrg, "keep", "review-keep"],
            [orgId, "keep", "foreign-wakeup"],
          ] as const) {
            const result = yield* service
              .act(org, wakeup, KinEventId.make(eventId))
              .pipe(Effect.provide(writer), Effect.flip);
            assert.equal(result._tag, "OwnerCheckError");
          }
          yield* sql`UPDATE kin_chat_members SET role = 'member' WHERE org_id = ${orgId} AND member_id = 'owner-member-a'`;
          yield* service
            .act(orgId, "review-keep", KinEventId.make("keep"))
            .pipe(Effect.provide(writer), Effect.flip);
          assert.lengthOf(staged, 2);
          yield* chat
            .act(
              { _tag: "person", orgId, personId: KinPersonId.make("owner-a") },
              {
                widgetId: KinWidgetId.make("owner-check:a:weekly"),
                revision: 1,
                actionId: "keep",
                value: "old-review",
                clientActionId: "revoked-owner",
              },
            )
            .pipe(Effect.flip);
        }),
      );
    }).pipe(
      Effect.provide(
        fixture(
          memoryItems
            .slice(0, 3)
            .map((item, index) => ({ ...item, review_by: `2026-11-0${index + 1}` })),
        ),
      ),
    ),
);
