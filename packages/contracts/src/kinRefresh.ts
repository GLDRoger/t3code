import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";

/**
 * What a Kin read is about, for refreshing it. Records and docs have their own change numbers on
 * `kin.work.subscribe` and `kin.docs.subscribe`; these cover the reads those don't.
 */
export const KIN_REFRESH_TOPICS = [
  "company",
  "recipes",
  "memory",
  "people",
  "leads",
  "timeZone",
  "visualHosts",
] as const;
export const KinRefreshTopic = Schema.Literals(KIN_REFRESH_TOPICS);
export type KinRefreshTopic = typeof KinRefreshTopic.Type;

/**
 * Each topic's revision: it moves after a committed change, and only for topics the viewer may
 * read. A read made under one revision is behind once it moves. No data rides on it.
 */
export const KinRefreshes = Schema.Struct({
  company: Schema.optional(NonNegativeInt),
  recipes: Schema.optional(NonNegativeInt),
  memory: Schema.optional(NonNegativeInt),
  people: Schema.optional(NonNegativeInt),
  leads: Schema.optional(NonNegativeInt),
  timeZone: Schema.optional(NonNegativeInt),
  visualHosts: Schema.optional(NonNegativeInt),
});
export type KinRefreshes = typeof KinRefreshes.Type;

export const KinRefreshesSubscribeInput = Schema.Struct({ orgId: KinOrgId });
export type KinRefreshesSubscribeInput = typeof KinRefreshesSubscribeInput.Type;

/** The revisions now, then again after each settled burst of changes. */
export const KinRefreshRpcs = [
  Rpc.make("kin.refreshes.subscribe", {
    payload: KinRefreshesSubscribeInput,
    success: KinRefreshes,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
    stream: true,
  }),
] as const;

// Any member: the server leaves out the topics the viewer can't read.
export const KIN_REFRESH_RPC_SCOPES = {
  "kin.refreshes.subscribe": AuthKinChatScope,
} as const;
