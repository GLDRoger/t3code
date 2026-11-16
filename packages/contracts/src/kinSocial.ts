import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";
import { KinConnectionKey } from "./kinConnections.ts";

/**
 * Social accounts: the company's own and each client's, reached through one posting service.
 * A group is "Our own" or one client, with its own key; a post never leaves its group.
 */
export const KIN_SOCIAL_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
  "threads",
  "tiktok",
  "youtube",
  "pinterest",
  "bluesky",
  "googlebusiness",
] as const;
export const KinSocialPlatform = Schema.Literals(KIN_SOCIAL_PLATFORMS);
export type KinSocialPlatform = typeof KinSocialPlatform.Type;

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** An account as the service names it; Kin never takes these words from an agent. */
export const KinSocialAccount = Schema.Struct({
  accountId: Text(200),
  platform: KinSocialPlatform,
  name: Text(200),
  handle: Schema.NullOr(Text(200)),
  /** Why it can't post now, in plain words, with how to fix it; null when it can. */
  problem: Schema.NullOr(Text(400)),
});
export type KinSocialAccount = typeof KinSocialAccount.Type;

export const KinSocialGroupKind = Schema.Literals(["own", "client"]);
export type KinSocialGroupKind = typeof KinSocialGroupKind.Type;

export const KinSocialGroup = Schema.Struct({
  groupId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  kind: KinSocialGroupKind,
  /** The Kin client this group is, or null for the company's own. */
  clientId: Schema.NullOr(Text(64)),
  /** "Our own", or the client's name from Kin's records. */
  label: Text(200),
  service: Text(80),
  /** The profile the key reaches, as the service names it. */
  profileName: Schema.NullOr(Text(200)),
  accounts: Schema.Array(KinSocialAccount).check(Schema.isMaxLength(100)),
  /** Why the whole group doesn't work now (a dead key), with how to fix it. */
  problem: Schema.NullOr(Text(400)),
  checkedAt: Schema.NullOr(IsoDateTime),
  connectedAt: IsoDateTime,
});
export type KinSocialGroup = typeof KinSocialGroup.Type;

export const KinSocialView = Schema.Struct({
  orgId: KinOrgId,
  groups: Schema.Array(KinSocialGroup),
  /** Clients that could be connected: Kin's client records with no group yet. */
  clients: Schema.Array(Schema.Struct({ clientId: Text(64), label: Text(200) })).check(
    Schema.isMaxLength(500),
  ),
  /** Whether "Our own" is still free to connect. */
  ownFree: Schema.Boolean,
  service: Schema.Struct({ label: Text(80), keyUrl: Text(400), setup: Text(1000) }),
});
export type KinSocialView = typeof KinSocialView.Type;

export const KinSocialInput = Schema.Struct({ orgId: KinOrgId });
export type KinSocialInput = typeof KinSocialInput.Type;

/** Step one of connecting: Kin reads what the key reaches and holds the key until Confirm. */
export const KinSocialCheckInput = Schema.Struct({
  orgId: KinOrgId,
  kind: KinSocialGroupKind,
  clientId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  /** Reconnecting this group with a new key. */
  groupId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  key: KinConnectionKey,
});
export type KinSocialCheckInput = typeof KinSocialCheckInput.Type;

export const KinSocialCheck = Schema.Struct({
  checkId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  label: Text(200),
  profileName: Schema.NullOr(Text(200)),
  accounts: Schema.Array(KinSocialAccount),
  expiresAt: IsoDateTime,
});
export type KinSocialCheck = typeof KinSocialCheck.Type;

