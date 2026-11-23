// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KIN_DOC_CARD,
  KIN_HOST_TROUBLE_CARD,
  KIN_MEMORY_CHANGES_CARD,
  KIN_SOCIAL_PACK_CARD,
  KIN_SOCIAL_WEEK_CARD,
  KIN_STATEMENT_PASSWORD_CARD,
  KIN_STATEMENT_REVIEW_CARD,
  KinReminderCard,
  KinRoutineCard,
  KinScheduledTaskCard,
  KinTaskCardState,
  KinVisualCardState,
  type EnvironmentId,
  type KinMessage,
  type KinOrgId,
  type KinRoutineSection,
  type KinWidget,
  kinWhenFormat,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinHeldLine } from "./kinAgentRetire.ts";
import { kinApprovalWidgetView, type KinApprovalWidgetView } from "./kinApprovalPresentation.ts";
import { kinChartCardView, type KinChartView } from "./kinChart.ts";
import { kinDocCardView, type KinDocCardView } from "./kinDocs.ts";
import { kinHostTroubleCardView } from "./kinHostCare.ts";
import { kinLinkLabel, kinSafeWebUrl } from "./kinLinks.ts";
import { kinSentences } from "./kinScreenState.ts";
import { kinZoneLabel } from "./kinTimeZone.ts";
import {
  kinSocialPackView,
  kinSocialWeekView,
  type KinSocialPackView,
  type KinSocialWeekView,
} from "./kinSocial.ts";
import { kinChoiceCardView, type KinChoiceCardView } from "./kinChoicePresentation.ts";
import {
  formatKinDeferralTime,
  KIN_DEFERRAL_ACTIONS,
  kinAskedByLine,
  kinDeferralCardView,
  kinDeferralIsBookkeeping,
  type KinDeferralCardView,
} from "./kinDeferralPresentation.ts";
import {
  kinStatementPasswordView,
  kinStatementReviewView,
  type KinStatementPasswordView,
  type KinStatementReviewView,
} from "./kinStatementPresentation.ts";
import {
  kinMemoryChangesView,
  type KinMemoryChangesCardView,
} from "./kinMemoryChangesPresentation.ts";

export const KIN_MISSING_CARD_TEXT = "This card hasn't loaded yet.";

type TaskStatus = KinTaskCardState["status"];

export type KinTaskTone = "active" | "attention" | "done" | "muted";

export interface KinTaskCardView {
  readonly title: string;
  readonly status: TaskStatus;
  readonly statusLabel: string;
  readonly tone: KinTaskTone;
  /** True only while the task runs; drives the static working bar. */
  readonly working: boolean;
  readonly detail: string | null;
  /** The provider's own words under a failure Kin can't name, smaller than `detail`. */
  readonly detailNote: string | null;
  readonly model: string | null;
  /** Null when there is no thread, or this phone doesn't know its environment. */
  readonly open: { readonly environmentId: string; readonly threadId: string } | null;
  readonly unknownEnvironment: boolean;
  readonly pullRequests: ReadonlyArray<{ readonly url: string; readonly label: string }>;
  readonly accessibilityLabel: string;
}

export type KinCardView =
  | { readonly kind: "task"; readonly task: KinTaskCardView }
  | { readonly kind: "deferral"; readonly deferral: KinDeferralCardView }
  | { readonly kind: "choice"; readonly choice: KinChoiceCardView }
  | { readonly kind: "chart"; readonly chart: KinChartView }
  | { readonly kind: "visual"; readonly orgId: KinOrgId; readonly visual: KinVisualCardState }
  | { readonly kind: "digest"; readonly digest: KinDigestCardView }
  | { readonly kind: "memory_changes"; readonly changes: KinMemoryChangesCardView }
  | { readonly kind: "approval"; readonly approval: KinApprovalWidgetView }
  | { readonly kind: "doc"; readonly doc: KinDocCardView }
  | { readonly kind: "statement_review"; readonly review: KinStatementReviewView }
  | { readonly kind: "statement_password"; readonly password: KinStatementPasswordView }
  | { readonly kind: "social_week"; readonly week: KinSocialWeekView }
  | { readonly kind: "social_pack"; readonly pack: KinSocialPackView }
  /** Drawn with the reader's clock (`kinHostTroubleCardView`), so it carries the widget. */
  | { readonly kind: "host_trouble"; readonly widget: KinWidget }
  | { readonly kind: "missing" }
  /** A card this build can't draw: its own plain words, or nothing when it has none. */
  | { readonly kind: "unknown"; readonly text: string | null };

