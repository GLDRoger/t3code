// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KIN_DOC_CARD,
  KIN_MEMORY_CHANGES_CARD,
  KIN_STATEMENT_PASSWORD_CARD,
  KIN_STATEMENT_REVIEW_CARD,
  KIN_WORKER_PUBLISH_CARD,
  KinWorkerPublishCard,
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
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinHeldLine } from "./kinAgentRetire.ts";
import { kinApprovalWidgetView, type KinApprovalWidgetView } from "./kinApprovalPresentation.ts";
import { kinChartCardView, type KinChartView } from "./kinChart.ts";
import { kinDocCardView, type KinDocCardView } from "./kinDocs.ts";
import { kinLinkLabel, kinSafeWebUrl } from "./kinLinks.ts";
import { kinSentences } from "./kinScreenState.ts";
import { kinChoiceCardView, type KinChoiceCardView } from "./kinChoicePresentation.ts";
import {
  formatKinDeferralTime,
  KIN_DEFERRAL_ACTIONS,
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
const decodeWorkerPublish = Schema.decodeUnknownOption(KinWorkerPublishCard);

// Agents write widget state, so every string is clamped and shown as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const OPENS_THREAD = "Opens the thread";

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
): KinTaskCardView {
  const { label, tone } = STATUS[state.status];
  const title = clamp(state.title, 200);
  const model = state.model === null ? null : clamp(state.model, 60) || null;
  const detail = state.lastError === null ? null : clamp(state.lastError, 280) || null;
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
  worker: "In progress",
  past_review: "Overdue for a check",
  done: "Done",
  slipped: "Slipped",
  promised: "Promised",
  due_tomorrow: "Due tomorrow",
};

