import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinActionId } from "./kinApprovals.ts";
import { KinChatId, KinOrgId, KinTrimmedText, KinWidgetId } from "./kinChat.ts";

/** A native APNs device token in hex. Apple says not to fix the length; today it is 32 bytes. */
export const KinPushToken = Schema.String.check(
  Schema.makeFilter((value: string) => /^[0-9a-f]{64,400}$/.test(value), {
    expected: "a lowercase hex APNs device token",
  }),
);
export type KinPushToken = typeof KinPushToken.Type;

/** Android (FCM) waits until someone uses Android (mobile spec, open questions). */
export const KinPushPlatform = Schema.Literals(["ios"]);
export type KinPushPlatform = typeof KinPushPlatform.Type;
export const KinApsEnvironment = Schema.Literals(["development", "production"]);
export type KinApsEnvironment = typeof KinApsEnvironment.Type;

/** `aps.category`; the phone registers the matching buttons (mobile spec, notifications). */
export const KinPushCategory = Schema.Literals([
  "kin.approval",
  "kin.deferral.confirmed",
  "kin.deferral.heads_up",
  "kin.message",
]);
export type KinPushCategory = typeof KinPushCategory.Type;

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
  pendingActionId: Schema.optional(KinActionId),
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

export const KinPushWatchInput = Schema.Struct({ chatId: KinChatId });
export type KinPushWatchInput = typeof KinPushWatchInput.Type;

/** One per beat interval; the server counts a beat as presence only once the client acks it. */
export const KinPushWatchBeat = Schema.Literal("beat");
export type KinPushWatchBeat = typeof KinPushWatchBeat.Type;

export class KinPushError extends Schema.TaggedError<KinPushError>()("KinPushError", {
  reason: Schema.Literals(["not_member", "unavailable"]),
  message: Schema.String,
}) {}

export const KIN_PUSH_WS_METHODS = {
  registerDevice: "kin.push.registerDevice",
  unregisterDevice: "kin.push.unregisterDevice",
  watch: "kin.push.watch",
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
] as const;

// A device only receives what its session can already read, so reading is the gate.
export const KIN_PUSH_RPC_SCOPES = {
  [KIN_PUSH_WS_METHODS.registerDevice]: AuthOrchestrationReadScope,
  [KIN_PUSH_WS_METHODS.unregisterDevice]: AuthOrchestrationReadScope,
  [KIN_PUSH_WS_METHODS.watch]: AuthOrchestrationReadScope,
} as const satisfies Record<
  (typeof KIN_PUSH_WS_METHODS)[keyof typeof KIN_PUSH_WS_METHODS],
  AuthEnvironmentScope
>;
