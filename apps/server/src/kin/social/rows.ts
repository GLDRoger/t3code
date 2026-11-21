// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  KIN_SOCIAL_PLATFORM_LABELS,
  type KinOrgId,
  type KinSocialAccount,
  type KinSocialMedia,
  type KinSocialPlatform,
  type KinSocialPostState,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { TextClock } from "../work/companyProfile.ts";

/** What each platform takes, checked before a post reaches a card. Conservative on purpose. */
export const PLATFORM_RULES: Record<
  KinSocialPlatform,
  {
    readonly label: string;
    readonly caption: number;
    /** What the platform won't post without. */
    readonly needs: "media" | "video" | null;
    readonly imageMb: number;
    readonly videoMb: number;
  }
> = {
  instagram: {
    label: KIN_SOCIAL_PLATFORM_LABELS.instagram,
    caption: 2200,
    needs: "media",
    imageMb: 8,
    videoMb: 300,
  },
  facebook: {
    label: KIN_SOCIAL_PLATFORM_LABELS.facebook,
    caption: 60000,
    needs: null,
    imageMb: 10,
    videoMb: 1000,
  },
  linkedin: {
    label: KIN_SOCIAL_PLATFORM_LABELS.linkedin,
    caption: 3000,
    needs: null,
    imageMb: 8,
    videoMb: 500,
  },
  twitter: {
    label: KIN_SOCIAL_PLATFORM_LABELS.twitter,
    caption: 280,
    needs: null,
    imageMb: 5,
    videoMb: 512,
  },
  threads: {
    label: KIN_SOCIAL_PLATFORM_LABELS.threads,
    caption: 500,
    needs: null,
    imageMb: 8,
    videoMb: 1000,
  },
  tiktok: {
    label: KIN_SOCIAL_PLATFORM_LABELS.tiktok,
    caption: 2200,
    needs: "media",
    imageMb: 20,
    videoMb: 1000,
  },
  youtube: {
    label: KIN_SOCIAL_PLATFORM_LABELS.youtube,
    caption: 5000,
    needs: "video",
    imageMb: 0,
    videoMb: 2000,
  },
  pinterest: {
    label: KIN_SOCIAL_PLATFORM_LABELS.pinterest,
    caption: 500,
    needs: "media",
    imageMb: 20,
    videoMb: 1000,
  },
  bluesky: {
    label: KIN_SOCIAL_PLATFORM_LABELS.bluesky,
    caption: 300,
    needs: null,
    imageMb: 1,
    videoMb: 50,
  },
  googlebusiness: {
    label: KIN_SOCIAL_PLATFORM_LABELS.googlebusiness,
    caption: 1500,
    needs: null,
    imageMb: 5,
    videoMb: 75,
  },
};
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime"]);

/** Why this caption and file can't go to this platform, in plain words; undefined when they can. */
export const mediaProblem = (
  platform: KinSocialPlatform,
  caption: string,
  media: KinSocialMedia | null,
): string | undefined => {
  const rule = PLATFORM_RULES[platform];
  const chars = [...caption].length;
  if (chars > rule.caption)
    return `${rule.label} takes at most ${rule.caption.toLocaleString("en")} characters; this caption has ${chars.toLocaleString("en")}.`;
  if (media === null) {
    if (rule.needs === "video") return `${rule.label} needs a video.`;
    if (rule.needs === "media") return `${rule.label} needs a picture or a video.`;
    if (caption.trim() === "") return "A post needs a caption or a picture.";
    return undefined;
  }
  const video = VIDEO_TYPES.has(media.mimeType);
  if (!video && !IMAGE_TYPES.has(media.mimeType))
    return `${media.name} is a ${media.mimeType} file; posts take JPEG, PNG, WebP or GIF pictures and MP4 or MOV videos.`;
  if (rule.needs === "video" && !video) return `${rule.label} needs a video, not a picture.`;
  const limitMb = video ? rule.videoMb : rule.imageMb;
  if (media.bytes > limitMb * 1024 * 1024)
    return `${media.name} is ${(media.bytes / 1048576).toFixed(1)} MB; ${rule.label} takes ${video ? "videos" : "pictures"} up to ${limitMb} MB.`;
  return undefined;
};

export type GroupRow = {
  readonly orgId: KinOrgId;
  readonly groupId: string;
  readonly partyId: string | null;
  readonly service: string;
  readonly profileId: string;
  readonly profileName: string | null;
  readonly accountsJson: string;
  readonly problem: string | null;
  readonly checkedAt: number | null;
  readonly createdAt: number;
  /** "Our own", or the client's name in Kin's records. */
  readonly label: string;
};

/** A draft is Social's alone; `discarded` is one it dropped; packs are `ready` until posted. */
export type PostRowState = KinSocialPostState | "draft" | "discarded" | "ready";

