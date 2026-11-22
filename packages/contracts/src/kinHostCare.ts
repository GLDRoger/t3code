import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, KinText, KinTrimmedText, NonNegativeInt } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId, KinWidgetId } from "./kinChat.ts";

/**
 * Why an agent's turn could not run, read by the server from the error itself, never from a
 * model's words. `signin`, `access`, `model` and `program` are `setupFailure`'s; `backup` is no
 * recent good backup.
 */
export const KinTroubleCause = Schema.Literals([
  "space",
  "signin",
  "access",
  "model",
  "program",
  "usage_limit",
  "daily_limit",
  "unreachable",
  "connection",
  "restart",
  "backup",
  "unknown",
]);
export type KinTroubleCause = typeof KinTroubleCause.Type;

/** What a person can do about it from the app; each is a fixed operation or a place to open. */
export const KinTroubleAction = Schema.Literals([
  "free_space",
  "retry",
  "sign_in",
  "open_agent",
  "open_daily_limit",
  "open_connection",
  "back_up",
  "copy_details",
]);
export type KinTroubleAction = typeof KinTroubleAction.Type;

/** Kin's own widget type for an open trouble: one card per cause, in the owner's chat. */
export const KIN_HOST_TROUBLE_CARD = "host_trouble";

/** The agents a trouble stopped, by name when it opened. */
const KinTroubleAgent = Schema.Struct({
  agentId: KinAgentId,
  name: KinTrimmedText.check(Schema.isMaxLength(200)),
  /** The AI account it runs on, for Sign in again to open that account's own settings. */
  instanceId: Schema.optionalKey(KinTrimmedText.check(Schema.isMaxLength(200))),
});

/**
 * One cause's open notice. `count` is how many turns it holds; `closed` is set once the cause
 * cleared, with how many held turns then ran. `using` is what fills the disk, measured cheaply,
 * on a space card when clearing old files was not enough. `detail` is the error's short line.
 */
export const KinHostTroubleCard = Schema.Struct({
  cause: KinTroubleCause,
  agents: Schema.Array(KinTroubleAgent).check(Schema.isMaxLength(50)),
  count: NonNegativeInt,
  openedAt: IsoDateTime,
  resetAt: Schema.optionalKey(IsoDateTime),
  using: Schema.optionalKey(KinText.check(Schema.isMaxLength(400))),
  connection: Schema.optionalKey(
    Schema.Struct({
      connectionId: KinTrimmedText.check(Schema.isMaxLength(200)),
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
    }),
  ),
  /** Backups only: whether this computer has a nightly backup set up, so Back up now can run. */
  backupConfigured: Schema.optionalKey(Schema.Boolean),
  /** Backups only: when the last good one ran; absent when none ever did. */
  lastGoodAt: Schema.optionalKey(IsoDateTime),
  detail: Schema.optionalKey(KinText.check(Schema.isMaxLength(600))),
  /** Of the held turns, those with a time (a reminder, a scheduled run) that pass it unrun. */
  expiring: Schema.optionalKey(NonNegativeInt),
  /** Turns Kin stopped retrying by itself: only Try again runs them now. */
  stopped: Schema.optionalKey(NonNegativeInt),
  /** The held turns' events, so Try again and the cause clearing run exactly those. */
  held: Schema.optionalKey(
    Schema.Array(KinTrimmedText.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(500)),
  ),
  closed: Schema.NullOr(Schema.Struct({ at: IsoDateTime, ran: NonNegativeInt })),
});
export type KinHostTroubleCard = typeof KinHostTroubleCard.Type;

