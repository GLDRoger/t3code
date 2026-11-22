import { KinChatId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";

export const measureLayer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
export const orgId = KinOrgId.make("ambermill");
export const ownerChat = KinChatId.make("owner-chat");
export const coOwnerChat = KinChatId.make("co-owner-chat");
export const memberChat = KinChatId.make("member-chat");
export const zone = "America/New_York";
export const from = Date.parse("2026-10-26T04:00:00Z");
export const until = Date.parse("2026-11-02T05:00:00Z");
export const mondayMorning = Date.parse("2026-11-02T13:00:00Z");
const hour = 3_600_000;
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const seedAt = iso(from - 8 * 24 * hour);

export const seedCompany = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Ambermill', ${seedAt})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, ${zone}, '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', ${seedAt}, 'owner'),
      ('meera', ${orgId}, 'meera', 'Meera', ${seedAt}, 'co_owner'),
      ('dev', ${orgId}, 'dev', 'Dev', ${seedAt}, 'member')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('chief', ${orgId}, 'Chief of staff', 'lead', 'rhea', ${seedAt})`;
  for (const [chatId, person] of [
    [ownerChat, "rhea"],
    [coOwnerChat, "meera"],
    [memberChat, "dev"],
  ] as const) {
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${chatId}, ${orgId}, 'team_group', 0, ${seedAt})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${person}, ${orgId}, ${chatId}, 'person', ${person}, 'owner', ${seedAt})`;
  }
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('chief-member', ${orgId}, ${ownerChat}, 'agent', 'chief', 'member', ${seedAt})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('chief', ${orgId}, 'Chief of staff', 0, '{}', '[]', ${ownerChat})`;
});

export const seedMeasuredWeek = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
      auth, reach, state, created_at, updated_at)
    VALUES (${orgId}, 'mail', 'google', 'Mail', 'builtin', '', 'oauth', 'closed', 'active', ${from}, ${from})`;
  const rows = [
    { id: "approval", at: from, card: "approval" },
    { id: "edited", at: from + hour, card: "edited" },
    { id: "dismissed", at: from + 2 * hour, card: "dismissed" },
    { id: "open", at: from + 3 * hour, card: "open" },
    { id: "notice", at: from + 4 * hour, card: "notice" },
    { id: "asked", at: from + 5 * hour, card: "dismissed", asked: true },
    { id: "earlier", at: from - hour },
    { id: "at-end", at: until },
  ];
  let seq = 0;
  for (const { id, at, card, asked } of rows) {
    const messageId = `post-${id}`;
    const widgetId = `widget-${id}`;
    const eventId = `event-${id}`;
    const tag = asked === true ? "chat.message" : "pulse";
    const postedAt = card === "edited" ? at + hour / 2 : at + 1;
    const settledAt = postedAt + 1;
    const humanPost = (mid: string, at: number) =>
      sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES (${mid}, ${orgId}, ${ownerChat}, ${++seq}, 'human', 'rhea', 'rhea', 'owner',
          'text', 'Check the draft.', '[]', 'posted', ${iso(at)})`;
    if (asked === true) yield* humanPost(`ask-${id}`, at - 1);
    yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, thread_id, model,
        started_at, ended_at, status, event_ids)
      VALUES (${orgId}, ${id}, 'chief', 'chief-thread', 'replay', ${at}, ${at + 100}, 'completed',
        ${yield* encodeFixture([eventId])})`;
    yield* sql`INSERT INTO kin_events (org_id, event_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${orgId}, ${eventId}, 'chief', ${tag}, 'P1',
        ${yield* encodeFixture({ _tag: tag, chatId: ownerChat, messageId: `ask-${id}` })},
        ${at}, ${at}, 'done', ${id})`;

    if (card === "approval") {
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role,
          kind, body, mentions_json, status, created_at)
        VALUES (${messageId}, ${orgId}, ${ownerChat}, ${++seq}, 'system', 'member', 'system',
          'Review the action.', '[]', 'posted', ${iso(at + 1)})`;
      yield* sql`INSERT INTO kin_pending_actions (action_id, org_id, idempotency_key, kind, target_json,
          resolved_json, target_digest, nonce, revision, reason, requested_by_agent_id,
          requested_by_thread_id, provenance_json, required_approvers_json, state, created_at,
          updated_at, expires_at)
        VALUES ('action', ${orgId}, 'action', 'test', '{}', '{}', 'digest', 'nonce', 0, 'Review it',
          'chief', 'chief-thread', '{}', '[]', 'approved', ${at}, ${at + 2}, ${until})`;
      yield* sql`INSERT INTO kin_grants (grant_id, org_id, action_id, revision, jti, approver_human_id,
          key_thumbprint, compact, iat_s, exp_s, accepted_at)
        VALUES ('grant', ${orgId}, 'action', 0, 'jti', 'rhea', 'key', 'fixture', 0, 1, ${at + 2})`;
    } else {
      // An ordinary tool post has no stored source wake-up; legacy attribution uses its thread.
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
          author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
          mentions_json, status, created_at, source_wakeup_id)
        VALUES (${messageId}, ${orgId}, ${ownerChat}, ${++seq}, 'agent', 'chief', 'rhea', 'chief-thread',
          'chief-member', 'member', 'text', ${card === undefined ? "A new update." : ""}, '[]', 'posted', ${iso(postedAt)}, ${card === undefined || card === "edited" ? null : id})`;
    }
    if (card === undefined) continue;
    if (card === "edited")
      yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name,
          pin_digest, payload_json, agent_id, wakeup_id, chat_id, widget_id, proposed_at, state,
          decided_at)
        VALUES (${orgId}, 'edited-copy', 'mail', 'mail_send', 'pin', '{}', 'chief', ${id},
          ${ownerChat}, ${widgetId}, ${postedAt}, 'sent', ${settledAt})`;
    const settled = card === "approval" || card === "edited" || card === "dismissed";
    const state =
      card === "approval"
        ? { actionId: "action", state: "approved" }
        : {
            options:
              card === "notice"
                ? [{ optionId: "open" }]
                : [
                    { optionId: "yes", kind: "yes" },
                    { optionId: "no", kind: "no" },
                  ],
            answer:
              card === "edited"
                ? { optionId: "yes", personId: "rhea", answeredAt: iso(settledAt) }
                : null,
            ...(card === "edited" ? { send: { edited: { personId: "rhea" } } } : {}),
            ...(card === "dismissed"
              ? { dismissed: { personId: "rhea", at: iso(settledAt) } }
              : {}),
          };
    yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
        revision, state_json, awaiting_json, closed_at, updated_at)
      VALUES (${widgetId}, ${orgId}, ${ownerChat}, ${messageId}, 'native',
        ${card === "approval" ? "approval" : "choice"}, ${settled ? 2 : 1}, ${yield* encodeFixture(state)},
        ${settled || card === "notice" ? "[]" : '["rhea"]'}, ${settled ? iso(settledAt) : null},
        ${iso(settled ? settledAt : postedAt)})`;
    if (card !== "notice") {
      yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, widget_id,
          reason, created_at, resolved_at, resolution)
        VALUES (${widgetId}, ${orgId}, 'rhea', ${ownerChat}, ${messageId}, ${widgetId},
          ${card === "approval" ? "approval" : "question"}, ${iso(postedAt)},
          ${settled ? iso(settledAt) : null}, ${card === "dismissed" ? "dismissed" : settled ? "acted" : null})`;
    }
    if (asked === true) yield* humanPost("follow-up", at + 3);
  }
  const dueAt = from + 8 * hour;
  yield* sql`INSERT INTO kin_watches (org_id, watch_id, kind, source, source_key, about, closes_when,
      audience, why, set_by_kind, latest_by, next_look_at, interval_ms, state, closed_at, created_at, updated_at)
    VALUES (${orgId}, 'watch', 'work', 'promise', 'watch', 'Check draft', 'When finished',
      'owner', 'Due today', 'agent', ${dueAt}, ${dueAt}, ${hour}, 'closed', ${dueAt}, ${from}, ${dueAt})`;
  yield* sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
    VALUES (${orgId}, 'late', 'started', ${dueAt}, 'start', '{}', ${dueAt + hour}),
      (${orgId}, 'missed', 'armed', ${dueAt}, 'start', '{}', ${from})`;
});