export type PostRow = {
  readonly orgId: KinOrgId;
  readonly postId: string;
  readonly kind: "post" | "pack";
  readonly groupId: string | null;
  readonly accountId: string | null;
  readonly whereText: string | null;
  readonly caption: string;
  readonly mediaJson: string | null;
  readonly atMs: number;
  readonly state: PostRowState;
  readonly cardId: string | null;
  readonly digest: string | null;
  readonly confirmedAt: number | null;
  readonly servicePostId: string | null;
  readonly attemptAt: number | null;
  readonly url: string | null;
  readonly reason: string | null;
  readonly polledAt: number | null;
  readonly agentId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export const OWN_LABEL = "Our own";

const groupColumns = (sql: SqlClient.SqlClient) => sql`g.org_id AS "orgId", g.group_id AS "groupId",
  g.party_id AS "partyId", g.service, g.profile_id AS "profileId", g.profile_name AS "profileName",
  g.accounts_json AS "accountsJson", g.problem, g.checked_at AS "checkedAt", g.created_at AS "createdAt",
  CASE WHEN g.party_id IS NULL THEN ${OWN_LABEL} ELSE COALESCE(r.title, 'A client') END AS label`;

/** Every live group, "Our own" first. Owner-level: only owner-level callers reach this. */
export const ownerLevelGroups = Effect.fn("KinSocialRows.groups")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<GroupRow>`SELECT ${groupColumns(sql)} FROM kin_social_groups g
    LEFT JOIN kin_records r ON r.org_id = g.org_id AND r.record_id = g.party_id
    WHERE g.org_id = ${orgId} AND g.removed_at IS NULL
    ORDER BY g.party_id IS NOT NULL, label, g.group_id`;
});

export const ownerLevelGroup = Effect.fn("KinSocialRows.group")(function* (
  orgId: KinOrgId,
  groupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<GroupRow>`SELECT ${groupColumns(sql)} FROM kin_social_groups g
    LEFT JOIN kin_records r ON r.org_id = g.org_id AND r.record_id = g.party_id
    WHERE g.org_id = ${orgId} AND g.group_id = ${groupId} AND g.removed_at IS NULL
    ORDER BY g.group_id`;
  return row;
});

/** Kin's clients the owner could connect, by name; dropped clients are left out. */
export const ownerLevelClients = Effect.fn("KinSocialRows.clients")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ clientId: string; label: string; key: string }>`SELECT
      record_id AS "clientId", title AS label, key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'clients' AND state <> 'dropped'
      AND COALESCE(category, 'client') = 'client'
    ORDER BY title, record_id LIMIT 500`;
});

const AccountsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      platform: Schema.String,
      name: Schema.String,
      handle: Schema.NullOr(Schema.String),
      problem: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeAccounts = Schema.decodeUnknownOption(AccountsJson);
export const encodeAccounts = (accounts: ReadonlyArray<KinSocialAccount>) =>
  JSON.stringify(accounts);
/** The accounts a group held when last checked, as the service named them. */
export const accountsOf = (
  group: Pick<GroupRow, "accountsJson">,
): ReadonlyArray<KinSocialAccount> =>
  Option.match(decodeAccounts(group.accountsJson), {
    onNone: () => [],
    onSome: (accounts) => accounts as ReadonlyArray<KinSocialAccount>,
  });

const MediaJson = Schema.fromJsonString(
  Schema.Struct({
    attachmentId: Schema.String,
    mimeType: Schema.String,
    name: Schema.String,
    bytes: Schema.Number,
  }),
);
const decodeMedia = Schema.decodeUnknownOption(MediaJson);
const encodeMediaJson = Schema.encodeSync(MediaJson);
export const encodeMedia = (media: KinSocialMedia | null) =>
  media === null ? null : encodeMediaJson(media);
export const mediaOf = (row: Pick<PostRow, "mediaJson">): KinSocialMedia | null =>
  row.mediaJson === null ? null : Option.getOrNull(decodeMedia(row.mediaJson));

