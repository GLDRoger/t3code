import * as Chat from "../chat/KinChatService.ts";

import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEventId,
  KinMessageId,
  KinOrgId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { Scheduler } from "../../scheduling/Scheduler.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinFloor } from "../floor/KinFloor.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as TaskCard from "../widgets/taskCard.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as Delivery from "./LeadDelivery.ts";

const layer = Delivery.layer.pipe(
  Layer.provideMerge(
    Chat.layer.pipe(
      Layer.provide(Layer.mock(KinFloor)({})),
      Layer.provide(TaskCard.layer),
      Layer.provideMerge(Hub.layer),
      Layer.provideMerge(Repository.layer),
    ),
  ),
  Layer.provide(Layer.mock(KinEventQueue)({})),
  Layer.provide(Layer.mock(Scheduler)({ register: () => Effect.void })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const deliveryCases = [
  "reminder",
  "scheduled_task",
  "card_tap",
  "card_tap_retry",
  "card_tap_retry_twice",
  "card_tap_refused_retry",
] as const;

it.effect.each(deliveryCases)(
  "settles a %s delivery against the appropriate reply or earlier failure notices",
  (kind) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const delivery = yield* Delivery.KinLeadDelivery;
      const at = "1970-01-01T00:00:00.000Z";
      const orgId = KinOrgId.make("company");
      const chatId = KinChatId.make("chat");
      const eventId = KinEventId.make("event");
      const agentId = KinAgentId.make("lead");
      const widgetId = KinWidgetId.make("report");
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Tidewater Freight', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', ${orgId}, 'rhea', 'Rhea', ${at}), ('co-owner', ${orgId}, 'meera', 'Meera', ${at})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${agentId}, ${orgId}, 'Lead', 'lead', 'owner', ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key)
        VALUES (${chatId}, ${orgId}, 'direct', 3, ${at}, 'owner:lead')`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES ('owner-member', ${orgId}, ${chatId}, 'person', 'owner', NULL, 'owner', ${at}),
          ('lead-member', ${orgId}, ${chatId}, 'agent', NULL, ${agentId}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_leads (org_id, agent_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${orgId}, ${agentId}, 'Lead', 0, '{}', '[]', ${chatId})`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, ended_at, status, event_ids)
        VALUES ('wake', ${orgId}, ${agentId}, 'thread', 'test', 0, 0, 'completed', '["event"]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
        VALUES (${eventId}, ${orgId}, ${agentId}, 'deferral.due', 'P1', '{}', 0, 0, 'done', 'wake')`;
      if (kind !== "reminder" && kind !== "scheduled_task") {
        yield* sql`INSERT INTO kin_chat_members
          (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('co-owner-member', ${orgId}, ${chatId}, 'person', 'co-owner', 'member', ${at})`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_role, kind, body, mentions_json, status, created_at)
          VALUES ('notice-card', ${orgId}, ${chatId}, 1, 'system', 'member', 'system', '', '[]', 'posted', ${at})`;
        const answeredBy = (personId: string) =>
          JSON.stringify({
            question: "Send the report?",
            detail: null,
            options: [
              { optionId: "option-1", label: "Wait" },
              { optionId: "option-2", label: "Send" },
            ],
            answer: { optionId: "option-2", personId, via: "tap", emoji: null, answeredAt: at },
          });
        const hub = yield* Hub.KinChatHub;
        const events = yield* hub.subscribeAll;
        const failCount = kind === "card_tap_retry_twice" ? 2 : kind === "card_tap" ? 0 : 1;
        const failIds = Array.from({ length: failCount }, (_, index) =>
          KinEventId.make(`failed-${index}`),
        );
        let revision = 2;
        yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
          revision, state_json, awaiting_json, updated_at, closed_at)
          VALUES (${widgetId}, ${orgId}, ${chatId}, 'notice-card', 'native', 'choice', ${revision},
            ${answeredBy("owner")}, '[]', ${at}, ${at})`;
        const attempt = (eventId: KinEventId, personId: string, revision: number) =>
          ({
            orgId,
            eventId,
            kind: "card_tap",
            agentId,
            chatId,
            widget: {
              widgetId,
              type: "choice",
              state: { personId, revision, optionId: "option-2", label: "Send", agentName: "Lead" },
            },
            fallbackBody: "",
            deadlineAt: 60_000,
          }) satisfies Delivery.Delivery;
        const failureMessages = sql`SELECT message_id AS id, status FROM kin_messages
          WHERE chat_id = ${chatId} AND message_id LIKE 'kin-card-tap-failed:%' ORDER BY seq`;
        for (const [index, failedId] of failIds.entries()) {
          const failed = attempt(failedId, "owner", revision);
          if (kind === "card_tap_refused_retry") yield* delivery.fallback(failed);
          else {
            yield* delivery.track(failed);
            yield* delivery.settleCardTaps(orgId, [failedId]);
          }
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM kin_lead_deliveries WHERE event_id = ${failedId}`,
            [{ status: "fallback" }],
          );
          assert.deepStrictEqual(
            yield* failureMessages,
            failIds.slice(0, index + 1).map((id) => ({
              id: `kin-card-tap-failed:${id}`,
              status: "posted",
            })),
          );
          assert.deepStrictEqual(
            yield* sql`SELECT revision, closed_at FROM kin_widgets WHERE widget_id = ${widgetId}`,
            [{ revision: revision + 1, closed_at: null }],
          );
          revision += 2;
          yield* sql`UPDATE kin_widgets SET revision = ${revision},
            state_json = ${answeredBy(index + 1 === failCount ? "co-owner" : "owner")},
            closed_at = ${at} WHERE widget_id = ${widgetId}`;
        }
        const finalPerson = failCount === 0 ? "owner" : "co-owner";
        yield* delivery.track(attempt(eventId, finalPerson, revision));
        yield* delivery.settle(orgId);
        assert.deepStrictEqual(
          yield* sql`SELECT status, message_id AS id FROM kin_lead_deliveries
          WHERE event_id = ${eventId}`,
          [{ status: "delivered", id: null }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT revision, state_json, closed_at FROM kin_widgets
          WHERE widget_id = ${widgetId}`,
          [{ revision, state_json: answeredBy(finalPerson), closed_at: at }],
        );
        assert.deepStrictEqual(
          yield* failureMessages,
          failIds.map((id) => ({ id: `kin-card-tap-failed:${id}`, status: "dismissed" })),
        );
        yield* delivery.settle(orgId);
        const notice = Option.getOrThrow(
          yield* (yield* Repository.KinChatRepository).getMessage({
            orgId,
            messageId: KinMessageId.make("notice-card"),
          }),
        );
        yield* hub.publish({ type: "message.posted", orgId, message: notice });
        const observed = yield* events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "message.posted" && event.message.messageId === notice.messageId,
          ),
          Stream.runCollect,
        );
        assert.deepStrictEqual(
          observed
            .flatMap((event) => (event.type === "message.changed" ? [event.message.messageId] : []))
            .sort(),
          failIds.map((id) => `kin-card-tap-failed:${id}`),
        );
        return;
      }
      const baseKey = kind === "reminder" ? "send:kin-send:wake" : "send:reply:answer";
      for (const [index, body] of [
        "The answer.",
        "The background.",
        "The last detail.",
      ].entries()) {
        const key = index === 0 ? baseKey : `${baseKey}~b${index + 1}`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
          author_owner_person_id, author_member_id, author_thread_id, author_role, kind, body,
          mentions_json, status, created_at, source_wakeup_id, silent, client_message_id)
          VALUES (${`bubble-${index + 1}`}, ${orgId}, ${chatId}, ${index + 1}, 'agent', ${agentId},
            'owner', 'lead-member', 'thread', 'member', 'text', ${body}, '[]', 'posted', ${at}, 'wake',
            ${index === 0 ? 0 : 1}, ${key})`;
      }
      const state =
        kind === "reminder"
          ? { itemId: "report", title: "Daily report", dueAt: at, status: "due" }
          : {
              itemId: "report",
              title: "Daily report",
              every: { at: "09:00", days: [1, 2, 3, 4, 5] },
              timeZone: "UTC",
              status: "active",
              nextRunAt: null,
              lastRun: null,
            };
      if (kind === "scheduled_task") {
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_role, kind, body, mentions_json, status, created_at)
          VALUES ('schedule-card', ${orgId}, ${chatId}, 4, 'system', 'member', 'system', '', '[]', 'posted', ${at})`;
        yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
          revision, state_json, awaiting_json, updated_at)
          VALUES (${widgetId}, ${orgId}, ${chatId}, 'schedule-card', 'native', 'scheduled_task', 1,
            ${JSON.stringify(state)}, '[]', ${at})`;
      }
      yield* delivery.track({
        orgId,
        eventId,
        kind,
        agentId,
        chatId,
        widget: { widgetId, type: kind === "reminder" ? "kin_reminder" : kind, state },
        fallbackBody: "The report is due.",
        deadlineAt: 60_000,
      });
      yield* delivery.settle(orgId);
      assert.deepStrictEqual(
        yield* sql`SELECT message_id AS id FROM kin_lead_deliveries WHERE event_id = ${eventId}`,
        [{ id: kind === "reminder" ? "bubble-3" : "bubble-1" }],
      );
      if (kind === "scheduled_task")
        assert.deepStrictEqual(
          yield* sql`SELECT json_extract(state_json, '$.lastRun.note') AS note FROM kin_widgets
            WHERE org_id = ${orgId} AND widget_id = ${widgetId}`,
          [{ note: "The answer." }],
        );
    }).pipe(Effect.provide(layer)),
);
