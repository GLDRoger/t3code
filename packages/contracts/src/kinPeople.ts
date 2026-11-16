import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import {
  AuthSessionId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KinAgentId,
  KinAttachment,
  KinChatError,
  KinOrgId,
  KinPerson,
  KinPersonAccess,
  KinPersonId,
  KinRoleTags,
  KinTrimmedText,
} from "./kinChat.ts";
import { TimeOfDay, TimeZone } from "./kinTime.ts";
import { KinRecordRef } from "./kinWork.ts";

export const KinInviteId = TrimmedNonEmptyString.pipe(Schema.brand("KinInviteId"));
export type KinInviteId = typeof KinInviteId.Type;

/** Default invite lifetime; the owner can ask for between an hour and thirty days. */
export const KIN_INVITE_DEFAULT_TTL_HOURS = 24 * 7;
const KIN_INVITE_MAX_TTL_HOURS = 24 * 30;

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
/** The places a person sees beyond Chats and Tasks. Owner-level people see every place. */
export const KinPersonPlaceSwitches = Schema.Struct({
  clients: Schema.Boolean,
  docs: Schema.Boolean,
  money: Schema.Boolean,
});
export type KinPersonPlaceSwitches = typeof KinPersonPlaceSwitches.Type;
/** A person's places and the projects they lead, each lead's project also opening its places. */
export const KinPersonPlaces = Schema.Struct({
  personId: KinPersonId,
  ...KinPersonPlaceSwitches.fields,
  leads: Schema.Array(KinRecordRef),
});
export type KinPersonPlaces = typeof KinPersonPlaces.Type;

export const KinPeopleListResult = Schema.Struct({
  people: Schema.Array(KinPerson),
  // The people with a device that still opens Kin; the rest need a new invite link.
  joined: Schema.Array(KinPersonId),
  // Absent from a host older than places.
  places: Schema.optional(Schema.Array(KinPersonPlaces)),
});
export type KinPeopleListResult = typeof KinPeopleListResult.Type;

export const KinPeopleCreateInviteInput = Schema.Struct({
  orgId: KinOrgId,
  displayName: KinTrimmedText.check(Schema.isMaxLength(80)),
  // The person's handle in the org; derived from the display name when omitted.
  handle: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(40))),
  // Re-inviting someone who is already a person binds a new device to that person.
  personId: Schema.optional(KinPersonId),
  ttlHours: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(KIN_INVITE_MAX_TTL_HOURS)),
  ),
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

export const KinPeopleListInvitesResult = Schema.Struct({
  invites: Schema.Array(
    Schema.Struct({
      inviteId: KinInviteId,
      personId: Schema.NullOr(KinPersonId),
      displayName: KinTrimmedText,
      handle: KinTrimmedText,
      createdAt: IsoDateTime,
      expiresAt: IsoDateTime,
    }),
  ),
});
export type KinPeopleListInvitesResult = typeof KinPeopleListInvitesResult.Type;
export const KinPeopleRevokeInviteInput = Schema.Struct({ orgId: KinOrgId, inviteId: KinInviteId });
export type KinPeopleRevokeInviteInput = typeof KinPeopleRevokeInviteInput.Type;

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

/** Signs a person out everywhere and cancels their unused invite links. They stay a person. */
export const KinPeopleRemoveAccessInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
});
export type KinPeopleRemoveAccessInput = typeof KinPeopleRemoveAccessInput.Type;

export const KinPeopleSetGithubLoginInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  githubLogin: Schema.NullOr(KinGithubLogin),
});
export type KinPeopleSetGithubLoginInput = typeof KinPeopleSetGithubLoginInput.Type;

/** The owner makes someone a co-owner or puts them back to member. Nobody else changes a kind. */
export const KinPeopleSetAccessInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  access: Schema.Literals(["co_owner", "member"]),
});
export type KinPeopleSetAccessInput = typeof KinPeopleSetAccessInput.Type;

/** The owner or a co-owner switches what a member may see; a switch left out stays as it is. */
export const KinPeopleSetPlacesInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  clients: Schema.optional(Schema.Boolean),
  docs: Schema.optional(Schema.Boolean),
  money: Schema.optional(Schema.Boolean),
});
export type KinPeopleSetPlacesInput = typeof KinPeopleSetPlacesInput.Type;

