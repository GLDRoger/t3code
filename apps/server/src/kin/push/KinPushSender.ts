import type {
  EnvironmentId,
  KinActionId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPendingAction,
  KinPersonId,
  KinPushCategory,
  KinPushData,
  KinPushSendingStatus,
  KinWidgetId,
} from "@t3tools/contracts";
import { KinTriggerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ApproverKeys } from "../approvals/ApproverKeys.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { MemoryCache } from "../memory/MemoryCache.ts";
import { isQuiet, KIN_DEFAULT_QUIET_HOURS } from "../triggers/quietHours.ts";
import { KinApnsTransport } from "./Apns.ts";
import { KinPushDevices, kinPushDeviceId, type KinPushDevice } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";

/**
 * What server code asks to announce. Only ids: the sender reads everything else, including
 * who receives it, from the database, so nothing an agent wrote picks recipients or text.
 */
export type KinPushNotification =
  | { readonly _tag: "approval"; readonly orgId: KinOrgId; readonly actionId: KinActionId }
  | { readonly _tag: "message"; readonly orgId: KinOrgId; readonly messageId: KinMessageId }
  | { readonly _tag: "widget"; readonly orgId: KinOrgId; readonly widgetId: KinWidgetId };

export type KinPushOutcome = {
  readonly status: KinPushSendingStatus;
  readonly sent: number;
  /** Devices showing that chat right now. */
  readonly suppressed: number;
  readonly failed: number;
};

/** Silent recipients get the badge only: no banner, no sound. */
type Recipient = { readonly personId: KinPersonId; readonly silent: boolean };

type Push = {
  readonly category: KinPushCategory;
  readonly title: string;
  readonly body: string;
  readonly chatId: KinChatId | undefined;
  /** Message pushes collapse per chat, so a busy chat shows one banner. */
  readonly collapseId?: string;
  readonly data: KinPushData;
  readonly recipients: ReadonlyArray<Recipient>;
};

/** The longest body a banner shows before iOS cuts it; we cut at a word first. */
const KIN_PUSH_BODY_MAX = 160;

/** A message's start as one plain line for a banner. */
const kinPushBody = (text: string) => {
  const plain = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/```[^\s`]*/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  if (chars.length <= KIN_PUSH_BODY_MAX) return plain;
  const cut = chars.slice(0, KIN_PUSH_BODY_MAX - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > KIN_PUSH_BODY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

// APNs docs, "Handling notification responses". A 410 is handled by its timestamp instead.
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken"]);
// The token is fine; our `KIN_APNS_TOPIC` doesn't match the app that registered it.
const CONFIG_REASONS = new Set(["DeviceTokenNotForTopic", "TopicDisallowed"]);
const SEND_CONCURRENCY = 4;

const segment = encodeURIComponent;
/** Every Kin host shares org id `kin-default`, so links name the host too (mobile spec, routes). */
export const kinPushChatLink = (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId) =>
  `/kin/${segment(environmentId)}/${segment(orgId)}/chats/${segment(chatId)}`;
/** Fits `apns-collapse-id`'s 64 bytes whatever the ids' length. */
const kinPushCollapseId = (orgId: KinOrgId, chatId: KinChatId) =>
  `kin:${kinPushDeviceId(`${orgId}\u0000${chatId}`)}`;
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeQuietHours = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);

/**
 * Whether a message concerns someone enough to ring their phone. A direct chat is theirs; in a
 * group only a mention of them, a reply to their message, or a lead's answer to what they asked
 * does (cards push on their own).
 */
const kinPushConcerns = (input: {
  readonly direct: boolean;
  readonly mentioned: boolean;
  readonly repliesToThem: boolean;
}) => input.direct || input.mentioned || input.repliesToThem;

