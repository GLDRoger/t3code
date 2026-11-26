import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinEventId, KinOrgId, KinWidgetId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { Scheduler } from "../../scheduling/Scheduler.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import * as Delivery from "./LeadDelivery.ts";

const layer = Delivery.layer.pipe(
  Layer.provide(Repository.layer),
  Layer.provide(Layer.mock(KinEventQueue)({})),
  Layer.provide(Layer.mock(Scheduler)({ register: () => Effect.void })),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect.each(["reminder", "scheduled_task"] as const)(
  "picks the right reply bubble for a %s delivery",
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
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Kin', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at})`;
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
