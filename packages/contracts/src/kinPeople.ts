import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { AuthSessionId, IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinPerson, KinPersonId, KinTrimmedText } from "./kinChat.ts";

export const KinInviteId = TrimmedNonEmptyString.pipe(Schema.brand("KinInviteId"));
export type KinInviteId = typeof KinInviteId.Type;

/** Default invite lifetime; the owner can ask for between an hour and thirty days. */
export const KIN_INVITE_DEFAULT_TTL_HOURS = 24 * 7;
export const KIN_INVITE_MAX_TTL_HOURS = 24 * 30;

/** GitHub usernames: alphanumeric or single hyphens, at most 39 characters. */
export const KinGithubLogin = KinTrimmedText.check(
  Schema.isMaxLength(39),
  Schema.makeFilter((value: string) => /^[A-Za-z0-9](?:-?[A-Za-z0-9])*$/.test(value), {
    expected: "a GitHub username",
  }),
);
export type KinGithubLogin = typeof KinGithubLogin.Type;

export const KinPeopleListInput = Schema.Struct({ orgId: KinOrgId });
export type KinPeopleListInput = typeof KinPeopleListInput.Type;
export const KinPeopleListResult = Schema.Struct({ people: Schema.Array(KinPerson) });
export type KinPeopleListResult = typeof KinPeopleListResult.Type;

export const KinPeopleCreateInviteInput = Schema.Struct({
  orgId: KinOrgId,
  displayName: KinTrimmedText.check(Schema.isMaxLength(80)),
  // The person's handle in the org; derived from the display name when omitted.
  handle: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(40))),
  // Re-inviting someone who is already a person binds a new device to that person.
  personId: Schema.optional(KinPersonId),
  ttlHours: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(KIN_INVITE_MAX_TTL_HOURS))),
});
export type KinPeopleCreateInviteInput = typeof KinPeopleCreateInviteInput.Type;
export const KinPeopleCreateInviteResult = Schema.Struct({
  inviteId: KinInviteId,
  // Shown once, to the owner who created the invite. Never stored or logged.
  secret: TrimmedNonEmptyString,
  displayName: KinTrimmedText,
  handle: KinTrimmedText,
  expiresAt: IsoDateTime,
});
export type KinPeopleCreateInviteResult = typeof KinPeopleCreateInviteResult.Type;

/** One of a person's devices: an auth session bound to them in one org. */
export const KinPersonDevice = Schema.Struct({
  sessionId: AuthSessionId,
  label: Schema.NullOr(KinTrimmedText),
  deviceType: Schema.NullOr(KinTrimmedText),
  boundAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type KinPersonDevice = typeof KinPersonDevice.Type;

export const KinPeopleListDevicesInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
});
export type KinPeopleListDevicesInput = typeof KinPeopleListDevicesInput.Type;
export const KinPeopleListDevicesResult = Schema.Struct({
  devices: Schema.Array(KinPersonDevice),
});
export type KinPeopleListDevicesResult = typeof KinPeopleListDevicesResult.Type;

export const KinPeopleRevokeDeviceInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  sessionId: AuthSessionId,
});
export type KinPeopleRevokeDeviceInput = typeof KinPeopleRevokeDeviceInput.Type;
export const KinPeopleRevokeDeviceResult = Schema.Struct({ revoked: Schema.Boolean });
export type KinPeopleRevokeDeviceResult = typeof KinPeopleRevokeDeviceResult.Type;

export const KinPeopleSetGithubLoginInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  githubLogin: Schema.NullOr(KinGithubLogin),
});
export type KinPeopleSetGithubLoginInput = typeof KinPeopleSetGithubLoginInput.Type;

/** POSTed to `/kin/invites/accept` by a device with no session yet. The secret is never logged. */
export const KinInviteAcceptRequest = Schema.Struct({
  secret: TrimmedNonEmptyString,
  label: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(80))),
});
export type KinInviteAcceptRequest = typeof KinInviteAcceptRequest.Type;
export const KinInviteAcceptResult = Schema.Struct({
  orgId: KinOrgId,
  person: KinPerson,
  sessionId: AuthSessionId,
  accessToken: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type KinInviteAcceptResult = typeof KinInviteAcceptResult.Type;
export const KIN_INVITE_ACCEPT_ROUTE = "/kin/invites/accept";

export const KIN_PEOPLE_WS_METHODS = {
  peopleList: "kin.people.list",
  peopleCreateInvite: "kin.people.createInvite",
  peopleListDevices: "kin.people.listDevices",
  peopleRevokeDevice: "kin.people.revokeDevice",
  peopleSetGithubLogin: "kin.people.setGithubLogin",
} as const;

const KinPeopleError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinPeopleRpcs = [
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleList, {
    payload: KinPeopleListInput,
    success: KinPeopleListResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleCreateInvite, {
    payload: KinPeopleCreateInviteInput,
    success: KinPeopleCreateInviteResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleListDevices, {
    payload: KinPeopleListDevicesInput,
    success: KinPeopleListDevicesResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleRevokeDevice, {
    payload: KinPeopleRevokeDeviceInput,
    success: KinPeopleRevokeDeviceResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleSetGithubLogin, {
    payload: KinPeopleSetGithubLoginInput,
    success: KinPerson,
    error: KinPeopleError,
  }),
] as const;

export const KIN_PEOPLE_RPC_SCOPES = {
  [KIN_PEOPLE_WS_METHODS.peopleList]: AuthKinChatScope,
  // An invite hands access to someone new, like a pairing link.
  [KIN_PEOPLE_WS_METHODS.peopleCreateInvite]: AuthAccessWriteScope,
  [KIN_PEOPLE_WS_METHODS.peopleListDevices]: AuthAccessReadScope,
  [KIN_PEOPLE_WS_METHODS.peopleRevokeDevice]: AuthAccessWriteScope,
  // A member links their own handle from a chat-only session; the service checks ownership.
  [KIN_PEOPLE_WS_METHODS.peopleSetGithubLogin]: AuthKinChatScope,
} as const satisfies Record<
  (typeof KIN_PEOPLE_WS_METHODS)[keyof typeof KIN_PEOPLE_WS_METHODS],
  AuthEnvironmentScope
>;