/** Fixed text per kind: ids and numbers from the action, never the agent's reason. */
const approvalPushText = (action: KinPendingAction) => {
  switch (action.target._tag) {
    case "pull_request":
      return action.kind === "merge_pull_request"
        ? `Merge #${action.target.number} is waiting on you`
        : `A pull request action is waiting on you`;
    case "branch":
      return "Deleting a branch is waiting on you";
    case "device_key":
      return "Adding an approver key is waiting on you";
    case "level":
      return "A permission change for a lead is waiting on you";
    case "content":
      return action.kind === "memory_purge"
        ? "A memory purge is waiting on you"
        : "A rules change is waiting on you";
  }
};

export class KinPushSender extends Context.Service<
  KinPushSender,
  {
    readonly status: KinPushSendingStatus;
    /** Call after the commit; it sends in the background, outliving the request, and never fails. */
    readonly notify: (
      notification: KinPushNotification,
    ) => Effect.Effect<Fiber.Fiber<KinPushOutcome>>;
  }
>()("t3/kin/push/KinPushSender") {}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const sql = yield* SqlClient.SqlClient;
  const apns = yield* KinApnsTransport;
  const devices = yield* KinPushDevices;
  const presence = yield* KinPushPresence;
  const keys = yield* ApproverKeys;
  const cache = yield* MemoryCache;
  const actions = yield* KinPendingActions;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const host = segment(environmentId);
  const chatLink = (orgId: KinOrgId, chatId: KinChatId) =>
    kinPushChatLink(environmentId, orgId, chatId);

  /** People in the chat now, each with whether they muted it. */
  const chatPeople = Effect.fn("KinPushSender.chatPeople")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      person_id: KinPersonId;
      member_id: string;
      muted_until: string | null;
    }>`
      SELECT person_id, member_id, muted_until FROM kin_chat_members
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND principal_kind = 'person'
        AND left_at IS NULL
      ORDER BY person_id`;
    return rows.map((row) => ({
      personId: row.person_id,
      memberId: row.member_id,
      muted: row.muted_until !== null && Date.parse(row.muted_until) > now,
    }));
  });

  /** What a chat is called on a banner: its title, or the lead a direct chat is with. */
  const chatName = Effect.fn("KinPushSender.chatName")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
  ) {
    const [row] = yield* sql<{ kind: string; title: string | null; agent: string | null }>`
      SELECT c.kind, c.title, (
          SELECT a.display_name FROM kin_chat_members m
          JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'agent'
            AND m.left_at IS NULL
          ORDER BY m.joined_at, m.member_id LIMIT 1
        ) AS agent
      FROM kin_chats c WHERE c.org_id = ${orgId} AND c.chat_id = ${chatId}`;
    const direct = row?.kind === "direct";
    return { direct, name: row?.title ?? (direct ? (row?.agent ?? "Kin") : "Group") };
  });

  /** Quiet hours as pings keep them: the org's hours on the owner's clock. */
  const quietNow = Effect.fn("KinPushSender.quietNow")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{ quiet_hours_json: string }>`
      SELECT quiet_hours_json FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
    const hours = Option.getOrElse(
      decodeQuietHours(row?.quiet_hours_json),
      () => KIN_DEFAULT_QUIET_HOURS,
    );
    return isQuiet(yield* Clock.currentTimeMillis, yield* cache.ownerTimeZone(orgId), hours);
  });

  /** Unread messages plus open waiting items, across every chat the person is still in. */
  const badgeFor = Effect.fn("KinPushSender.badgeFor")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const [row] = yield* sql<{ unread: number; waiting: number }>`
      SELECT (
          SELECT COUNT(*) FROM kin_chat_members cm
          JOIN kin_messages m ON m.org_id = cm.org_id AND m.chat_id = cm.chat_id
          WHERE cm.org_id = ${orgId} AND cm.person_id = ${personId}
            AND cm.principal_kind = 'person' AND cm.left_at IS NULL
            AND m.status = 'posted'
            AND (m.author_member_id IS NULL OR m.author_member_id != cm.member_id)
            AND m.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r
              WHERE r.chat_id = cm.chat_id AND r.member_id = cm.member_id), 0)
        ) AS unread, (
          SELECT COUNT(*) FROM kin_waiting w
          WHERE w.org_id = ${orgId} AND w.person_id = ${personId} AND w.resolved_at IS NULL
            AND EXISTS (SELECT 1 FROM kin_chat_members cm WHERE cm.org_id = w.org_id
              AND cm.chat_id = w.chat_id AND cm.person_id = w.person_id AND cm.left_at IS NULL)
        ) AS waiting`;
    return (row?.unread ?? 0) + (row?.waiting ?? 0);
  });

  const approvalPush = Effect.fn("KinPushSender.approvalPush")(function* (
    orgId: KinOrgId,
    actionId: KinActionId,
  ) {
    const action = yield* actions.get({ orgId, actionId });
    if (Option.isNone(action) || action.value.state !== "awaiting_approval") return undefined;
    const [lead] = yield* sql<{ display_name: string }>`
      SELECT display_name FROM kin_agents
      WHERE org_id = ${orgId} AND agent_id = ${action.value.requestedBy.agentId}`;
    const deepLink = `/kin/${host}/${segment(orgId)}/actions/${segment(actionId)}`;
    const quiet = yield* quietNow(orgId);
    // DESIGN 9.3: approvers only, read from their keys, never from the request.
    const approvers = yield* keys.activeApprovers(orgId);
    return {
      category: "kin.approval",
      title: lead?.display_name ?? "Approval needed",
      body: approvalPushText(action.value),
      chatId: undefined,
      data: { kin: 1, orgId, pendingActionId: actionId, deepLink },
      recipients: approvers.map((personId) => ({ personId, silent: quiet })),
    } satisfies Push;
  });

  const messagePush = Effect.fn("KinPushSender.messagePush")(function* (
    orgId: KinOrgId,
    messageId: KinMessageId,
  ) {
    const [row] = yield* sql<{
      chat_id: KinChatId;
      author_kind: string;
      author_person_id: KinPersonId | null;
      author_member_id: string | null;
      author_name: string | null;
      body: string;
      mentions_json: string;
      reply_author: KinPersonId | null;
      asked_json: string;
      awaits_card: number;
      owner_timed: number;
    }>`
      SELECT m.chat_id, m.author_kind, m.author_person_id, m.author_member_id, m.body,
        m.mentions_json,
        COALESCE(
          (SELECT display_name FROM kin_agents a
            WHERE a.org_id = m.org_id AND a.agent_id = m.author_agent_id),
          (SELECT display_name FROM kin_people p
            WHERE p.org_id = m.org_id AND p.person_id = m.author_person_id)
        ) AS author_name,
        (SELECT r.author_person_id FROM kin_messages r
          WHERE r.org_id = m.org_id AND r.message_id = m.reply_to) AS reply_author,
        -- Whose messages in this chat the lead's running wake-up answers.
        (SELECT COALESCE(json_group_array(DISTINCT q.author_person_id), '[]') FROM kin_wakeups k
          JOIN kin_events e ON e.org_id = k.org_id AND e.wakeup_id = k.wakeup_id
            AND e.tag IN ('chat.message', 'widget.action')
          JOIN kin_messages q ON q.org_id = e.org_id AND q.chat_id = m.chat_id
            AND q.message_id = json_extract(e.json, '$.messageId') AND q.author_kind = 'human'
          WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id
            AND k.status = 'running') AS asked_json,
        EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id AND w.closed_at IS NULL
          AND w.awaiting_json != '[]') AS awaits_card,
        (EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
            AND w.message_id = m.message_id AND w.type IN ('reminder', 'scheduled_task'))
          OR EXISTS (SELECT 1 FROM kin_lead_deliveries d
            JOIN kin_events e ON e.org_id = d.org_id AND e.event_id = d.event_id
            JOIN kin_wakeups k ON k.org_id = e.org_id AND k.wakeup_id = e.wakeup_id
            WHERE d.org_id = m.org_id AND d.chat_id = m.chat_id
              AND d.agent_id = m.author_agent_id AND d.kind IN ('reminder', 'scheduled_task')
              AND k.status = 'running')) AS owner_timed
      FROM kin_messages m
      WHERE m.org_id = ${orgId} AND m.message_id = ${messageId} AND m.status = 'posted'
        AND m.kind != 'widget_action'`;
    // A card that waits on someone announces itself through its widget push.
    if (row === undefined || row.awaits_card === 1) return undefined;
    const chat = yield* chatName(orgId, row.chat_id);
    const mentions = new Set<string>(yield* decodeIds(row.mentions_json));
    const asked = new Set<string>(yield* decodeIds(row.asked_json));
    // Reminders and scheduled runs come at the time the owner chose, so quiet hours let them ring.
    const quiet = row.owner_timed === 1 ? false : yield* quietNow(orgId);
    const people = yield* chatPeople(orgId, row.chat_id);
    const author = row.author_name;
    return {
      category: "kin.message",
      title: chat.direct
        ? (author ?? chat.name)
        : author === null
          ? chat.name
          : `${chat.name} · ${author}`,
      body: kinPushBody(row.body) || "New message",
      chatId: row.chat_id,
      collapseId: kinPushCollapseId(orgId, row.chat_id),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients: people
        .filter(
          (person) =>
            person.personId !== row.author_person_id &&
            person.memberId !== row.author_member_id &&
            kinPushConcerns({
              direct: chat.direct,
              mentioned: mentions.has(person.memberId),
              repliesToThem: row.reply_author === person.personId || asked.has(person.personId),
            }),
        )
        .map((person) => ({ personId: person.personId, silent: person.muted || quiet })),
    } satisfies Push;
  });

  const widgetPush = Effect.fn("KinPushSender.widgetPush")(function* (
    orgId: KinOrgId,
    widgetId: KinWidgetId,
  ) {
    const [row] = yield* sql<{
      chat_id: KinChatId;
      type: string;
      revision: number;
      phase: unknown;
      awaiting_json: string;
    }>`SELECT w.chat_id, w.type, w.revision, json_extract(w.state_json, '$.phase') AS phase,
        w.awaiting_json
      FROM kin_widgets w JOIN kin_messages m ON m.message_id = w.message_id
      WHERE w.org_id = ${orgId} AND w.widget_id = ${widgetId} AND w.closed_at IS NULL
        AND m.status = 'posted'`;
    if (row === undefined) return undefined;
    // An approval card can be posted by an agent and await anyone; its push comes from the
    // pending action and goes to approvers.
    if (row.type === "approval") return undefined;
    const kind =
      row.type !== "deferral"
        ? ({ category: "kin.message", body: "A card is waiting on you" } as const)
        : row.phase === "confirmed" || row.phase === null
          ? ({ category: "kin.deferral.confirmed", body: "A deferral needs a look" } as const)
          : row.phase === "heads_up"
            ? ({ category: "kin.deferral.heads_up", body: "A deferred task starts soon" } as const)
            : undefined;
    if (kind === undefined) return undefined;
    const awaiting = new Set<string>(yield* decodeIds(row.awaiting_json));
    const chat = yield* chatName(orgId, row.chat_id);
    // A heads-up comes at the time the owner deferred the task to.
    const quiet = row.phase === "heads_up" ? false : yield* quietNow(orgId);
    const people = yield* chatPeople(orgId, row.chat_id);
    return {
      ...kind,
      title: chat.name,
      chatId: row.chat_id,
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        widgetId,
        revision: row.revision,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients: people
        .filter((person) => awaiting.has(person.personId))
        .map((person) => ({ personId: person.personId, silent: person.muted || quiet })),
    } satisfies Push;
  });

  const sendTo = Effect.fn("KinPushSender.sendTo")(function* (
    orgId: KinOrgId,
    push: Push,
    device: KinPushDevice,
    recipient: { readonly silent: boolean; readonly badge: number },
  ) {
    if (push.chatId !== undefined && (yield* presence.isWatching(device.sessionId, push.chatId)))
      return "suppressed" as const;
    const result = yield* apns.send({
      token: device.token,
      environment: device.apsEnvironment,
      // A badge-only push must not replace the banner a loud one left under the same id.
      ...(push.collapseId === undefined || recipient.silent ? {} : { collapseId: push.collapseId }),
      payload: {
        aps: recipient.silent
          ? { badge: recipient.badge }
          : {
              alert: { title: push.title, body: push.body },
              badge: recipient.badge,
              category: push.category,
              sound: "default",
              ...(push.chatId === undefined ? {} : { "thread-id": `kin:${orgId}:${push.chatId}` }),
            },
        // expo-notifications reads a remote push's `content.data` from `body`.
        body: push.data,
      },
    });
    if (result.status === 200) return "sent" as const;
    const deviceId = kinPushDeviceId(device.token);
    if (result.status === 410) {
      yield* devices.forget(orgId, device.token, result.timestamp);
      yield* Effect.logInfo("Kin push device token is gone.", { deviceId, reason: result.reason });
    } else if (DEAD_TOKEN_REASONS.has(result.reason ?? "")) {
      yield* devices.forget(orgId, device.token);
      // Often a token sent to the wrong APNs environment, so say which one it went to.
      yield* Effect.logWarning("APNs called a Kin push device token bad; it was removed.", {
        deviceId,
        reason: result.reason,
        environment: device.apsEnvironment,
      });
    } else if (result.status === 429) {
      yield* Effect.logWarning("APNs is throttling Kin pushes; this one was dropped.", {
        deviceId,
        reason: result.reason,
      });
    } else if (CONFIG_REASONS.has(result.reason ?? "")) {
      yield* Effect.logError("APNs refused a Kin push: check KIN_APNS_TOPIC.", {
        deviceId,
        reason: result.reason,
      });
    } else {
      yield* Effect.logWarning("APNs refused a Kin push.", {
        deviceId,
        status: result.status,
        reason: result.reason,
      });
    }
    return "failed" as const;
  });

  const deliver = Effect.fn("KinPushSender.deliver")(function* (orgId: KinOrgId, push: Push) {
    const recipients = new Map<KinPersonId, { silent: boolean; badge: number }>();
    for (const recipient of push.recipients)
      recipients.set(recipient.personId, {
        silent: recipient.silent,
        badge: yield* badgeFor(orgId, recipient.personId),
      });
    const targets = yield* devices.forPeople(orgId, [...recipients.keys()]);
    // Bounded, so one slow device doesn't hold up the rest and a big org doesn't flood APNs.
    const results = yield* Effect.forEach(
      targets,
      (device) => {
        const recipient = recipients.get(device.personId);
        return recipient === undefined
          ? Effect.succeed("failed" as const)
          : sendTo(orgId, push, device, recipient);
      },
      { concurrency: SEND_CONCURRENCY },
    );
    const count = (outcome: (typeof results)[number]) =>
      results.filter((result) => result === outcome).length;
    return { sent: count("sent"), suppressed: count("suppressed"), failed: count("failed") };
  });

  const nothing: KinPushOutcome = { status: apns.status, sent: 0, suppressed: 0, failed: 0 };

  const run = Effect.fn("KinPushSender.run")(
    function* (notification: KinPushNotification) {
      if (apns.status === "unconfigured") return nothing;
      const push =
        notification._tag === "approval"
          ? yield* approvalPush(notification.orgId, notification.actionId)
          : notification._tag === "message"
            ? yield* messagePush(notification.orgId, notification.messageId)
            : yield* widgetPush(notification.orgId, notification.widgetId);
      if (push === undefined || push.recipients.length === 0) return nothing;
      const outcome: KinPushOutcome = {
        status: apns.status,
        ...(yield* deliver(notification.orgId, push)),
      };
      return outcome;
    },
    Effect.catch((error) =>
      Effect.logWarning("Kin push failed.", { error: error._tag }).pipe(
        Effect.as({ ...nothing, failed: 1 }),
      ),
    ),
  );

  const notify = Effect.fn("KinPushSender.notify")(function* (notification: KinPushNotification) {
    return yield* Effect.forkIn(run(notification), scope);
  });

  return KinPushSender.of({ status: apns.status, notify });
});

export const layer = Layer.effect(KinPushSender, make);