const postColumns = (sql: SqlClient.SqlClient) => sql`org_id AS "orgId", post_id AS "postId", kind,
  group_id AS "groupId", account_id AS "accountId", where_text AS "whereText", caption,
  media_json AS "mediaJson", at_ms AS "atMs", state, card_id AS "cardId", digest,
  confirmed_at AS "confirmedAt", service_post_id AS "servicePostId", attempt_at AS "attemptAt",
  url, reason, polled_at AS "polledAt", agent_id AS "agentId", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

export const postById = Effect.fn("KinSocialRows.post")(function* (
  orgId: KinOrgId,
  postId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<PostRow>`SELECT ${postColumns(sql)} FROM kin_social_posts
    WHERE org_id = ${orgId} AND post_id = ${postId} ORDER BY post_id`;
  return row;
});

export const postsOfCard = Effect.fn("KinSocialRows.cardPosts")(function* (
  orgId: KinOrgId,
  cardId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PostRow>`SELECT ${postColumns(sql)} FROM kin_social_posts
    WHERE org_id = ${orgId} AND card_id = ${cardId} ORDER BY at_ms, post_id`;
});

/** A group's drafts still to come: what the next card is built from. */
export const draftsOfGroup = Effect.fn("KinSocialRows.drafts")(function* (
  orgId: KinOrgId,
  groupId: string,
  since: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PostRow>`SELECT ${postColumns(sql)} FROM kin_social_posts
    WHERE org_id = ${orgId} AND group_id = ${groupId} AND kind = 'post'
      AND state IN ('draft', 'proposed') AND at_ms >= ${since}
    ORDER BY at_ms, post_id LIMIT 40`;
});

/** Everything on Kin's calendar from `since`: drafts, posts on cards, packs. */
export const calendarPosts = Effect.fn("KinSocialRows.calendar")(function* (
  orgId: KinOrgId,
  since: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PostRow>`SELECT ${postColumns(sql)} FROM kin_social_posts
    WHERE org_id = ${orgId} AND state NOT IN ('discarded', 'removed') AND at_ms >= ${since}
    ORDER BY at_ms, post_id LIMIT 200`;
});

/** A post is read 2 minutes after its time, then every 10, for a day. */
const READ_AFTER_MS = 2 * 60_000;
const REREAD_MS = 10 * 60_000;
const GIVE_UP_READING_MS = 24 * 60 * 60_000;
/** Confirm needs a post's time at least this far ahead: a past time would post at once. */
export const CONFIRM_LEAD_MS = 10 * 60_000;
/** Undo closes this long before the time, so the service hasn't started sending it. */
export const UNDO_CLOSES_MS = 5 * 60_000;
/** A post Kin couldn't hand over by its time, after a restart, is not sent late on its own. */
export const LATE_MS = 15 * 60_000;

/** Posts the scheduler has work on: handing over, cancelling, or reading after their time. */
export const duePosts = Effect.fn("KinSocialRows.due")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<PostRow>`SELECT ${postColumns(sql)} FROM kin_social_posts
    WHERE kind = 'post' AND (state IN ('scheduling', 'undoing')
      OR (state = 'scheduled' AND at_ms + ${READ_AFTER_MS} <= ${now}
        AND MAX(at_ms, COALESCE(confirmed_at, 0)) > ${now - GIVE_UP_READING_MS}
        AND (polled_at IS NULL OR polled_at + ${REREAD_MS} <= ${now})))
    ORDER BY at_ms, org_id, post_id LIMIT 100`;
});

export const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const newId = (prefix: string) => `${prefix}${NodeCrypto.randomBytes(10).toString("hex")}`;

/** What Confirm signs: each post left on the card, exactly as it will go. */
export const digestOf = (
  posts: ReadonlyArray<Pick<PostRow, "postId" | "accountId" | "caption" | "mediaJson" | "atMs">>,
) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        [...posts]
          .sort((a, b) => (a.postId < b.postId ? -1 : 1))
          .map((post) => [post.postId, post.accountId, post.caption, post.mediaJson, post.atMs]),
      ),
    )
    .digest("hex")
    .slice(0, 32);

/** The same for every attempt at one confirmed post; a new Confirm is a new key. */
export const idempotencyKey = (post: Pick<PostRow, "postId" | "digest">) =>
  `kin-${post.postId}-${(post.digest ?? "").slice(0, 16)}`;

/** "Mon 18 Nov · 19:00" in the owner's zone and `clock`'s locale. */
export const whenLabel = (ms: number, clock: TextClock) =>
  `${formatKinWhen(ms, "day", clock)} · ${formatKinWhen(ms, "time", clock)}`;

/**
 * Whether Kin can post on this platform (any, without one): some connected group of the company,
 * with no problem of its own, holds a working account there. Social's "no account" fact.
 */
export const postsTo = Effect.fn("KinSocialRows.postsTo")(function* (
  orgId: KinOrgId,
  platform: KinSocialPlatform | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const groups = yield* sql<Pick<GroupRow, "accountsJson">>`SELECT accounts_json AS "accountsJson"
    FROM kin_social_groups WHERE org_id = ${orgId} AND removed_at IS NULL AND problem IS NULL
    ORDER BY group_id`;
  return groups.some((group) =>
    accountsOf(group).some(
      (account) =>
        account.problem === null && (platform === undefined || account.platform === platform),
    ),
  );
});