const names = (agents: ReadonlyArray<{ readonly name: string }>) => {
  const list = [...new Set(agents.map((agent) => agent.name))];
  if (list.length === 0) return "your agents";
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]} and ${list.length - 1} other agents`;
};
const turns = (count: number) => (count === 1 ? "the held turn" : `the ${count} held turns`);
const them = (count: number) => (count === 1 ? "it" : "them");

/** The table's short form, for the line in the chat where the turn was asked: "<agent> couldn't start: …". */
export const KIN_TROUBLE_WHY: Readonly<Record<KinTroubleCause, string>> = {
  space: "Kin's computer ran out of space",
  signin: "its AI account is signed out",
  access: "its AI account can't use the model it's set to use",
  model: "its AI account doesn't offer the model it's set to use",
  program: "Kin couldn't run its AI program",
  usage_limit: "its AI account reached its usage limit",
  daily_limit: "today's Daily limit is used up",
  unreachable: "Kin couldn't reach the AI provider",
  connection: "a connection it needed needs signing in again",
  restart: "Kin restarted",
  backup: "Kin's computer has no recent backup",
  unknown: "something went wrong that Kin doesn't recognise",
};

/**
 * The one table: for each cause, what a person reads, what Kin is doing about it, and what they
 * can do from the app. Server notices, pushes, the agents' read tool and every client use it.
 * `at` formats a time on the reader's clock; the server passes its own.
 */
export function kinTroubleWords(
  card: TroubleFacts & Pick<KinHostTroubleCard, "expiring" | "stopped">,
  at: (iso: string) => string,
): TroubleWords {
  const words = wordsByCause(card, at);
  const expiring = card.expiring ?? 0;
  const stopped = card.stopped ?? 0;
  const more = [
    expiring === 0
      ? null
      : expiring === card.count
        ? `${card.count === 1 ? "It has a set time" : "They have set times"} and won't run if this lasts past ${card.count === 1 ? "it" : "them"}.`
        : `${expiring === 1 ? "One of them has a set time" : `${expiring} of them have set times`} and won't run if this lasts past ${expiring === 1 ? "it" : "them"}.`,
    stopped === 0
      ? null
      : `Kin stopped retrying ${stopped === 1 ? "one turn" : `${stopped} turns`} by itself after too many tries. Try again runs ${them(stopped)}.`,
  ].filter((line) => line !== null);
  if (more.length === 0) return words;
  return {
    what: words.what,
    doing: [words.doing, ...more].filter((line) => line !== null).join(" "),
    actions:
      stopped > 0 && !words.actions.includes("retry") ? [...words.actions, "retry"] : words.actions,
  };
}

type TroubleFacts = Pick<
  KinHostTroubleCard,
  "cause" | "count" | "resetAt" | "using" | "connection" | "backupConfigured" | "lastGoodAt"
> & { readonly agents: ReadonlyArray<{ readonly name: string }> };
interface TroubleWords {
  readonly what: string;
  readonly doing: string | null;
  readonly actions: ReadonlyArray<KinTroubleAction>;
}

