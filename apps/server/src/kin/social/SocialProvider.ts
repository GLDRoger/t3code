import type { KinSocialPlatform } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/**
 * Why a call to the posting service didn't work, in words the owner can act on. `kind` decides
 * what Kin does next; `message` never carries a key or a service's raw body.
 */
export class SocialProviderError extends Schema.TaggedError<SocialProviderError>()(
  "SocialProviderError",
  {
    kind: Schema.Literals([
      /** The key is wrong, expired or revoked. */
      "auth",
      /** The key may not reach this: another profile, or a resource it can't use. */
      "scope",
      "not_found",
      "rate_limit",
      /** The platform refused it (a dead token, a rule it broke). */
      "platform",
      "invalid",
      /** In flight already, or a duplicate. */
      "conflict",
      /** No answer, or the service failed. The outcome of a write is unknown. */
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

export type SocialKey = Redacted.Redacted<string>;

export type ProviderAccount = {
  readonly accountId: string;
  readonly profileId: string;
  readonly platform: KinSocialPlatform;
  readonly name: string;
  readonly handle: string | null;
  readonly problem: string | null;
};

/** What a key reaches: Kin connects a key only when it reaches exactly one profile. */
export type KeyReach = {
  readonly profiles: ReadonlyArray<{ readonly profileId: string; readonly name: string }>;
  /** The service says this key is limited to its profiles, not the whole workspace. */
  readonly limitedToProfiles: boolean;
};

export type PostStats = {
  readonly accountId: string | null;
  readonly platform: string;
  readonly caption: string | null;
  readonly publishedAt: string | null;
  readonly url: string | null;
  readonly mediaType: string | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly shares: number | null;
  readonly saves: number | null;
  readonly reach: number | null;
  readonly views: number | null;
};

export type BestTime = {
  /** 0 Monday to 6 Sunday, in UTC as the service gives it. */
  readonly dayOfWeek: number;
  readonly hourUtc: number;
  readonly avgEngagement: number;
  readonly posts: number;
};

export type PublicAccount = {
  readonly username: string;
  readonly name: string | null;
  readonly followers: number | null;
  readonly posts: number | null;
  readonly recent: ReadonlyArray<{
    readonly caption: string | null;
    readonly at: string | null;
    readonly likes: number | null;
    readonly comments: number | null;
    readonly kind: string | null;
    readonly url: string | null;
  }>;
};

export type ServicePostState =
  | "scheduled"
  | "publishing"
  | "posted"
  | "failed"
  | "cancelled"
  | "gone";
export type ServicePost = {
  readonly state: ServicePostState;
  readonly url: string | null;
  readonly reason: string | null;
};

export type ScheduleRequest = {
  readonly profileId: string;
  readonly accountId: string;
  readonly platform: KinSocialPlatform;
  readonly caption: string;
  readonly media: { readonly url: string; readonly mimeType: string } | null;
  /** UTC, with its offset. */
  readonly at: string;
  /** The same for every attempt at one confirmed post, so a retry never makes a second one. */
  readonly idempotencyKey: string;
};

type Call<A> = Effect.Effect<A, SocialProviderError, HttpClient.HttpClient>;

/**
 * One posting service. Kin's groups, drafts, cards and checks never depend on which; another
 * service is one more of these.
 */
export interface SocialProvider {
  readonly service: string;
  readonly label: string;
  /** Where the owner makes a key, and the one line on how. */
  readonly keyUrl: string;
  readonly setup: string;
  /** What one read costs on a platform, when the service charges for it; null when free. */
  readonly readCost: (platform: string) => string | null;
  readonly reach: (key: SocialKey) => Call<KeyReach>;
  readonly accounts: (key: SocialKey, profileId: string) => Call<ReadonlyArray<ProviderAccount>>;
  readonly connectLink: (
    key: SocialKey,
    input: {
      readonly profileId: string;
      readonly platform: KinSocialPlatform;
      readonly accountId?: string | undefined;
    },
  ) => Call<{ readonly url: string; readonly expiresAt: string | null }>;
  readonly posts: (
    key: SocialKey,
    input: { readonly profileId: string; readonly fromDate: string; readonly accountId?: string },
  ) => Call<ReadonlyArray<PostStats>>;
  readonly bestTimes: (key: SocialKey, profileId: string) => Call<ReadonlyArray<BestTime>>;
  /** A public business account, read through one of the group's own accounts. */
  readonly lookup: (
    key: SocialKey,
    input: { readonly viaAccountId: string; readonly username: string },
  ) => Call<PublicAccount>;
  /** Puts a file where the service can fetch it; the host itself needs no public address. */
  readonly upload: (
    key: SocialKey,
    file: { readonly name: string; readonly mimeType: string; readonly bytes: Uint8Array },
  ) => Call<{ readonly url: string }>;
  readonly schedule: (key: SocialKey, request: ScheduleRequest) => Call<{ readonly id: string }>;
  readonly status: (key: SocialKey, id: string) => Call<ServicePost>;
  readonly cancel: (key: SocialKey, id: string) => Call<void>;
  readonly retry: (key: SocialKey, id: string) => Call<ServicePost>;
}
