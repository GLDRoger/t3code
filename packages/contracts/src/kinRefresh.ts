import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthKinChatScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
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
  "connections",
  "workChoices",
  "moneyBudgets",
  "moneyStatements",
  "pulse",
  "budget",
  "workLists",
  "recommendations",
  "imports",
  "stop",
  "watches",
  "shell",
  "numbers",
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
  connections: Schema.optional(NonNegativeInt),
  workChoices: Schema.optional(NonNegativeInt),
  moneyBudgets: Schema.optional(NonNegativeInt),
  moneyStatements: Schema.optional(NonNegativeInt),
  pulse: Schema.optional(NonNegativeInt),
  budget: Schema.optional(NonNegativeInt),
  /** A list's definition: made, renamed, archived, its fields or numbering. Absent from older hosts. */
  workLists: Schema.optional(NonNegativeInt),
  /** What Kin suggested to the owner and what came of each. Absent from older hosts. */
  recommendations: Schema.optional(NonNegativeInt),
  /** Imports and undos of a file going on and done (`kin.import.runs`). Absent from older hosts. */
  imports: Schema.optional(NonNegativeInt),
  /** The company stop switch (`kin.org.get`), for every member. Absent from older hosts. */
  stop: Schema.optional(NonNegativeInt),
  /** What Kin keeps watch on and its looks (`kin.watches.*`). Absent from older hosts. */
  watches: Schema.optional(NonNegativeInt),
  shell: Schema.optional(NonNegativeInt),
  numbers: Schema.optional(NonNegativeInt),
  /**
   * The host run these revisions count in. Unchanged across a reconnect, an unchanged revision
   * means nothing moved; a new one means anything may have. Absent from older hosts.
   */
  boot: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  /**
   * Live reads this host streams (`KIN_STREAMS`): a client follows those instead of reading again
   * on each move. Names it doesn't know are skipped. Absent from older hosts.
   */
  streams: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(40))).check(Schema.isMaxLength(20)),
  ),
});
export type KinRefreshes = typeof KinRefreshes.Type;

/** `pulse`: `kin.pulse.subscribe`; `money`: `kin.money.subscribe`; `open`: `kin.open.subscribe`. */
export const KIN_STREAMS = ["pulse", "money", "open"] as const;

export const KinRefreshesSubscribeInput = Schema.Struct({ orgId: KinOrgId });
export type KinRefreshesSubscribeInput = typeof KinRefreshesSubscribeInput.Type;

/** What a write made outside the server, such as the `kin` CLI's, changed: its clients read again. */
export const KinRefreshesAnnounceInput = Schema.Struct({
  orgId: KinOrgId,
  topics: Schema.Array(KinRefreshTopic).check(Schema.isMaxLength(KIN_REFRESH_TOPICS.length)),
  records: Schema.Boolean,
});
export type KinRefreshesAnnounceInput = typeof KinRefreshesAnnounceInput.Type;

/** The revisions now, then again after each settled burst of changes. */
export const KinRefreshRpcs = [
  Rpc.make("kin.refreshes.subscribe", {
    payload: KinRefreshesSubscribeInput,
    success: KinRefreshes,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make("kin.refreshes.announce", {
    payload: KinRefreshesAnnounceInput,
    success: Schema.Struct({}),
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

// Any member: the server leaves out the topics the viewer can't read.
export const KIN_REFRESH_RPC_SCOPES = {
  "kin.refreshes.subscribe": AuthKinChatScope,
  // The owner's own writes from the host CLI; the server checks the caller is the owner.
  "kin.refreshes.announce": AuthOrchestrationOperateScope,
} as const;
