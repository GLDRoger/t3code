import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthClientMetadataDeviceType,
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
import { KinMonthNumber } from "./kinFinance.ts";
import { KinCurrency, KinDay } from "./kinMoney.ts";
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
  // Someone else who shares a removed person's name: a new person instead of the bring-back offer.
  newPerson: Schema.optional(Schema.Literal(true)),
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
  /** When it last opened a connection, which is not the same as last use. Absent from older hosts. */
  lastConnectedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** The device asking. Absent from older hosts. */
  current: Schema.optional(Schema.Boolean),
  /** The device whose link brought this one in; removing that device removes this one too. */
  linkedFrom: Schema.optional(Schema.NullOr(AuthSessionId)),
  /** The invite or link this device joined with. Absent from older hosts. */
  linkId: Schema.optional(Schema.NullOr(KinInviteId)),
  /** Whether the device asking may remove this one. Absent from older hosts. */
  removable: Schema.optional(Schema.Boolean),
  /** Live coding-agent keys made on this device; removing it ends them. Absent from older hosts. */
  keysMade: Schema.optional(NonNegativeInt),
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

/** A person links one more of their own devices: a link, good once, briefly. */
export const KinPeopleLinkDeviceInput = Schema.Struct({ orgId: KinOrgId });
export type KinPeopleLinkDeviceInput = typeof KinPeopleLinkDeviceInput.Type;
export const KinPeopleLinkDeviceResult = Schema.Struct({
  /** Which link it is: the device that joins with it lists it as its `linkId`. */
  linkId: KinInviteId,
  /** The join link's secret, as `createInvite` gives it. */
  secret: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type KinPeopleLinkDeviceResult = typeof KinPeopleLinkDeviceResult.Type;
export const KIN_DEVICE_LINK_TTL_MINUTES = 10;
/** One wording wherever Kin says a device was linked: never the device's own, chosen name. */
export const KIN_DEVICE_LINKED_NOTICE =
  "A new device was just linked to your Kin. If it wasn't you, remove it in Your devices.";
/** Devices one person may have signed in at once. */
export const KIN_DEVICE_LIMIT = 10;

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
  /** The company's home currency, which every member's forms start amounts in; absent from an older host. */
  homeCurrency: Schema.optional(KinCurrency),
  /** The company's country, ISO 3166 alpha-2, null for none; absent from an older host. */
  country: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/)))),
  /** The month the company's financial year starts in, 1 for January; absent from an older host. */
  financialYearStartMonth: Schema.optional(KinMonthNumber),
  /** True while a company created new has no country chosen: nothing that records money is made until it is. */
  countryNeeded: Schema.optional(Schema.Boolean),
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
/** Local times in the person's zone with nothing unprompted; `from` after `to` spans midnight. */
export const KinPersonQuietHours = Schema.Struct({ from: TimeOfDay, to: TimeOfDay });
export type KinPersonQuietHours = typeof KinPersonQuietHours.Type;

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
  /** Their own quiet hours; absent, the company's (`KinPeopleProfilesResult.quietHours`). */
  quietHours: Schema.optional(KinPersonQuietHours),
  /**
   * Kin holds non-urgent lines outside their working hours until those start. Absent, the
   * default: on for everyone but the owner.
   */
  holdOutsideHours: Schema.optional(Schema.Boolean),
  /**
   * Away until this day, on their own calendar: Kin holds non-urgent lines until it starts.
   * Absent once the day has come, and from older hosts.
   */
  awayUntil: Schema.optional(KinDay),
  /** The tasks they hold now; only the owner reads it. */
  load: Schema.optional(Schema.Struct({ open: NonNegativeInt, late: NonNegativeInt })),
  /** The reader may change this profile (the check `kin.people.updateProfile` runs); absent from older hosts. */
  canEdit: Schema.optional(Schema.Boolean),
});
export type KinPersonProfile = typeof KinPersonProfile.Type;
export const KinPeopleProfilesResult = Schema.Struct({
  profiles: Schema.Array(KinPersonProfile),
  ownerPersonId: KinPersonId,
  /** The company's quiet hours, which anyone without their own keeps; absent from older hosts. */
  quietHours: Schema.optional(KinPersonQuietHours),
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
  /** Null goes back to the company's. */
  quietHours: Schema.optional(Schema.NullOr(KinPersonQuietHours)),
  holdOutsideHours: Schema.optional(Schema.Boolean),
  /** Away until this day on their calendar; null is "I'm back". The owner level sets a teammate's. */
  awayUntil: Schema.optional(Schema.NullOr(KinDay)),
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
  /** What kind of device is joining; the phone app when absent. */
  deviceType: Schema.optional(AuthClientMetadataDeviceType),
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
  peopleLinkDevice: "kin.people.linkDevice",
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
  Rpc.make(KIN_PEOPLE_WS_METHODS.peopleLinkDevice, {
    payload: KinPeopleLinkDeviceInput,
    success: KinPeopleLinkDeviceResult,
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
  [KIN_PEOPLE_WS_METHODS.peopleLinkDevice]: AuthKinChatScope,
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

/**
 * Whether a URL's host reaches only the machine it runs on, so an invite link to it opens for no
 * one else: loopback names and addresses. A private, link-local, `.local` or tailnet address
 * reaches teammates on that network, so it isn't.
 */
export const kinIsLocalOnlyHost = (hostname: string) => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:(?:127(?:\.\d{1,3}){3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(host)
  );
};