const STATUS: Record<TaskStatus, { readonly label: string; readonly tone: KinTaskTone }> = {
  working: { label: "Working", tone: "active" },
  waiting: { label: "Waiting", tone: "muted" },
  needs_decision: { label: "Needs your decision", tone: "attention" },
  blocked: { label: "Blocked", tone: "attention" },
  done: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "attention" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const decodeTaskState = Schema.decodeUnknownOption(KinTaskCardState);
const decodeRoutine = Schema.decodeUnknownOption(KinRoutineCard);
const decodeVisual = Schema.decodeUnknownOption(KinVisualCardState);
const decodeReminder = Schema.decodeUnknownOption(KinReminderCard);
const decodeScheduledTask = Schema.decodeUnknownOption(KinScheduledTaskCard);

// Agents write widget state, so every string is clamped and shown as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const OPENS_THREAD = "Opens the thread";

/** A failed task's line, by the cause the server told; `stopped` leads anything else. */
const KIN_TASK_FAILURE_COPY = {
  model_not_offered:
    "This server's AI provider doesn't offer the model this task asked for. Ask the agent to start it again on its own model.",
  signed_out:
    "This server's AI provider is signed out. Sign it in again in Settings, then ask the agent to start the task again.",
  unreachable:
    "This server couldn't reach its AI provider. Ask the agent to start the task again in a few minutes.",
  usage_limit:
    "The AI provider's usage limit is reached. Ask the agent to start the task again once it resets.",
  stopped: "The helper stopped with an error.",
} as const;

/** A model id as Settings names it (`kinListedModelName`); null shows no model at all. */
export type KinModelName = (model: string) => string | null;

/** The task card in an app with no coding threads: nothing to open, and nothing said of one. */
export function kinTaskCardWithoutThread(task: KinTaskCardView): KinTaskCardView {
  return {
    ...task,
    open: null,
    unknownEnvironment: false,
    accessibilityLabel: task.accessibilityLabel.replace(` ${OPENS_THREAD}.`, ""),
  };
}

function kinTaskCardView(
  state: KinTaskCardState,
  /** The environment hosting this chat. A local card must name it; only remote cards go elsewhere. */
  hostEnvironmentId: EnvironmentId,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
  modelName: KinModelName,
): KinTaskCardView {
  const { label, tone } = STATUS[state.status];
  const title = clamp(state.title, 200);
  const named = state.model === null ? null : modelName(state.model);
  const model = named === null ? null : clamp(named, 60) || null;
  const raw = state.lastError === null ? null : clamp(state.lastError, 280) || null;
  const cause = state.status === "failed" ? (state.failure ?? null) : null;
  const detail = state.status !== "failed" ? raw : KIN_TASK_FAILURE_COPY[cause ?? "stopped"];
  const detailNote = state.status === "failed" && cause === null ? raw : null;
  const environmentId = state.remoteEnvironmentId ?? state.environmentId;
  const known =
    (state.remoteEnvironmentId !== null || state.environmentId === hostEnvironmentId) &&
    isKnownEnvironment(environmentId);
  const open =
    state.threadId !== null && known ? { environmentId, threadId: state.threadId } : null;
  const pullRequests = state.pullRequests.flatMap((pr) => {
    const url = kinSafeWebUrl(pr.url);
    // Any host other than GitHub is named, so a look-alike link can't pass as a GitHub PR.
    return url === null
      ? []
      : [{ url: url.toString(), label: kinLinkLabel(`PR ${pr.number}`, url) }];
  });
  const parts = [
    `Task: ${title}`,
    label,
    detail,
    detailNote,
    model,
    ...pullRequests.map((pr) => pr.label),
    open === null ? null : OPENS_THREAD,
  ];
  return {
    title,
    status: state.status,
    statusLabel: label,
    tone,
    working: state.status === "working",
    detail,
    detailNote,
    model,
    open,
    unknownEnvironment: state.threadId !== null && !known,
    pullRequests,
    accessibilityLabel: kinSentences(parts),
  };
}

export interface KinDigestRow {
  readonly key: string;
  /** The section this row starts, such as "Overdue"; null while the section continues. */
  readonly heading: string | null;
  readonly text: string;
  readonly note: string | null;
  readonly link: {
    readonly url: string;
    /** The row's text plus the real host, for the card's accessibility action. */
    readonly label: string;
    readonly chipLabel: string;
  } | null;
}

/** A server-drawn list card (morning brief, evening summary), as plain text. */
export interface KinDigestCardView {
  readonly eyebrow: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KinDigestRow>;
  readonly more: string | null;
  readonly accessibilityLabel: string;
}

const ROUTINE_SECTIONS: Record<KinRoutineSection, string> = {
  due_today: "Due today",
  due_this_week: "Due this week",
  overdue: "Overdue",
  waiting: "Waiting",
  review_requested: "Review requested",
  ci_red: "CI failing",
  objective_at_risk: "Objective at risk",
  worker: "Stuck tasks",
  past_review: "Overdue for a check",
  done: "Done",
  slipped: "Slipped",
  promised: "Promised",
  due_tomorrow: "Due tomorrow",
};

// `day` is the owner's local date; built from its parts so no timezone shifts it.
const dayFormat = kinWhenFormat("longDay");
const formatDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return dayFormat.format(new Date(year!, month! - 1, date));
};