export const KinAccessMeInput = Schema.Struct({ orgId: KinOrgId });
export type KinAccessMeInput = typeof KinAccessMeInput.Type;
/** The caller's own kind, which decides their dock and screens. */
export const KinAccessMeResult = Schema.Struct({
  personId: KinPersonId,
  access: KinPersonAccess,
  // Absent from a host older than places; an owner-level person's are all on.
  places: Schema.optional(KinPersonPlaceSwitches),
  leads: Schema.optional(Schema.Array(KinRecordRef)),
});
export type KinAccessMeResult = typeof KinAccessMeResult.Type;

export const KIN_PROFILE_NAME_MAX = 80;
export const KIN_PROFILE_SKILLS_MAX = 300;
export const KIN_PROFILE_TALK_MAX = 200;
/** Days are 0 (Sunday) to 6; start and end are local times in the person's time zone. */
export const KinWorkHours = Schema.Struct({
  days: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))).check(
    Schema.isMaxLength(7),
  ),
  start: TimeOfDay,
  end: TimeOfDay,
});
export type KinWorkHours = typeof KinWorkHours.Type;

/** Who someone is, in their own words. Everyone in the org reads it. */
export const KinPersonProfile = Schema.Struct({
  personId: KinPersonId,
  displayName: KinTrimmedText,
  handle: KinTrimmedText,
  // An attachment id; the host serves it to anyone in the org.
  pictureId: Schema.NullOr(TrimmedNonEmptyString),
  roleTags: KinRoleTags,
  skills: Schema.String,
  timeZone: Schema.NullOr(TimeZone),
  workHours: Schema.NullOr(KinWorkHours),
  /** How they like to be spoken to, in their own words; absent from older hosts. */
  talkStyle: Schema.optional(Schema.String),
  /** The tasks they hold now; only the owner reads it. */
  load: Schema.optional(Schema.Struct({ open: NonNegativeInt, late: NonNegativeInt })),
  /** The reader may change this profile (the check `kin.people.updateProfile` runs); absent from older hosts. */
  canEdit: Schema.optional(Schema.Boolean),
});
export type KinPersonProfile = typeof KinPersonProfile.Type;
export const KinPeopleProfilesResult = Schema.Struct({
  profiles: Schema.Array(KinPersonProfile),
  ownerPersonId: KinPersonId,
});
export type KinPeopleProfilesResult = typeof KinPeopleProfilesResult.Type;

/**
 * Omitted fields stay as they are. Anyone edits their own; the owner edits anyone's name and role
 * tags. `picture` is a fresh upload, or null to remove it.
 */
export const KinPeopleUpdateProfileInput = Schema.Struct({
  orgId: KinOrgId,
  personId: KinPersonId,
  displayName: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(KIN_PROFILE_NAME_MAX))),
  roleTags: Schema.optional(KinRoleTags),
  skills: Schema.optional(Schema.String.check(Schema.isMaxLength(KIN_PROFILE_SKILLS_MAX))),
  timeZone: Schema.optional(Schema.NullOr(TimeZone)),
  workHours: Schema.optional(Schema.NullOr(KinWorkHours)),
  talkStyle: Schema.optional(Schema.String.check(Schema.isMaxLength(KIN_PROFILE_TALK_MAX))),
  picture: Schema.optional(Schema.NullOr(KinAttachment)),
});
export type KinPeopleUpdateProfileInput = typeof KinPeopleUpdateProfileInput.Type;

/** The agent every teammate may message, or null for none. Owner only. */
export const KinOrgSetTeamAgentInput = Schema.Struct({
  orgId: KinOrgId,
  agentId: Schema.NullOr(KinAgentId),
});
export type KinOrgSetTeamAgentInput = typeof KinOrgSetTeamAgentInput.Type;
export const KinOrgSetTeamAgentResult = Schema.Struct({ teamAgentId: Schema.NullOr(KinAgentId) });
export type KinOrgSetTeamAgentResult = typeof KinOrgSetTeamAgentResult.Type;
/** The owner's own name, as agents address them and teammates see them. Owner only. */
export const KinPeopleSetOwnerNameInput = Schema.Struct({
  orgId: KinOrgId,
  displayName: KinTrimmedText.check(Schema.isMaxLength(80)),
});
export type KinPeopleSetOwnerNameInput = typeof KinPeopleSetOwnerNameInput.Type;