// `day` is the owner's local date; built from its parts so no timezone shifts it.
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
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
): KinDeferralCardView | null {
  const decoded = decodeReminder(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const title = clamp(card.title, 200) || "This reminder";
  const open = widget.closedAt === null && card.status !== "done";
  const lines =
    widget.closedAt !== null
      ? ["Closed."]
      : card.status === "done"
        ? ["Done."]
        : card.status === "snoozed" && card.snoozedUntil !== undefined
          ? [`Snoozed until ${formatKinDeferralTime(Date.parse(card.snoozedUntil), timeZone)}.`]
          : [`Due ${formatKinDeferralTime(Date.parse(card.dueAt), timeZone)}.`];
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.itemId,
    phase: open ? "reminder" : "closed",
    eyebrow: "Reminder",
    title,
    lines,
    countdown: null,
    actions: open
      ? [
          actions.done,
          actions.snooze_10m,
          actions.snooze_1h,
          actions.snooze_tomorrow,
          actions.change,
        ]
      : [],
    accessibilityLabel: kinSentences([`Reminder: ${title}`, ...lines]),
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "Weekdays at 8:00", read in the owner's zone, which is named when this device is elsewhere. */
function scheduleLine(every: KinScheduledTaskCard["every"], ownerZone: string, timeZone?: string) {
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
  const zone = deviceZone === ownerZone ? "" : ` (${ownerZone})`;
  return `${when} at ${Number(hour)}:${minute}${zone}.`;
}

function lastRunLine(run: NonNullable<KinScheduledTaskCard["lastRun"]>, timeZone?: string) {
  const at = formatKinDeferralTime(Date.parse(run.at), timeZone);
  const note = run.note === undefined ? "" : clamp(run.note, 280);
  switch (run.status) {
    case "running":
      return "Running now.";
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
  const nextMs = card.nextRunAt === null ? null : Date.parse(card.nextRunAt);
  const lines = !open
    ? ["Deleted."]
    : [
        scheduleLine(card.every, card.timeZone, timeZone),
        ...(card.status === "paused" ? ["Paused."] : []),
        ...(card.status === "active" && nextMs !== null
          ? [`Next run ${formatKinDeferralTime(nextMs, timeZone)}.`]
          : []),
        ...(card.lastRun === null ? [] : [lastRunLine(card.lastRun, timeZone)]),
      ];
  const running = card.lastRun?.status === "running";
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.itemId,
    phase: open ? "scheduled" : "closed",
    eyebrow: "Scheduled task",
    title,
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

const PUBLISH_WHY: Record<KinWorkerPublishCard["why"][number], string> = {
  public_repository: "The repository is public: anyone can read what Kin pushes.",
  visibility_unknown: "Kin couldn't confirm the repository is private, so it treats it as public.",
  sensitive_work: "This work involves something marked sensitive in Work.",
};
const PUBLISH_END: Record<
  Exclude<KinWorkerPublishCard["status"], "waiting" | "publishing" | "published">,
  string
> = {
  declined: "Not published. The changes stay on the host.",
  replaced: "This card is out of date: a newer one asks about the latest changes.",
  stopped: "The work was stopped, so nothing was published.",
  failed: "Kin couldn't publish it. Your agent says why.",
};
const fileLine = (file: KinWorkerPublishCard["files"][number]) =>
  `${clamp(file.path, 200)} ${
    file.added === null || file.removed === null ? "(binary)" : `+${file.added} −${file.removed}`
  }`;

/**
 * Kin's card asking the owner to publish a worker's commit. Every fact is Kin's own except the
 * pull request title, which the lead wrote and is shown quoted.
 */
function kinWorkerPublishCardView(widget: KinWidget): KinDeferralCardView | null {
  const decoded = decodeWorkerPublish(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const repository = clamp(card.repository, 200) || "GitHub";
  const open = widget.closedAt === null && card.status === "waiting";
  const lines = open
    ? [
        ...card.why.map((why) => PUBLISH_WHY[why]),
        `Branch ${clamp(card.branch, 200)}, commit ${card.sha.slice(0, 7)}.`,
        `Pull request title, from your agent (unchecked): "${clamp(card.pullRequestTitle, 200)}"`,
        ...card.files.map(fileLine),
        ...(card.moreFiles > 0
          ? [`and ${card.moreFiles} more file${card.moreFiles === 1 ? "" : "s"}.`]
          : []),
      ]
    : card.status === "publishing"
      ? ["Publishing."]
      : card.status === "published"
        ? [
            card.pullRequestUrl === undefined
              ? "Published."
              : `Published as ${clamp(card.pullRequestUrl, 280)}.`,
          ]
        : card.status === "waiting"
          ? ["Closed."]
          : [PUBLISH_END[card.status]];
  const title = `Publish to ${repository}?`;
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    itemId: card.sha,
    phase: open ? "asked" : "closed",
    eyebrow: open ? "Needs your decision" : "Worker changes",
    title,
    lines,
    countdown: null,
    actions: open ? [KIN_DEFERRAL_ACTIONS.publish, KIN_DEFERRAL_ACTIONS.dont_publish] : [],
    accessibilityLabel: kinSentences([title, ...lines]),
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
): KinCardView {
  const view = kinLiveCardView(widget, hostEnvironmentId, isKnownEnvironment);
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
): KinCardView {
  if (widget === undefined) return { kind: "missing" };
  if (widget.widgetClass !== "native") return unknown(widget);
  switch (widget.type) {
    case "task": {
      const state = decodeTaskState(widget.state);
      return Option.isSome(state)
        ? {
            kind: "task",
            task: kinTaskCardView(state.value, hostEnvironmentId, isKnownEnvironment),
          }
        : unknown(widget);
    }
    case "deferral": {
      const deferral = kinDeferralCardView(widget);
      return deferral === null ? unknown(widget) : { kind: "deferral", deferral };
    }
    case "reminder": {
      const deferral = kinReminderCardView(widget);
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
    case KIN_WORKER_PUBLISH_CARD: {
      const deferral = kinWorkerPublishCardView(widget);
      return deferral === null ? unknown(widget) : { kind: "deferral", deferral };
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
    default:
      return unknown(widget);
  }
}
