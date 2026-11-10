// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KIN_MEMORY_CHANGES_CARD,
  KinReminderCard,
  KinRoutineCard,
  KinScheduledTaskCard,
  KinTaskCardState,
  type EnvironmentId,
  type KinRoutineSection,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinApprovalWidgetView, type KinApprovalWidgetView } from "./kinApprovalPresentation.ts";
import { kinLinkLabel, kinSafeWebUrl } from "./kinLinks.ts";
import { kinSentences } from "./kinScreenState.ts";
import { kinChoiceCardView, type KinChoiceCardView } from "./kinChoicePresentation.ts";
import {
  formatKinDeferralTime,
  KIN_DEFERRAL_ACTIONS,
  kinDeferralCardView,
  type KinDeferralCardView,
} from "./kinDeferralPresentation.ts";
import {
  kinMemoryChangesView,
  type KinMemoryChangesCardView,
} from "./kinMemoryChangesPresentation.ts";

export const KIN_UNKNOWN_CARD_TEXT = "This card can't be shown here yet.";
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
  | { readonly kind: "digest"; readonly digest: KinDigestCardView }
  | { readonly kind: "memory_changes"; readonly changes: KinMemoryChangesCardView }
  | { readonly kind: "approval"; readonly approval: KinApprovalWidgetView }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" };

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
const decodeReminder = Schema.decodeUnknownOption(KinReminderCard);
const decodeScheduledTask = Schema.decodeUnknownOption(KinScheduledTaskCard);

// Agents write widget state, so every string is clamped and shown as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

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
    open === null ? null : "Opens the thread",
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
  past_review: "Past review",
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
        note: row.note === undefined ? null : clamp(row.note, 280) || null,
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

/** What a message's card draws. Anything this build can't read falls back to plain text. */
export function kinCardView(
  widget: KinWidget | undefined,
  hostEnvironmentId: EnvironmentId,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
): KinCardView {
  if (widget === undefined) return { kind: "missing" };
  if (widget.widgetClass !== "native") return { kind: "unknown" };
  switch (widget.type) {
    case "task": {
      const state = decodeTaskState(widget.state);
      return Option.isSome(state)
        ? {
            kind: "task",
            task: kinTaskCardView(state.value, hostEnvironmentId, isKnownEnvironment),
          }
        : { kind: "unknown" };
    }
    case "deferral": {
      const deferral = kinDeferralCardView(widget);
      return deferral === null ? { kind: "unknown" } : { kind: "deferral", deferral };
    }
    case "reminder": {
      const deferral = kinReminderCardView(widget);
      return deferral === null ? { kind: "unknown" } : { kind: "deferral", deferral };
    }
    case "scheduled_task": {
      const deferral = kinScheduledTaskCardView(widget);
      return deferral === null ? { kind: "unknown" } : { kind: "deferral", deferral };
    }
    case "choice": {
      const choice = kinChoiceCardView(widget);
      return choice === null ? { kind: "unknown" } : { kind: "choice", choice };
    }
    case "routine": {
      const card = decodeRoutine(widget.state);
      return Option.isSome(card)
        ? { kind: "digest", digest: kinRoutineView(card.value) }
        : { kind: "unknown" };
    }
    case "approval": {
      const approval = kinApprovalWidgetView(widget);
      return approval === null ? { kind: "unknown" } : { kind: "approval", approval };
    }
    case KIN_MEMORY_CHANGES_CARD: {
      const changes = kinMemoryChangesView(widget);
      return changes === null ? { kind: "unknown" } : { kind: "memory_changes", changes };
    }
    default:
      return { kind: "unknown" };
  }
}
