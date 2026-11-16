import { KIN_SOCIAL_PLATFORMS, type KinSocialPlatform } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  SocialProviderError,
  type PostStats,
  type ProviderAccount,
  type ServicePostState,
  type SocialKey,
  type SocialProvider,
} from "./SocialProvider.ts";

/**
 * Zernio (zernio.com), read from its OpenAPI 1.624.0. One Kin group is one Zernio profile, reached
 * by a key limited to that profile. Webhooks are not used: a profile key may not register them
 * and Kin's host has no public address, so Kin reads a post's state after its time instead.
 */
const ZERNIO_API = "https://zernio.com/api/v1";

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const isPlatform = (value: unknown): value is KinSocialPlatform =>
  KIN_SOCIAL_PLATFORMS.some((platform) => platform === value);

const fail = (kind: SocialProviderError["kind"], message: string) =>
  new SocialProviderError({ kind, message });

/** The service's own words for a refusal, cut short; never the request or a key. */
const said = (body: unknown) => {
  const message = text(field(body, "error")) ?? text(field(body, "message"));
  return message === null ? "" : ` Zernio said: "${message.slice(0, 200)}"`;
};

type Write = { readonly method: "POST" | "PUT" | "DELETE"; readonly json?: unknown };

const call = Effect.fn("KinZernio.call")(function* (
  key: SocialKey,
  path: string,
  options: {
    readonly params?: Readonly<Record<string, string | undefined>>;
    readonly write?: Write;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
) {
  const http = yield* HttpClient.HttpClient;
  const url = `${ZERNIO_API}${path}`;
  const base =
    options.write === undefined
      ? HttpClientRequest.get(url)
      : HttpClientRequest.make(options.write.method)(url).pipe(
          options.write.json === undefined
            ? (request) => request
            : HttpClientRequest.bodyJsonUnsafe(options.write.json),
        );
  const request = base.pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(Redacted.value(key)),
    HttpClientRequest.setHeaders(options.headers ?? {}),
    HttpClientRequest.setUrlParams(
      Object.fromEntries(
        Object.entries(options.params ?? {}).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
    ),
  );
  const response = yield* http
    .execute(request)
    .pipe(
      Effect.mapError(() =>
        fail("unavailable", "Kin couldn't reach Zernio. Nothing is known to have changed there."),
      ),
    );
  const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
  const status = response.status;
  if (status >= 200 && status < 300) return { status, body };
  if (status === 401)
    return yield* fail(
      "auth",
      `Zernio refused the key: it may be wrong, expired or deleted. Make a new one and reconnect.${said(body)}`,
    );
  if (status === 403)
    return yield* fail("scope", `Zernio refused: this key can't reach that.${said(body)}`);
  if (status === 404)
    return yield* fail("not_found", `Zernio has nothing by that id.${said(body)}`);
  if (status === 409)
    return yield* fail("conflict", `Zernio says this is already in hand.${said(body)}`);
  if (status === 429)
    return yield* fail("rate_limit", "Zernio says Kin is asking too often. Try again in a minute.");
  if (status === 400 || status === 422)
    return yield* fail(
      field(body, "type") === "platform_error" ? "platform" : "invalid",
      `Zernio refused it.${said(body)}`,
    );
  return yield* fail("unavailable", `Zernio answered with an error (HTTP ${status}).${said(body)}`);
});

const accountOf = (one: unknown, problems: ReadonlyMap<string, string>): ProviderAccount[] => {
  const accountId = text(field(one, "_id")) ?? text(field(one, "id"));
  const platform = field(one, "platform");
  const profileId = text(field(one, "profileId")) ?? text(field(one, "profileId", "_id"));
  if (accountId === null || !isPlatform(platform) || profileId === null) return [];
  const handle = text(field(one, "username"));
  const name = text(field(one, "displayName")) ?? handle ?? platform;
  const inactive = field(one, "isActive") === false;
  return [
    {
      accountId,
      profileId,
      platform,
      name,
      handle,
      problem:
        problems.get(accountId) ??
        (inactive ? "This account was switched off in Zernio. Reconnect it there." : null),
    },
  ];
};

/** The service's post state, in Kin's few words. */
const stateOf = (post: unknown): ServicePostState => {
  switch (text(field(post, "status"))) {
    case "published":
      return "posted";
    case "partial":
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "publishing":
      return "publishing";
    default:
      return "scheduled";
  }
};
const postOf = (post: unknown) => {
  const target = list(field(post, "platforms"))[0];
  const reason = text(field(target, "errorMessage")) ?? text(field(target, "error"));
  return {
    state: stateOf(post),
    url: text(field(target, "platformPostUrl")),
    reason: reason === null ? null : `The platform said: "${reason.slice(0, 300)}"`,
  };
};

export const zernio: SocialProvider = {
  service: "zernio",
  label: "Zernio",
  keyUrl: "https://zernio.com/dashboard/api-keys",
  setup:
    "In Zernio: make a profile for this group and connect its accounts, then API keys → New key, scope Profiles, only that profile, read-write. Paste the key here.",
  // X passes its own per-read charge through; every other platform's reads are free.
  readCost: (platform) => (platform === "twitter" ? "$0.005 a read on X" : null),
  reach: Effect.fn("KinZernio.reach")(function* (key) {
    const { body } = yield* call(key, "/profiles");
    const profiles = list(field(body, "profiles")).flatMap((one) => {
      const profileId = text(field(one, "_id"));
      return profileId === null
        ? []
        : [{ profileId, name: text(field(one, "name")) ?? "Unnamed profile" }];
    });
    // A key limited to profiles is refused here; a whole-workspace key isn't (OpenAPI: webhooks).
    const limitedToProfiles = yield* call(key, "/webhooks/settings").pipe(
      Effect.as(false),
      Effect.catchIf(
        (error) => error.kind === "scope",
        () => Effect.succeed(true),
      ),
    );
    return { profiles, limitedToProfiles };
  }),
  accounts: Effect.fn("KinZernio.accounts")(function* (key, profileId) {
    const { body } = yield* call(key, "/accounts", { params: { profileId } });
    const health = yield* call(key, "/accounts/health").pipe(
      Effect.map(({ body }) => list(field(body, "accounts"))),
      Effect.orElseSucceed((): ReadonlyArray<unknown> => []),
    );
    const problems = new Map(
      health.flatMap((one) => {
        const accountId = text(field(one, "accountId"));
        if (accountId === null) return [];
        if (field(one, "needsReconnect") === true || field(one, "canPost") === false)
          return [
            [
              accountId,
              "Its sign-in at the platform stopped working. Send a reconnect link, or reconnect it in Zernio.",
            ] as const,
          ];
        return [];
      }),
    );
    return list(field(body, "accounts"))
      .flatMap((one) => accountOf(one, problems))
      .filter((account) => account.profileId === profileId);
  }),
  connectLink: Effect.fn("KinZernio.connectLink")(function* (key, input) {
    const { body } = yield* call(key, "/platform-invites", {
      write: {
        method: "POST",
        json: {
          profileId: input.profileId,
          platform: input.platform,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          // Facebook Login is what lets Kin look up public Instagram accounts later.
          ...(input.platform === "instagram" && input.accountId === undefined
            ? { loginMethod: "facebook_login" }
            : {}),
        },
      },
    });
    const url = text(field(body, "invite", "inviteUrl"));
    if (url === null) return yield* fail("unavailable", "Zernio made no link.");
    return { url, expiresAt: text(field(body, "invite", "expiresAt")) };
  }),
  posts: Effect.fn("KinZernio.posts")(function* (key, input) {
    const { body } = yield* call(key, "/analytics", {
      params: {
        profileId: input.profileId,
        accountId: input.accountId,
        fromDate: input.fromDate,
        limit: "50",
      },
    });
    return list(field(body, "posts")).map((post): PostStats => ({
      accountId: text(field(list(field(post, "platforms"))[0], "accountId")),
      platform: text(field(post, "platform")) ?? "unknown",
      caption: text(field(post, "content")),
      publishedAt: text(field(post, "publishedAt")),
      url: text(field(post, "platformPostUrl")),
      mediaType: text(field(post, "mediaType")),
      likes: count(field(post, "analytics", "likes")),
      comments: count(field(post, "analytics", "comments")),
      shares: count(field(post, "analytics", "shares")),
      saves: count(field(post, "analytics", "saves")),
      reach: count(field(post, "analytics", "reach")),
      views: count(field(post, "analytics", "views")),
    }));
  }),
  bestTimes: Effect.fn("KinZernio.bestTimes")(function* (key, profileId) {
    const { body } = yield* call(key, "/analytics/best-time", { params: { profileId } });
    return list(field(body, "slots")).flatMap((slot) => {
      const dayOfWeek = count(field(slot, "day_of_week"));
      const hourUtc = count(field(slot, "hour"));
      if (dayOfWeek === null || hourUtc === null) return [];
      return [
        {
          dayOfWeek,
          hourUtc,
          avgEngagement: count(field(slot, "avg_engagement")) ?? 0,
          posts: count(field(slot, "post_count")) ?? 0,
        },
      ];
    });
  }),
  lookup: Effect.fn("KinZernio.lookup")(function* (key, input) {
    const { body } = yield* call(
      key,
      `/accounts/${encodeURIComponent(input.viaAccountId)}/instagram/business-discovery`,
      { params: { username: input.username, limit: "12" } },
    );
    return {
      username: text(field(body, "profile", "username")) ?? input.username,
      name: text(field(body, "profile", "name")),
      followers: count(field(body, "profile", "followersCount")),
      posts: count(field(body, "profile", "mediaCount")),
      recent: list(field(body, "media")).map((media) => ({
        caption: text(field(media, "caption")),
        at: text(field(media, "timestamp")),
        likes: count(field(media, "likeCount")),
        comments: count(field(media, "commentsCount")),
        kind: text(field(media, "mediaProductType")) ?? text(field(media, "mediaType")),
        url: text(field(media, "permalink")),
      })),
    };
  }),
  upload: Effect.fn("KinZernio.upload")(function* (key, file) {
    const { body } = yield* call(key, "/media/presign", {
      write: { method: "POST", json: { filename: file.name, contentType: file.mimeType } },
    });
    const uploadUrl = text(field(body, "uploadUrl"));
    const publicUrl = text(field(body, "publicUrl"));
    if (uploadUrl === null || publicUrl === null)
      return yield* fail("unavailable", "Zernio gave no place to upload the file.");
    const http = yield* HttpClient.HttpClient;
    // The upload address carries its own signature; the key never goes there.
    const put = yield* http
      .execute(
        HttpClientRequest.put(uploadUrl).pipe(
          HttpClientRequest.setBody(HttpBody.uint8Array(file.bytes, file.mimeType)),
        ),
      )
      .pipe(Effect.mapError(() => fail("unavailable", "Kin couldn't upload the file to Zernio.")));
    if (put.status < 200 || put.status >= 300)
      return yield* fail("unavailable", `Zernio's storage refused the file (HTTP ${put.status}).`);
    return { url: publicUrl };
  }),
  schedule: Effect.fn("KinZernio.schedule")(function* (key, request) {
    const { body } = yield* call(key, "/posts", {
      headers: { "Idempotency-Key": request.idempotencyKey },
      write: {
        method: "POST",
        json: {
          content: request.caption,
          scheduledFor: request.at,
          platforms: [{ platform: request.platform, accountId: request.accountId }],
          ...(request.media === null
            ? {}
            : { mediaItems: [{ url: request.media.url, type: kindOf(request.media.mimeType) }] }),
          metadata: { kinPost: request.idempotencyKey },
        },
      },
    });
    const id = text(field(body, "post", "_id"));
    if (id === null) return yield* fail("unavailable", "Zernio didn't say what it made.");
    return { id };
  }),
  status: Effect.fn("KinZernio.status")(function* (key, id) {
    const { body } = yield* call(key, `/posts/${encodeURIComponent(id)}`).pipe(
      Effect.catchIf(
        (error) => error.kind === "not_found",
        () => Effect.succeed({ status: 404, body: null }),
      ),
    );
    if (body === null) return { state: "gone" as const, url: null, reason: null };
    return postOf(field(body, "post"));
  }),
  cancel: Effect.fn("KinZernio.cancel")(function* (key, id) {
    yield* call(key, `/posts/${encodeURIComponent(id)}`, { write: { method: "DELETE" } });
  }),
  retry: Effect.fn("KinZernio.retry")(function* (key, id) {
    const { body } = yield* call(key, `/posts/${encodeURIComponent(id)}/retry`, {
      write: { method: "POST" },
    });
    return postOf(field(body, "post") ?? body);
  }),
};

const kindOf = (mimeType: string) =>
  mimeType.startsWith("video/") ? "video" : mimeType === "image/gif" ? "gif" : "image";
