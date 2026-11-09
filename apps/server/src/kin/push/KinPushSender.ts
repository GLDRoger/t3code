import type {
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

type Push = {
  readonly category: KinPushCategory;
  readonly title: string;
  readonly body: string;
  readonly chatId: KinChatId | undefined;
  /** Message pushes collapse per chat, so a busy chat shows one banner. */
  readonly collapseId?: string;
  readonly data: KinPushData;
  readonly recipients: ReadonlyArray<KinPersonId>;
};

// APNs docs, "Handling notification responses". A 410 is handled by its timestamp instead.
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken"]);
// The token is fine; our `KIN_APNS_TOPIC` doesn't match the app that registered it.
const CONFIG_REASONS = new Set(["DeviceTokenNotForTopic", "TopicDisallowed"]);
const SEND_CONCURRENCY = 4;

const segment = encodeURIComponent;
/** Fits `apns-collapse-id`'s 64 bytes whatever the ids' length. */
const kinPushCollapseId = (orgId: KinOrgId, chatId: KinChatId) =>
  `kin:${kinPushDeviceId(`${orgId}\u0000${chatId}`)}`;
const decodeAwaiting = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

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
      return "A level change is waiting on you";
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
  const actions = yield* KinPendingActions;
  // Every Kin host shares org id `kin-default`, so links name the host too (mobile spec, routes).
  const host = segment(yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId);
  const chatLink = (orgId: KinOrgId, chatId: KinChatId) =>
    `/kin/${host}/${segment(orgId)}/chats/${segment(chatId)}`;

  /** People in the chat now. Muting silences messages, not things waiting on you. */
  const chatPeople = Effect.fn("KinPushSender.chatPeople")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    options: { readonly respectMute: boolean },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{ person_id: KinPersonId; muted_until: string | null }>`
      SELECT person_id, muted_until FROM kin_chat_members
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND principal_kind = 'person'
        AND left_at IS NULL
      ORDER BY person_id`;
    return rows
      .filter(
        (row) =>
          !options.respectMute || row.muted_until === null || !(Date.parse(row.muted_until) > now),
      )
      .map((row) => row.person_id);
  });

  const approvalPush = Effect.fn("KinPushSender.approvalPush")(function* (
    orgId: KinOrgId,
    actionId: KinActionId,
  ) {
    const action = yield* actions.get({ orgId, actionId });
    if (Option.isNone(action) || action.value.state !== "awaiting_approval") return undefined;
    const deepLink = `/kin/${host}/${segment(orgId)}/actions/${segment(actionId)}`;
    return {
      category: "kin.approval",
      title: "Approval needed",
      body: approvalPushText(action.value),
      chatId: undefined,
      data: { kin: 1, orgId, pendingActionId: actionId, deepLink },
      // DESIGN 9.3: approvers only, read from their keys, never from the request.
      recipients: yield* keys.activeApprovers(orgId),
    } satisfies Push;
  });

  const messagePush = Effect.fn("KinPushSender.messagePush")(function* (
    orgId: KinOrgId,
    messageId: KinMessageId,
  ) {
    const [row] = yield* sql<{ chat_id: KinChatId; author_person_id: KinPersonId | null }>`
      SELECT chat_id, author_person_id FROM kin_messages
      WHERE org_id = ${orgId} AND message_id = ${messageId} AND status = 'posted'`;
    if (row === undefined) return undefined;
    const people = yield* chatPeople(orgId, row.chat_id, { respectMute: true });
    return {
      category: "kin.message",
      title: "Kin",
      body: "New message",
      chatId: row.chat_id,
      collapseId: kinPushCollapseId(orgId, row.chat_id),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients: people.filter((person) => person !== row.author_person_id),
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
        ? ({ category: "kin.message", title: "Waiting on you", body: "A card needs you" } as const)
        : row.phase === "confirmed" || row.phase === null
          ? ({
              category: "kin.deferral.confirmed",
              title: "Deferred",
              body: "A deferral needs a look",
            } as const)
          : row.phase === "heads_up"
            ? ({
                category: "kin.deferral.heads_up",
                title: "Starting soon",
                body: "A deferred task starts soon",
              } as const)
            : undefined;
    if (kind === undefined) return undefined;
    const awaiting = new Set<string>(yield* decodeAwaiting(row.awaiting_json));
    const people = yield* chatPeople(orgId, row.chat_id, { respectMute: false });
    return {
      ...kind,
      chatId: row.chat_id,
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        widgetId,
        revision: row.revision,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients: people.filter((person) => awaiting.has(person)),
    } satisfies Push;
  });

  const sendTo = Effect.fn("KinPushSender.sendTo")(function* (
    orgId: KinOrgId,
    push: Push,
    device: KinPushDevice,
  ) {
    if (push.chatId !== undefined && (yield* presence.isWatching(device.sessionId, push.chatId)))
      return "suppressed" as const;
    const result = yield* apns.send({
      token: device.token,
      environment: device.apsEnvironment,
      ...(push.collapseId === undefined ? {} : { collapseId: push.collapseId }),
      payload: {
        aps: {
          alert: { title: push.title, body: push.body },
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
    const targets = yield* devices.forPeople(orgId, push.recipients);
    // Bounded, so one slow device doesn't hold up the rest and a big org doesn't flood APNs.
    const results = yield* Effect.forEach(targets, (device) => sendTo(orgId, push, device), {
      concurrency: SEND_CONCURRENCY,
    });
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