export const KinSocialConnectInput = Schema.Struct({
  orgId: KinOrgId,
  checkId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type KinSocialConnectInput = typeof KinSocialConnectInput.Type;

export const KinSocialGroupInput = Schema.Struct({
  orgId: KinOrgId,
  groupId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type KinSocialGroupInput = typeof KinSocialGroupInput.Type;

/** A link the owner forwards to a client, who connects one platform's account themselves. */
export const KinSocialLinkInput = Schema.Struct({
  orgId: KinOrgId,
  groupId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  platform: KinSocialPlatform,
  /** Reconnect this account rather than add one. */
  accountId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type KinSocialLinkInput = typeof KinSocialLinkInput.Type;
export const KinSocialLink = Schema.Struct({
  url: Text(2000),
  expiresAt: Schema.NullOr(IsoDateTime),
  /** What to tell the client with it, in the owner's words to forward. */
  note: Text(400),
});
export type KinSocialLink = typeof KinSocialLink.Type;

/** A file on a post or pack: a Kin attachment this card's message holds. */
export const KinSocialMedia = Schema.Struct({
  attachmentId: Text(200),
  mimeType: Text(100),
  name: Text(200),
  bytes: NonNegativeInt,
});
export type KinSocialMedia = typeof KinSocialMedia.Type;

export const KinSocialPostState = Schema.Literals([
  /** On the card, waiting for Confirm. */
  "proposed",
  "removed",
  /** Confirmed; Kin is handing it to the service. */
  "scheduling",
  "scheduled",
  /** Undo tapped; Kin is cancelling it at the service. */
  "undoing",
  "cancelled",
  "posted",
  "failed",
]);
export type KinSocialPostState = typeof KinSocialPostState.Type;

export const KinSocialCardPost = Schema.Struct({
  postId: Text(64),
  account: KinSocialAccount,
  caption: Text(5000),
  media: Schema.NullOr(KinSocialMedia),
  at: IsoDateTime,
  /** "Mon 18 Nov · 7:00 pm", in the owner's zone. */
  when: Text(80),
  state: KinSocialPostState,
  /** The live post, once it is out. */
  url: Schema.NullOr(Text(2000)),
  /** Why it failed, or why Undo or Retry isn't offered, in plain words. */
  reason: Schema.NullOr(Text(500)),
  /** Until when Undo still cancels it; null when Undo isn't offered. */
  undoUntil: Schema.NullOr(IsoDateTime),
});
export type KinSocialCardPost = typeof KinSocialCardPost.Type;

/**
 * The week's posts for one group, built by the server from stored drafts. Confirm signs exactly
 * the posts left (`digest`); a change after Confirm needs a new card.
 */
export const KIN_SOCIAL_WEEK_CARD = "social_week";
export const KinSocialWeekCard = Schema.Struct({
  text: Schema.String,
  groupId: Text(64),
  group: Schema.Struct({ kind: KinSocialGroupKind, label: Text(200) }),
  title: Text(200),
  posts: Schema.Array(KinSocialCardPost).check(Schema.isMaxLength(40)),
  /** What Confirm signs now: the posts left on the card. Null once confirmed. */
  digest: Schema.NullOr(Text(64)),
  confirmedAt: Schema.NullOr(IsoDateTime),
  /** A client's card: whether the owner noted the client's OK, and the preview made for them. */
  client: Schema.NullOr(
    Schema.Struct({
      ok: Schema.Boolean,
      notedAt: Schema.NullOr(IsoDateTime),
      preview: Schema.NullOr(KinSocialMedia),
      /** Kin is making the preview now. */
      making: Schema.Boolean,
    }),
  ),
  /** A newer card for this group replaced this one. */
  replaced: Schema.Boolean,
});
export type KinSocialWeekCard = typeof KinSocialWeekCard.Type;
export const KIN_SOCIAL_WEEK_CARD_ACTIONS = [
  "remove",
  "confirm",
  "undo",
  "retry",
  "client_ok",
  "preview",
] as const;
export type KinSocialWeekCardAction = (typeof KIN_SOCIAL_WEEK_CARD_ACTIONS)[number];

/** A post Kin can't make for the owner: everything to post it by hand, and when. */
export const KIN_SOCIAL_PACK_CARD = "social_pack";
export const KinSocialPackCard = Schema.Struct({
  text: Schema.String,
  packId: Text(64),
  /** Where it goes, such as "WhatsApp channel" or "Instagram Story". */
  where: Text(200),
  /** Why Kin can't post it itself. */
  why: Text(300),
  caption: Text(5000),
  media: Schema.NullOr(KinSocialMedia),
  at: IsoDateTime,
  when: Text(80),
  /** The reminder set for the time, through Kin's reminders; null if none was set. */
  reminderId: Schema.NullOr(Text(80)),
  posted: Schema.NullOr(IsoDateTime),
});
export type KinSocialPackCard = typeof KinSocialPackCard.Type;
export const KIN_SOCIAL_PACK_CARD_ACTIONS = ["posted"] as const;
export type KinSocialPackCardAction = (typeof KIN_SOCIAL_PACK_CARD_ACTIONS)[number];

const KinError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinSocialRpcs = [
  Rpc.make("kin.social.list", { payload: KinSocialInput, success: KinSocialView, error: KinError }),
  Rpc.make("kin.social.check", {
    payload: KinSocialCheckInput,
    success: KinSocialCheck,
    error: KinError,
  }),
  Rpc.make("kin.social.connect", {
    payload: KinSocialConnectInput,
    success: KinSocialView,
    error: KinError,
  }),
  Rpc.make("kin.social.refresh", {
    payload: KinSocialGroupInput,
    success: KinSocialView,
    error: KinError,
  }),
  Rpc.make("kin.social.remove", {
    payload: KinSocialGroupInput,
    success: KinSocialView,
    error: KinError,
  }),
  Rpc.make("kin.social.link", {
    payload: KinSocialLinkInput,
    success: KinSocialLink,
    error: KinError,
  }),
] as const;

export const KIN_SOCIAL_RPC_SCOPES = {
  "kin.social.list": AuthKinChatScope,
  "kin.social.check": AuthKinChatScope,
  "kin.social.connect": AuthKinChatScope,
  "kin.social.refresh": AuthKinChatScope,
  "kin.social.remove": AuthKinChatScope,
  "kin.social.link": AuthKinChatScope,
} as const;