function wordsByCause(card: TroubleFacts, at: (iso: string) => string): TroubleWords {
  const who = names(card.agents);
  switch (card.cause) {
    case "space":
      return {
        what:
          card.using === undefined
            ? `Kin's computer ran out of space, so ${who} couldn't work. Kin cleared out old temporary files, but that wasn't enough.`
            : `Kin's computer ran out of space, so ${who} couldn't work. Kin cleared out old temporary files, but that wasn't enough. ${card.using}`,
        doing: `Kin keeps ${turns(card.count)} and runs ${them(card.count)} as soon as there is space.`,
        actions: ["free_space", "retry"],
      };
    case "signin":
      return {
        what: `The AI account behind ${who} is signed out, so ${card.agents.length > 1 ? "they" : "it"} couldn't work.`,
        doing: `Kin keeps ${turns(card.count)} and runs ${them(card.count)} once the account is signed in again. If Kin's settings can't sign it in, whoever set up Kin's computer can.`,
        actions: ["sign_in", "retry"],
      };
    case "access":
      return {
        what: `The AI account behind ${who} can't use the model it's set to use.`,
        doing: `Kin keeps ${turns(card.count)} until the account or the model changes.`,
        actions: ["open_agent", "retry"],
      };
    case "model":
      return {
        what: `The AI account behind ${who} doesn't offer the model it's set to use.`,
        doing: `Kin keeps ${turns(card.count)} until another model is chosen.`,
        actions: ["open_agent", "retry"],
      };
    case "program":
      return {
        what: `Kin couldn't run the AI program behind ${who}.`,
        doing: `Kin keeps ${turns(card.count)} and runs ${them(card.count)} when the program starts again. Whoever set up Kin's computer can check why it won't start.`,
        actions: ["retry", "copy_details"],
      };
    case "usage_limit":
      return {
        what:
          card.resetAt === undefined
            ? `The AI account behind ${who} reached its usage limit.`
            : `The AI account behind ${who} reached its usage limit. It resets at ${at(card.resetAt)}.`,
        doing: `Kin keeps ${turns(card.count)} and runs ${them(card.count)} when the limit resets.`,
        actions: ["retry"],
      };
    case "daily_limit":
      return {
        what: "Today's Daily limit for your agents is used up.",
        doing: "Their other work waits until midnight in the company's time zone.",
        actions: ["open_daily_limit"],
      };
    case "unreachable":
      return {
        what: `Kin couldn't reach the AI provider, so ${who} couldn't work.`,
        doing: "Kin keeps trying by itself.",
        actions: ["retry"],
      };
    case "connection":
      return {
        what: `${card.connection?.name ?? "A connection"} needs signing in again, and ${who} needed it.`,
        doing: null,
        actions: ["open_connection"],
      };
    case "restart":
      return {
        what: `Kin restarted while ${who} was working.`,
        doing: "Kin picks it up again by itself.",
        actions: [],
      };
    case "backup":
      return {
        what:
          card.lastGoodAt === undefined
            ? "Kin's computer has no good backup yet, so a failed disk could lose the company's data."
            : `Kin's last good backup was at ${at(card.lastGoodAt)}, so a failed disk could lose what changed since.`,
        doing:
          card.backupConfigured === true
            ? "Kin closes this by itself once a backup runs."
            : "Nightly backups aren't set up on this computer yet. Whoever set up Kin's computer can turn them on.",
        actions: card.backupConfigured === true ? ["back_up"] : [],
      };
    case "unknown":
      return {
        what: "Something went wrong that Kin doesn't recognise.",
        doing: `Kin keeps ${turns(card.count)} and tries again by itself.`,
        actions: ["retry", "copy_details"],
      };
  }
}

/** The line a closed card ends on; `at` formats the time on the reader's clock. */
export const kinTroubleClosedLine = (
  closed: NonNullable<KinHostTroubleCard["closed"]>,
  at: (iso: string) => string,
) =>
  closed.ran === 0
    ? `Fixed at ${at(closed.at)}.`
    : `Fixed at ${at(closed.at)}. ${closed.ran === 1 ? "The held turn ran" : `${closed.ran} held turns ran`}.`;

export const KIN_TROUBLE_ACTION_LABELS: Readonly<Record<KinTroubleAction, string>> = {
  free_space: "Free up space now",
  retry: "Try again",
  sign_in: "Sign in again",
  open_agent: "Open agent",
  open_daily_limit: "Open Daily limit",
  open_connection: "Open connection",
  back_up: "Back up now",
  copy_details: "Copy details",
};

export const KinHostInput = Schema.Struct({ orgId: KinOrgId });
export type KinHostInput = typeof KinHostInput.Type;

/** One trouble open now, as Settings › Kin's computer lists it. */
export const KinHostTrouble = Schema.Struct({
  widgetId: KinWidgetId,
  card: KinHostTroubleCard,
});
export type KinHostTrouble = typeof KinHostTrouble.Type;

/**
 * What a measure of the disk found, in bytes; null where it couldn't be measured. Measured in the
 * background and cached, never on a request.
 */
export const KinHostUsage = Schema.Struct({
  temporary: Schema.NullOr(NonNegativeInt),
  builds: Schema.NullOr(NonNegativeInt),
  backups: Schema.NullOr(NonNegativeInt),
  data: Schema.NullOr(NonNegativeInt),
  measuredAt: IsoDateTime,
});
export type KinHostUsage = typeof KinHostUsage.Type;

