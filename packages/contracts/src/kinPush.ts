import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinActionId } from "./kinApprovals.ts";
import {
  KinChatId,
  KinChoiceOption,
  KinMessageId,
  KinOrgId,
  KinTrimmedText,
  KinWidgetId,
  type KinMessageLink,
} from "./kinChat.ts";
import { KinRecordKey } from "./kinWork.ts";

/**
 * A native APNs device token in lowercase hex (Apple says not to fix the length; today it is 32
 * bytes), or an FCM registration token, which is case-sensitive and unspecified in length.
 */
export const KinPushToken = Schema.String.check(
  Schema.makeFilter(
    (value: string) => /^[0-9a-f]{64,400}$/.test(value) || /^[A-Za-z0-9_:-]{32,4096}$/.test(value),
    { expected: "a lowercase hex APNs device token or an FCM registration token" },
  ),
);
export type KinPushToken = typeof KinPushToken.Type;

/** `ios` goes through APNs, `android` through FCM. */
export const KinPushPlatform = Schema.Literals(["ios", "android"]);
export type KinPushPlatform = typeof KinPushPlatform.Type;
/** APNs' environment; an Android phone sends `production`, since FCM has only the one. */
export const KinApsEnvironment = Schema.Literals(["development", "production"]);
export type KinApsEnvironment = typeof KinApsEnvironment.Type;

/**
 * The Android notification channel a push shows in, so a person can silence one kind in the
 * phone's settings. The phone creates each with its name; the server picks one per push.
 */
export const KinPushChannel = Schema.Literals([
  "kin.messages",
  "kin.questions",
  "kin.briefs",
  "kin.account",
  // Low importance: what arrives in quiet hours waits in the list, with no sound or banner.
  "kin.quiet",
]);
export type KinPushChannel = typeof KinPushChannel.Type;

/**
 * `aps.category`; the phone registers the matching buttons (mobile spec, notifications). A build
 * that doesn't know one shows a plain banner whose tap opens it.
 */
export const KinPushCategory = Schema.Literals([
  "kin.approval",
  // An open question with two plain answers: "answer_1" and "answer_2" pick `choices`' options.
  "kin.choice",
  "kin.deferral.confirmed",
  "kin.deferral.heads_up",
  "kin.message",
]);
export type KinPushCategory = typeof KinPushCategory.Type;

/**
 * The one thing a push is about, when it is about one: a card's message in the push's chat, an
 * entry by its key, or the reader's own Tasks when it names several of theirs. A tap opens it; a
 * build that doesn't know it opens `deepLink`.
 */
export const KinPushSubject = Schema.Union([
  Schema.TaggedStruct("message", { messageId: KinMessageId }),
  Schema.TaggedStruct("record", {
    key: KinRecordKey,
    kind: Schema.Literals(["task", "client", "project", "doc", "entry"]),
  }),
  Schema.TaggedStruct("tasks", {}),
]);
export type KinPushSubject = typeof KinPushSubject.Type;

/**
 * What a message is about for the reader its `links` were worked out for: its card, else the one
 * entry it names. Null when it names none or several. The push and the web's notice both use it.
 */
export function kinMessageSubject(message: {
  readonly messageId: KinMessageId;
  readonly widgetId: KinWidgetId | null;
  readonly links?: ReadonlyArray<KinMessageLink> | undefined;
}): KinPushSubject | null {
  if (message.widgetId !== null) return { _tag: "message", messageId: message.messageId };
  const records = new Map<string, KinPushSubject>();
  for (const { to } of message.links ?? [])
    if (to._tag === "record") records.set(to.key, { _tag: "record", key: to.key, kind: to.kind });
  const [only, ...more] = records.values();
  return only !== undefined && more.length === 0 ? only : null;
}