function digestView(card: Omit<KinDigestCardView, "accessibilityLabel">): KinDigestCardView {
  const parts = [
    card.eyebrow,
    card.title,
    ...card.rows.flatMap((row) => [row.heading, row.text, row.note]),
    card.more,
  ];
  return { ...card, accessibilityLabel: kinSentences(parts) };
}

// Hosts write some notes with a raw timestamp ("review by 2026-11-09T16:09:12.531Z").
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g;
const readableTimes = (text: string) =>
  text.replace(ISO_TIME, (iso) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : formatKinDeferralTime(ms);
  });

function kinRoutineView(card: KinRoutineCard): KinDigestCardView {
  return digestView({
    eyebrow: card.routine === "morning_brief" ? "Morning brief" : "Evening summary",
    title: formatDay(card.day),
    rows: card.rows.map((row, index) => {
      const text = clamp(row.title, 280);
      const url = row.link === undefined ? null : kinSafeWebUrl(row.link);
      return {
        // Rows are fixed per revision, so their position identifies them.
        key: `${row.section}:${index}`,
        heading:
          index > 0 && card.rows[index - 1]!.section === row.section
            ? null
            : ROUTINE_SECTIONS[row.section],
        text,
        note: row.note === undefined ? null : clamp(readableTimes(row.note), 280) || null,
        link:
          url === null
            ? null
            : {
                url: url.href,
                label: kinLinkLabel(text || "Link", url),
                chipLabel: kinLinkLabel("Open", url),
              },
      };
    }),
    more: null,
  });
}

const actions = KIN_DEFERRAL_ACTIONS;

/** A reminder the lead wrote (or Kin, as a fallback), drawn like a deferral with its own taps. */
export function kinReminderCardView(
  widget: KinWidget,
  timeZone?: string,
  /** False for a teammate: only taps the host takes from them are offered. Unknown offers all. */
  ownerLevel?: boolean,
): KinDeferralCardView | null {
  const decoded = decodeReminder(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const title = clamp(card.title, 200) || "This reminder";
  const open = widget.closedAt === null && card.status !== "done";
  const lines: Array<string> =
    widget.closedAt !== null
      ? ["Closed."]
      : card.status === "done"
        ? ["Done."]
        : card.status === "snoozed" && card.snoozedUntil !== undefined
          ? [`Snoozed until ${formatKinDeferralTime(Date.parse(card.snoozedUntil), timeZone)}.`]
          : [`Due ${formatKinDeferralTime(Date.parse(card.dueAt), timeZone)}.`];
  const asked = kinAskedByLine(card.askedBy);
  if (asked !== null) lines.push(asked);
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.itemId,
    phase: open ? "reminder" : "closed",
    eyebrow: "Reminder",
    title,
    agent: null,
    lines,
    countdown: null,
    actions: open ? reminderActions(card, ownerLevel) : [],
    accessibilityLabel: kinSentences([`Reminder: ${title}`, ...lines]),
  };
}

