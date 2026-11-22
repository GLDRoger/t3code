import {
  KIN_HOST_TROUBLE_CARD,
  KIN_HOST_USAGE_PARTS,
  KIN_TROUBLE_ACTION_LABELS,
  KinHostTroubleCard,
  formatKinWhen,
  kinBytesText,
  kinTroubleClosedLine,
  kinTroubleWords,
  type KinAgentId,
  type KinHostBackUpResult,
  type KinHostFreeSpaceResult,
  type KinHostRetryResult,
  type KinHostStatus,
  type KinTroubleAction,
  type KinTroubleCause,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinFailure } from "./kinAnswers.ts";
import { kinSentences } from "./kinScreenState.ts";

/** Settings › Kin's computer, and the trouble card in the owner's chat: one set of words. */
export const KIN_HOST_COPY = {
  title: "Kin's computer",
  purpose: "How Kin's computer is doing, and what you can fix from here.",
  space: "Space",
  backups: "Backups",
  agents: "Agents",
  about: "About",
  freeSpace: KIN_TROUBLE_ACTION_LABELS.free_space,
  freeing: "Clearing…",
  backUp: KIN_TROUBLE_ACTION_LABELS.back_up,
  backingUp: "Starting…",
  retry: KIN_TROUBLE_ACTION_LABELS.retry,
  retrying: "Trying…",
  copyDetails: KIN_TROUBLE_ACTION_LABELS.copy_details,
  copied: "Copied",
  details: "Technical details",
  unreadable: "Couldn't load how Kin's computer is doing.",
  onlyOwner: {
    title: "Not available",
    detail: "Kin's computer is looked after by whoever runs this Kin.",
  },
  measuring: "Kin is still measuring what uses the space.",
  noSpaceReading: "Kin couldn't read how much space is left.",
  low: "Low",
  out: "Full",
  failing: "Failing",
  notSetUp:
    "Nightly backups aren't set up on this computer. Whoever set up Kin's computer can turn them on.",
  noBackupYet: "No good backup yet",
  lastFailed: "Last try failed",
  version: "Version",
  restarted: "Last restarted",
  nothingFailing: "Nothing is failing.",
  fixed: "Fixed",
} as const;

/** A short name for each cause: a card's eyebrow and a failing row's title. */
const KIN_TROUBLE_TITLES: Readonly<Record<KinTroubleCause, string>> = {
  space: "Out of space",
  signin: "AI account signed out",
  access: "Model not allowed",
  model: "Model not offered",
  program: "AI program won't start",
  usage_limit: "Usage limit reached",
  daily_limit: "Daily limit reached",
  unreachable: "AI provider unreachable",
  connection: "Connection needs signing in",
  restart: "Kin restarted",
  backup: "No recent backup",
  unknown: "Something went wrong",
};

/**
 * A time on this device's clock: today's as a time alone, another day's with its date. `now` is
 * passed so a list draws every row against one instant.
 */
export const kinHostWhen =
  (now: number) =>
  (iso: string): string => {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return iso;
    return formatKinWhen(
      at,
      formatKinWhen(at, "date") === formatKinWhen(now, "date") ? "time" : "dateTime",
    );
  };

export interface KinTroubleActionView {
  readonly action: KinTroubleAction;
  readonly label: string;
}