/**
 * The one stable thing a push is about, which a newer push about it replaces and which is
 * withdrawn once it no longer needs the person: `c:` a chat's messages, `w:` a card, `q:` an open
 * question, `a:` an approval, `r:` a task, `f:` Kin's notice of several, `b:` task news held
 * through quiet hours, `t:` a trouble on Kin's computer, `u:` nothing else (never replaced). Ids only.
 */
export const KinPushTopic = Schema.String.check(
  Schema.makeFilter((value: string) => /^[a-z]:\S{1,200}$/.test(value), {
    expected: "a Kin push topic",
  }),
);
export type KinPushTopic = typeof KinPushTopic.Type;

/** At most this many topics in one withdrawal or one reconcile. */
export const KIN_PUSH_TOPICS_MAX = 200;

/**
 * A topic as far as `version`: each push about a topic is its person's next version of it, so a
 * withdrawal or a reconcile answer removes what shows that version or older, never a newer push
 * that overtook it on the way.
 */
export const KinPushWithdrawn = Schema.Struct({ topic: KinPushTopic, version: NonNegativeInt });
export type KinPushWithdrawn = typeof KinPushWithdrawn.Type;

/**
 * What a Kin push carries besides `aps`, under the payload's `body` key, which is what
 * expo-notifications exposes as `content.data` for a remote push. Ids and a `/kin/` link only.
 */
export const KinPushData = Schema.Struct({
  kin: Schema.Literal(1),
  orgId: KinOrgId,
  // Approvals that no chat asked for, such as adding a key, have none.
  chatId: Schema.optional(KinChatId),
  widgetId: Schema.optional(KinWidgetId),
  revision: Schema.optional(NonNegativeInt),
  /** On a `kin.choice` push: the card's two option ids, in the order its buttons show them. */
  choices: Schema.optional(
    Schema.Tuple([KinChoiceOption.fields.optionId, KinChoiceOption.fields.optionId]),
  ),
  pendingActionId: Schema.optional(KinActionId),
  /** On a read's badge push: nothing in `chatId` is unread for this person any more. */
  cleared: Schema.optional(Schema.Literal(true)),
  /** Worked out for the person it is sent to, from what they may open. */
  subject: Schema.optional(KinPushSubject),
  /** What it is about, to a build that registered `withdraws`. */
  topic: Schema.optional(KinPushTopic),
  /** With `topic`: which push about it this is, for this person (`KinPushWithdrawn`). */
  version: Schema.optional(NonNegativeInt),
  /** On a silent push: these topics' notifications are settled, so the phone removes them. */
  withdraw: Schema.optional(
    Schema.Array(KinPushWithdrawn).check(Schema.isMaxLength(KIN_PUSH_TOPICS_MAX)),
  ),
  deepLink: Schema.String.check(
    Schema.makeFilter((value: string) => /^\/kin\/[A-Za-z0-9._~%/-]+$/.test(value), {
      expected: "a /kin/ app path",
    }),
  ),
});
export type KinPushData = typeof KinPushData.Type;

/** `sending` is `unconfigured` until the Kin host has an APNs key: tokens are kept, nothing is sent. */
export const KinPushSendingStatus = Schema.Literals(["ready", "unconfigured"]);
export type KinPushSendingStatus = typeof KinPushSendingStatus.Type;

export const KinPushRegisterDeviceInput = Schema.Struct({
  orgId: KinOrgId,
  token: KinPushToken,
  platform: KinPushPlatform,
  apsEnvironment: KinApsEnvironment,
  deviceLabel: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(80))),
  /** An Android build that made the `kin.quiet` channel; without it, quiet pushes set no banner. */
  quietChannel: Schema.optional(Schema.Boolean),
  /**
   * A build that matches its notifications by `topic`: its pushes replace one another by topic,
   * and it removes the topics a silent push withdraws.
   */
  withdraws: Schema.optional(Schema.Boolean),
});
export type KinPushRegisterDeviceInput = typeof KinPushRegisterDeviceInput.Type;