/**
 * A teammate taps a reminder only in their own chat with an agent (`theirs` is set there), and
 * moves it only when they set it themselves: their turn may replace nothing else.
 */
function reminderActions(card: KinReminderCard, ownerLevel: boolean | undefined) {
  const finish = [actions.done, actions.snooze_10m, actions.snooze_1h, actions.snooze_tomorrow];
  // A shared chat's own: its asker, the owner or a co-owner finishes it; the host says who.
  if (card.askedBy !== undefined) return finish;
  if (ownerLevel !== false || card.theirs === true) return [...finish, actions.change];
  return card.theirs === false ? finish : [];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

// Asia/Kolkata and Asia/Calcutta are one zone; the same offset now and in six months is too.
const sameZone = (a: string, b: string) => {
  if (a === b) return true;
  try {
    const offsets = (zone: string) =>
      [0, 182].map(
        (days) =>
          new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longOffset" })
            .formatToParts(Date.UTC(2026, 0, 1) + days * 86_400_000)
            .find((part) => part.type === "timeZoneName")?.value,
      );
    return offsets(a).join() === offsets(b).join();
  } catch {
    return false;
  }
};

/** "Weekdays at 8:00", read in the owner's zone, which is named when this device is elsewhere. */
function scheduleLine(
  every: KinScheduledTaskCard["every"],
  ownerZone: string,
  timeZone?: string,
  around = false,
) {
  const days = [...new Set(every.days)].sort((a, b) => a - b);
  const key = days.join("");
  const when =
    key === "0123456"
      ? "Every day"
      : key === "12345"
        ? "Weekdays"
        : key === "06"
          ? "Weekends"
          : days.map((day) => WEEKDAYS[day]).join(", ");
  const [hour, minute] = every.at.split(":");
  const deviceZone = timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = sameZone(deviceZone, ownerZone) ? "" : ` (${kinZoneLabel(ownerZone)})`;
  return `${when} ${around ? "around" : "at"} ${Number(hour)}:${minute}${zone}.`;
}

function lastRunLine(run: NonNullable<KinScheduledTaskCard["lastRun"]>, timeZone?: string) {
  const at = formatKinDeferralTime(Date.parse(run.at), timeZone);
  const note = run.note === undefined ? "" : clamp(run.note, 280);
  switch (run.status) {
    case "running":
      // Held by a trouble on Kin's computer: the note is why, as the trouble's own card says it.
      return note === "" ? "Running now." : `Waiting to run: ${note.replace(/\.$/, "")}.`;
    case "posted":
      return note === "" ? `Last run ${at}.` : `Last run ${at}: ${note}`;
    case "failed":
      return `The run at ${at} didn't finish.`;
    case "skipped":
      return note === "" ? `Skipped ${at}.` : `Skipped ${at}: ${note}`;
  }
}

/** A scheduled task's standing card: when it runs, how the last run went, and its controls. */
export function kinScheduledTaskCardView(
  widget: KinWidget,
  timeZone?: string,
): KinDeferralCardView | null {
  const decoded = decodeScheduledTask(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const title = clamp(card.title, 200) || "This scheduled task";
  const open = widget.closedAt === null && card.status !== "deleted";
  // A loose one fires somewhere in a window: its stored next run is only the window's start.
  const nextMs =
    card.nextRunAt === null || card.around === true ? null : Date.parse(card.nextRunAt);
  const lines = !open
    ? ["Deleted."]
    : [
        scheduleLine(card.every, card.timeZone, timeZone, card.around),
        ...(card.status === "paused" ? ["Paused."] : []),
        ...(card.status === "active" && nextMs !== null
          ? [`Next run ${formatKinDeferralTime(nextMs, timeZone)}.`]
          : []),
        ...(card.lastRun === null ? [] : [lastRunLine(card.lastRun, timeZone)]),
        ...((card.overlapSkipped ?? 0) > 1
          ? [`Skipped ${card.overlapSkipped} runs in a row.`]
          : []),
        ...[kinAskedByLine(card.askedBy)].filter((line) => line !== null),
      ];
  const running = card.lastRun?.status === "running";
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.itemId,
    phase: open ? "scheduled" : "closed",
    eyebrow: "Scheduled task",
    title,
    agent: null,
    lines,
    countdown:
      open && card.status === "active" && nextMs !== null ? { to: nextMs, kind: "run" } : null,
    actions: open
      ? [
          ...(running ? [] : [actions.run_now]),
          card.status === "paused" ? actions.resume : actions.pause,
          actions.edit,
          actions.delete,
        ]
      : [],
    accessibilityLabel: kinSentences([`Scheduled task: ${title}`, ...lines]),
  };
}

const BOOKKEEPING_TEXT = /^(?:(?:Remembered|Forgot|Updated|Replaced|Memory): |Deferred to )/;

/**
 * Kin's own notes from older hosts: a memory change, or a reminder it set. Bookkeeping is silent,
 * so no feed draws these rows. Never a failure notice, nor a card the owner acts on or reads.
 */
export function kinIsBookkeeping(
  message: Pick<KinMessage, "author" | "status" | "widgetId" | "body">,
  widget: KinWidget | undefined,
): boolean {
  if (message.author._tag !== "system" || message.status === "deleted") return false;
  if (message.widgetId === null) return BOOKKEEPING_TEXT.test(message.body);
  if (widget === undefined || widget.widgetClass !== "native") return false;
  if (widget.type === "deferral") return kinDeferralIsBookkeeping(widget);
  return widget.type === KIN_MEMORY_CHANGES_CARD && kinMemoryChangesView(widget) !== null;
}

/** The messages a feed draws: everything but Kin's bookkeeping. */
export const kinFeedMessages = (
  messages: ReadonlyArray<KinMessage>,
  widgets: ReadonlyMap<string, KinWidget>,
): ReadonlyArray<KinMessage> =>
  messages.filter(
    (message) =>
      !kinIsBookkeeping(
        message,
        message.widgetId === null ? undefined : widgets.get(message.widgetId),
      ),
  );

const PLAIN_FIELDS = ["title", "text", "summary", "body"] as const;

// The first plain words a card's state carries, whatever its kind: what it would have said.
function unknown(widget: KinWidget): KinCardView {
  const state: unknown = widget.state;
  if (typeof state !== "object" || state === null) return { kind: "unknown", text: null };
  for (const field of PLAIN_FIELDS) {
    const value: unknown = Reflect.get(state, field);
    const text = typeof value === "string" ? clamp(value, 280) : "";
    if (text !== "") return { kind: "unknown", text };
  }
  return { kind: "unknown", text: null };
}

/**
 * Whether a message's card draws anything. A card this build can't read is never an apology
 * about the app: the message's own text stands for it, or the card's plain words when the
 * message has none.
 */
export function kinCardDraws(
  widget: KinWidget | undefined,
  hostEnvironmentId: EnvironmentId,
  hasBody: boolean,
): boolean {
  const view = kinCardView(widget, hostEnvironmentId, () => true);
  return view.kind !== "unknown" || (!hasBody && view.text !== null);
}

/** What a message's card draws. Anything this build can't read falls back to plain text. */
export function kinCardView(
  widget: KinWidget | undefined,
  hostEnvironmentId: EnvironmentId,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
  /** The card's agent by name when it is retired: its reminders and schedules are on hold. */
  heldFor: string | null = null,
  /** Whether the viewer is owner-level; unknown offers every tap. */
  ownerLevel?: boolean,
  modelName: KinModelName = () => null,
): KinCardView {
  const view = kinLiveCardView(
    widget,
    hostEnvironmentId,
    isKnownEnvironment,
    ownerLevel,
    modelName,
  );
  if (heldFor === null || view.kind !== "deferral" || !HELD_TYPES.has(widget?.type ?? ""))
    return view;
  const { deferral } = view;
  if (deferral.phase === "closed" || deferral.actions.length === 0) return view;
  // Nothing fires while its agent is retired, so no countdown and nothing to tap.
  const lines = [
    ...deferral.lines.filter((line) => !/^(Next run|Paused)\b/.test(line)),
    kinHeldLine(heldFor),
  ];
  return {
    kind: "deferral",
    deferral: {
      ...deferral,
      lines,
      countdown: null,
      actions: [],
      accessibilityLabel: kinSentences([`${deferral.eyebrow}: ${deferral.title}`, ...lines]),
    },
  };
}

const HELD_TYPES: ReadonlySet<string> = new Set(["deferral", "reminder", "scheduled_task"]);

function kinLiveCardView(
  widget: KinWidget | undefined,
  hostEnvironmentId: EnvironmentId,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
  ownerLevel: boolean | undefined,
  modelName: KinModelName,
): KinCardView {
  if (widget === undefined) return { kind: "missing" };
  if (widget.widgetClass !== "native") return unknown(widget);
  switch (widget.type) {
    case "task": {
      const state = decodeTaskState(widget.state);
      return Option.isSome(state)
        ? {
            kind: "task",
            task: kinTaskCardView(state.value, hostEnvironmentId, isKnownEnvironment, modelName),
          }
        : unknown(widget);
    }
    case "deferral": {
      const deferral = kinDeferralCardView(widget, undefined, ownerLevel);
      return deferral === null ? unknown(widget) : { kind: "deferral", deferral };
    }
    case "reminder": {
      const deferral = kinReminderCardView(widget, undefined, ownerLevel);
      return deferral === null ? unknown(widget) : { kind: "deferral", deferral };
    }
    case "scheduled_task": {
      const deferral = kinScheduledTaskCardView(widget);
      return deferral === null ? unknown(widget) : { kind: "deferral", deferral };
    }
    case "choice": {
      const choice = kinChoiceCardView(widget);
      return choice === null ? unknown(widget) : { kind: "choice", choice };
    }
    case "chart": {
      const chart = kinChartCardView(widget);
      return chart === null ? unknown(widget) : { kind: "chart", chart };
    }
    case "visual": {
      const visual = decodeVisual(widget.state);
      return Option.isSome(visual)
        ? { kind: "visual", orgId: widget.orgId, visual: visual.value }
        : unknown(widget);
    }
    case "routine": {
      const card = decodeRoutine(widget.state);
      return Option.isSome(card)
        ? { kind: "digest", digest: kinRoutineView(card.value) }
        : unknown(widget);
    }
    case "approval": {
      const approval = kinApprovalWidgetView(widget);
      return approval === null ? unknown(widget) : { kind: "approval", approval };
    }
    case KIN_DOC_CARD: {
      const doc = kinDocCardView(widget);
      return doc === null ? unknown(widget) : { kind: "doc", doc };
    }
    case KIN_STATEMENT_REVIEW_CARD: {
      const review = kinStatementReviewView(widget);
      return review === null ? unknown(widget) : { kind: "statement_review", review };
    }
    case KIN_STATEMENT_PASSWORD_CARD: {
      const password = kinStatementPasswordView(widget);
      return password === null ? unknown(widget) : { kind: "statement_password", password };
    }
    case KIN_MEMORY_CHANGES_CARD: {
      const changes = kinMemoryChangesView(widget);
      return changes === null ? unknown(widget) : { kind: "memory_changes", changes };
    }
    case KIN_SOCIAL_WEEK_CARD: {
      const week = kinSocialWeekView(widget);
      return week === null ? unknown(widget) : { kind: "social_week", week };
    }
    case KIN_SOCIAL_PACK_CARD: {
      const pack = kinSocialPackView(widget);
      return pack === null ? unknown(widget) : { kind: "social_pack", pack };
    }
    case KIN_HOST_TROUBLE_CARD:
      return kinHostTroubleCardView(widget, String) === null
        ? unknown(widget)
        : { kind: "host_trouble", widget };
    default:
      return unknown(widget);
  }
}

/** Words on chat cards: pictures, decisions and visuals. */
export const KIN_CARD_COPY = {
  choicePicture: "The picture this question is about",
  asksToLoadFrom: "This visual asks to load from",
  allowHostTitle: "Allow this host for every visual?",
  allowHostDetail:
    "The visual asked for this itself; nobody checked the host. Once allowed, every visual in this workspace can load from it and send it anything a visual shows. Allow only a host you trust. You can remove it later under Team.",
  saveFileFailed: "Couldn't save this file",
  svgUnsafe: (error: string) => `Kin couldn't save this SVG safely: ${error}.`,
  visualFailed: "Couldn't load this visual.",
  visualGone: "This visual is no longer available.",
  visualAllowAll: "Allow for every visual",
  seeHow: "See how they got there",
  openDiscussion: "Open the discussion",
  pictureFailed: "The picture couldn't load. Open the chat to see the file.",
} as const;