export interface KinHostTroubleCardView {
  readonly cause: KinTroubleCause;
  readonly title: string;
  /** What is wrong, with the agents it stopped now: a system message's card stands for its text. */
  readonly what: string;
  /** What Kin is doing about it while open; when it is fixed and how many held turns ran after. */
  readonly line: string | null;
  /** The error's own short line, folded away, for whoever helps. */
  readonly detail: string | null;
  readonly actions: ReadonlyArray<KinTroubleActionView>;
  /** The first agent it stopped, for Open agent. */
  readonly agentId: KinAgentId | null;
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

const decodeTrouble = Schema.decodeUnknownOption(KinHostTroubleCard);

const actionsOf = (
  actions: ReadonlyArray<KinTroubleAction>,
  detail: string | undefined,
): ReadonlyArray<KinTroubleActionView> =>
  actions
    .filter((action) => action !== "copy_details" || detail !== undefined)
    .map((action) => ({ action, label: KIN_TROUBLE_ACTION_LABELS[action] }));

/** The trouble card's live part; the message above it says what is wrong. */
export function kinHostTroubleCardView(
  widget: Pick<KinWidget, "type" | "state">,
  at: (iso: string) => string,
): KinHostTroubleCardView | null {
  if (widget.type !== KIN_HOST_TROUBLE_CARD) return null;
  const decoded = decodeTrouble(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const words = kinTroubleWords(card, at);
  const title = KIN_TROUBLE_TITLES[card.cause];
  const closed = card.closed !== null;
  const line = card.closed === null ? words.doing : kinTroubleClosedLine(card.closed, at);
  return {
    cause: card.cause,
    title: closed ? `${title} · ${KIN_HOST_COPY.fixed}` : title,
    what: words.what,
    line,
    detail: closed ? null : (card.detail ?? null),
    actions: closed ? [] : actionsOf(words.actions, card.detail),
    agentId: card.agents[0]?.agentId ?? null,
    closed,
    accessibilityLabel: kinSentences([title, words.what, line]),
  };
}

export interface KinHostSpaceView {
  /** "42 GB free of 250 GB". */
  readonly line: string;
  readonly level: "ok" | "low" | "out";
  /** How full, 0 to 1, for the one bar. */
  readonly used: number;
  readonly parts: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Why there are no parts, when there are none on a host. */
  readonly partsNote: string | null;
}

export interface KinHostFailingView {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly cause: KinTroubleCause;
}

export interface KinHostPageView {
  /** Null when the server couldn't read its disk. */
  readonly space: KinHostSpaceView | null;
  /** Free up space now: only where Kin has a clean to run (a Kin host). */
  readonly canFreeSpace: boolean;
  /** Null on a computer with no nightly backup at all (not a Kin host): the section hides. */
  readonly backup: {
    readonly title: string;
    readonly detail: string | null;
    readonly problem: string | null;
    readonly canBackUp: boolean;
  } | null;
  readonly running: string;
  readonly failing: ReadonlyArray<KinHostFailingView>;
  /** Try again: whenever something waits on a cause. */
  readonly canRetry: boolean;
  readonly version: string;
  readonly restarted: string;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const agentNames = (agents: ReadonlyArray<{ readonly name: string }>) => {
  const list = [...new Set(agents.map((agent) => agent.name))];
  return list.length <= 2 ? list.join(" and ") : `${list[0]} and ${list.length - 1} others`;
};

/** Settings › Kin's computer, from the host's status. */
export function kinHostPageView(status: KinHostStatus, now: number): KinHostPageView {
  const at = kinHostWhen(now);
  const { space, backup, agents } = status;
  const usage = space?.usage ?? null;
  const parts =
    usage === null
      ? []
      : KIN_HOST_USAGE_PARTS.flatMap((part) => {
          const bytes = usage[part.key];
          return bytes === null ? [] : [{ name: part.name, value: kinBytesText(bytes) }];
        });
  const failing = agents.troubles
    .filter((trouble) => trouble.card.cause !== "backup")
    .map((trouble) => {
      const { card } = trouble;
      const who = agentNames(card.agents);
      const held = card.count === 0 ? null : plural(card.count, "turn waiting", "turns waiting");
      return {
        key: trouble.widgetId,
        cause: card.cause,
        title: KIN_TROUBLE_TITLES[card.cause],
        detail: [who === "" ? null : who, held].filter((part) => part !== null).join(" · "),
      };
    });
  return {
    space:
      space === null
        ? null
        : {
            line: `${kinBytesText(space.freeBytes)} free of ${kinBytesText(space.totalBytes)}`,
            level: space.level,
            used:
              space.totalBytes === 0
                ? 0
                : Math.min(1, Math.max(0, 1 - space.freeBytes / space.totalBytes)),
            parts,
            partsNote: status.host && parts.length === 0 ? KIN_HOST_COPY.measuring : null,
          },
    canFreeSpace: status.host,
    backup:
      backup === null
        ? null
        : !backup.configured
          ? { title: KIN_HOST_COPY.notSetUp, detail: null, problem: null, canBackUp: false }
          : {
              title:
                backup.lastGoodAt === null
                  ? KIN_HOST_COPY.noBackupYet
                  : `Last good backup ${at(backup.lastGoodAt)}`,
              detail: backup.failed,
              problem: backup.failed === null ? null : KIN_HOST_COPY.lastFailed,
              canBackUp: true,
            },
    running:
      agents.running === 0
        ? "No turns running right now"
        : `${plural(agents.running, "turn", "turns")} running now`,
    failing,
    canRetry: failing.length > 0 || agents.held > 0,
    version: status.version,
    restarted: at(status.startedAt),
  };
}

/** Why a tap on Kin's computer didn't go through, in the words every Kin screen uses. */
export const kinHostFailed = (cause: unknown) => kinFailure(cause, "Kin couldn't do that.").text;

/** What Free up space now did, in one line. */
export const kinFreeSpaceLine = (result: KinHostFreeSpaceResult) =>
  !result.ran || result.removed === 0
    ? "Nothing old to clear"
    : result.freedBytes < 1024 ** 2
      ? "Cleared old temporary files"
      : `Gave back ${kinBytesText(result.freedBytes)}`;

/** What Back up now did, in one line. */
export const kinBackUpLine = (result: KinHostBackUpResult) =>
  result.started
    ? "Backup started. It takes a few minutes."
    : result.reason === "not_set_up"
      ? "Backups aren't set up on this computer yet."
      : result.reason === "unit_missing"
        ? "This computer has no backup service. Whoever set up Kin's computer can add it."
        : "The backup couldn't start. Try again in a minute.";

/** What Try again did, in one line. */
export const kinRetryLine = (result: KinHostRetryResult) =>
  result.requeued === 0
    ? "Nothing was waiting"
    : `Trying ${plural(result.requeued, "held turn", "held turns")} again`;