export const KinPushRegisterDeviceResult = Schema.Struct({
  /** A short hash of the token, safe to show and log. */
  deviceId: TrimmedNonEmptyString,
  sending: KinPushSendingStatus,
});
export type KinPushRegisterDeviceResult = typeof KinPushRegisterDeviceResult.Type;

export const KinPushUnregisterDeviceInput = Schema.Struct({
  orgId: KinOrgId,
  token: KinPushToken,
});
export type KinPushUnregisterDeviceInput = typeof KinPushUnregisterDeviceInput.Type;

export const KinPushUnregisterDeviceResult = Schema.Struct({ removed: Schema.Boolean });
export type KinPushUnregisterDeviceResult = typeof KinPushUnregisterDeviceResult.Type;

/** The topics of this host's notifications the phone still shows. */
export const KinPushReconcileInput = Schema.Struct({
  orgId: KinOrgId,
  topics: Schema.Array(KinPushTopic).check(Schema.isMaxLength(KIN_PUSH_TOPICS_MAX)),
});
export type KinPushReconcileInput = typeof KinPushReconcileInput.Type;

/** Of those, the ones sent to the caller that are settled, and the caller's badge now. */
export const KinPushReconcileResult = Schema.Struct({
  remove: Schema.Array(KinPushWithdrawn),
  badge: NonNegativeInt,
});
export type KinPushReconcileResult = typeof KinPushReconcileResult.Type;

export const KinPushWatchInput = Schema.Struct({ chatId: KinChatId });
export type KinPushWatchInput = typeof KinPushWatchInput.Type;

/** One per beat interval; the server counts a beat as presence only once the client acks it. */
export const KinPushWatchBeat = Schema.Literal("beat");
export type KinPushWatchBeat = typeof KinPushWatchBeat.Type;

export class KinPushError extends Schema.TaggedError<KinPushError>()("KinPushError", {
  reason: Schema.Literals(["not_member", "registered_to_someone_else", "unavailable", "disabled"]),
  message: Schema.String,
}) {}

export const KIN_PUSH_WS_METHODS = {
  registerDevice: "kin.push.registerDevice",
  unregisterDevice: "kin.push.unregisterDevice",
  watch: "kin.push.watch",
  reconcile: "kin.push.reconcile",
} as const;

const error = Schema.Union([KinPushError, EnvironmentAuthorizationError]);

export const KinPushRpcs = [
  Rpc.make(KIN_PUSH_WS_METHODS.registerDevice, {
    payload: KinPushRegisterDeviceInput,
    success: KinPushRegisterDeviceResult,
    error,
  }),
  Rpc.make(KIN_PUSH_WS_METHODS.unregisterDevice, {
    payload: KinPushUnregisterDeviceInput,
    success: KinPushUnregisterDeviceResult,
    error,
  }),
  // Open while a chat is on screen: that session's device gets no pushes for the chat.
  Rpc.make(KIN_PUSH_WS_METHODS.watch, {
    payload: KinPushWatchInput,
    success: KinPushWatchBeat,
    error,
    stream: true,
  }),
  // The phone in front, or a push arrived: what it still shows that is settled.
  Rpc.make(KIN_PUSH_WS_METHODS.reconcile, {
    payload: KinPushReconcileInput,
    success: KinPushReconcileResult,
    error,
  }),
] as const;

// Chat access is the gate: a device is bound to its caller's person and session, and gets
// pushes only for chats that person is in, from when they joined.
export const KIN_PUSH_RPC_SCOPES = {
  [KIN_PUSH_WS_METHODS.registerDevice]: AuthKinChatScope,
  [KIN_PUSH_WS_METHODS.unregisterDevice]: AuthKinChatScope,
  [KIN_PUSH_WS_METHODS.watch]: AuthKinChatScope,
  [KIN_PUSH_WS_METHODS.reconcile]: AuthKinChatScope,
} as const satisfies Record<
  (typeof KIN_PUSH_WS_METHODS)[keyof typeof KIN_PUSH_WS_METHODS],
  AuthEnvironmentScope
>;