/**
 * Settings › Kin's computer. `host` is false on a dev or desktop server (no `KIN_CHECKOUT`): it has
 * no nightly backup and no hourly clean, so those parts are absent.
 */
export const KinHostStatus = Schema.Struct({
  host: Schema.Boolean,
  space: Schema.NullOr(
    Schema.Struct({
      freeBytes: NonNegativeInt,
      totalBytes: NonNegativeInt,
      level: Schema.Literals(["ok", "low", "out"]),
      usage: Schema.NullOr(KinHostUsage),
    }),
  ),
  backup: Schema.NullOr(
    Schema.Struct({
      configured: Schema.Boolean,
      lastGoodAt: Schema.NullOr(IsoDateTime),
      lastTriedAt: Schema.NullOr(IsoDateTime),
      failed: Schema.NullOr(KinText),
    }),
  ),
  agents: Schema.Struct({
    running: NonNegativeInt,
    held: NonNegativeInt,
    troubles: Schema.Array(KinHostTrouble),
  }),
  version: KinTrimmedText,
  startedAt: IsoDateTime,
});
export type KinHostStatus = typeof KinHostStatus.Type;

export const KinHostFreeSpaceResult = Schema.Struct({
  /** False on a server with no clean to run (not a Kin host). */
  ran: Schema.Boolean,
  removed: NonNegativeInt,
  freedBytes: NonNegativeInt,
  failed: NonNegativeInt,
  /** Old versions of Kin and old update backups of its database that went too. */
  builds: Schema.optionalKey(NonNegativeInt),
  backups: Schema.optionalKey(NonNegativeInt),
});
export type KinHostFreeSpaceResult = typeof KinHostFreeSpaceResult.Type;

export const KinHostBackUpResult = Schema.Struct({
  started: Schema.Boolean,
  /** Why it couldn't start: no backup set up, no backup service, or the service refused. */
  reason: Schema.optionalKey(Schema.Literals(["not_set_up", "unit_missing", "failed"])),
});
export type KinHostBackUpResult = typeof KinHostBackUpResult.Type;

export const KinHostRetryResult = Schema.Struct({ requeued: NonNegativeInt });
export type KinHostRetryResult = typeof KinHostRetryResult.Type;

const KIN_HOST_WS_METHODS = {
  status: "kin.host.status",
  freeSpace: "kin.host.freeSpace",
  backUpNow: "kin.host.backUpNow",
  retry: "kin.host.retry",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinHostRpcs = [
  Rpc.make(KIN_HOST_WS_METHODS.status, { payload: KinHostInput, success: KinHostStatus, error }),
  Rpc.make(KIN_HOST_WS_METHODS.freeSpace, {
    payload: KinHostInput,
    success: KinHostFreeSpaceResult,
    error,
  }),
  Rpc.make(KIN_HOST_WS_METHODS.backUpNow, {
    payload: KinHostInput,
    success: KinHostBackUpResult,
    error,
  }),
  Rpc.make(KIN_HOST_WS_METHODS.retry, {
    payload: KinHostInput,
    success: KinHostRetryResult,
    error,
  }),
] as const;

export const KIN_HOST_RPC_SCOPES = {
  [KIN_HOST_WS_METHODS.status]: AuthKinChatScope,
  [KIN_HOST_WS_METHODS.freeSpace]: AuthKinChatScope,
  [KIN_HOST_WS_METHODS.backUpNow]: AuthKinChatScope,
  [KIN_HOST_WS_METHODS.retry]: AuthKinChatScope,
} as const;

const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** Bytes in a person's words: "1.2 GB", "14 GB", "340 MB". */
export const kinBytesText = (bytes: number) =>
  bytes >= GB
    ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;

/** What uses the space, in the order Settings lists it. */
export const KIN_HOST_USAGE_PARTS = [
  { key: "data", name: "Kin's data" },
  { key: "builds", name: "Old builds" },
  { key: "backups", name: "Backups" },
  { key: "temporary", name: "Temporary files" },
] as const satisfies ReadonlyArray<{
  readonly key: Exclude<keyof KinHostUsage, "measuredAt">;
  readonly name: string;
}>;