/** POSTed to `/kin/invites/accept` by a device with no session yet. The secret is never logged. */
export const KinInviteAcceptRequest = Schema.Struct({
  secret: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
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
/** The same accept for a browser: under `/api` so the web app reaches it, answered with a cookie. */
export const KIN_INVITE_BROWSER_ACCEPT_ROUTE = "/api/kin/invites/accept";
/** A URL scheme, such as `kin`, without the colon. */
export const KinAppScheme = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9+.-]{0,31}$/));
/**
 * GET with no session: the scheme of the app this host's teammates install, for the invite page
 * a phone's browser opens. The web build is shared with T3 Code, so only the host knows it.
 */
export const KIN_INVITE_APP_ROUTE = "/api/kin/invites/app";
export const KinInviteAppResult = Schema.Struct({ appScheme: KinAppScheme });
export type KinInviteAppResult = typeof KinInviteAppResult.Type;

export const KIN_PEOPLE_WS_METHODS = {
  peopleListInvites: "kin.people.listInvites",
  peopleRevokeInvite: "kin.people.revokeInvite",
  peopleList: "kin.people.list",
  peopleCreateInvite: "kin.people.createInvite",
  peopleListDevices: "kin.people.listDevices",
  peopleRevokeDevice: "kin.people.revokeDevice",
  peopleRemoveAccess: "kin.people.removeAccess",
  peopleSetGithubLogin: "kin.people.setGithubLogin",
  peopleSetAccess: "kin.people.setAccess",
  peopleSetPlaces: "kin.people.setPlaces",
  accessMe: "kin.access.me",
  peopleProfiles: "kin.people.profiles",
  peopleUpdateProfile: "kin.people.updateProfile",
  orgSetTeamAgent: "kin.org.setTeamAgent",
  peopleSetOwnerName: "kin.people.setOwnerName",
} as const;

const KinPeopleError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinPeopleRpcs = [
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleListInvites, {
    payload: KinPeopleListInput,
    success: KinPeopleListInvitesResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleRevokeInvite, {
    payload: KinPeopleRevokeInviteInput,
    success: KinPeopleRevokeDeviceResult,
    error: KinPeopleError,
  }),
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
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleRemoveAccess, {
    payload: KinPeopleRemoveAccessInput,
    success: KinPeopleRevokeDeviceResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleSetGithubLogin, {
    payload: KinPeopleSetGithubLoginInput,
    success: KinPerson,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleSetAccess, {
    payload: KinPeopleSetAccessInput,
    success: KinPerson,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleSetPlaces, {
    payload: KinPeopleSetPlacesInput,
    success: KinPersonPlaces,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.accessMe, {
    payload: KinAccessMeInput,
    success: KinAccessMeResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleProfiles, {
    payload: KinPeopleListInput,
    success: KinPeopleProfilesResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleUpdateProfile, {
    payload: KinPeopleUpdateProfileInput,
    success: KinPersonProfile,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.orgSetTeamAgent, {
    payload: KinOrgSetTeamAgentInput,
    success: KinOrgSetTeamAgentResult,
    error: KinPeopleError,
  }),
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleSetOwnerName, {
    payload: KinPeopleSetOwnerNameInput,
    success: KinPerson,
    error: KinPeopleError,
  }),
] as const;

// Every Kin method takes a Kin session; who may call it is `KIN_RPC_ACCESS`, from stored kinds.
export const KIN_PEOPLE_RPC_SCOPES = {
  [KIN_PEOPLE_WS_METHODS.peopleListInvites]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleRevokeInvite]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleList]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleCreateInvite]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleListDevices]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleRevokeDevice]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleRemoveAccess]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleSetGithubLogin]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleSetAccess]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleSetPlaces]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.accessMe]: AuthKinChatScope,
  // Everyone in the org reads profiles; the service checks who may edit whose.
  [KIN_PEOPLE_WS_METHODS.peopleProfiles]: AuthKinChatScope,
  [KIN_PEOPLE_WS_METHODS.peopleUpdateProfile]: AuthKinChatScope,
  // The service lets only the owner set it.
  [KIN_PEOPLE_WS_METHODS.orgSetTeamAgent]: AuthKinChatScope,
  // The owner names themself from their phone's chat session; the service checks ownership.
  [KIN_PEOPLE_WS_METHODS.peopleSetOwnerName]: AuthKinChatScope,
} as const satisfies Record<
  (typeof KIN_PEOPLE_WS_METHODS)[keyof typeof KIN_PEOPLE_WS_METHODS],
  AuthEnvironmentScope
>;
