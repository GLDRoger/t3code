import {
  KinRoutineCard,
  KinShadowSummaryCard,
  KinTaskCardState,
  type EnvironmentId,
  type KinRoutineSection,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinLinkLabel, kinSafeWebUrl } from "../state/kinLinks";
import { kinSentences } from "../state/kinScreenState";
import { kinDeferralCardView, type KinDeferralCardView } from "./kinDeferralPresentation";

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
  | { readonly kind: "digest"; readonly digest: KinDigestCardView }
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
const decodeShadowSummary = Schema.decodeUnknownOption(KinShadowSummaryCard);
const decodeRoutine = Schema.decodeUnknownOption(KinRoutineCard);

// Agents write widget state, so every string is clamped and shown as plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

export function kinTaskCardView(
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

/** A server-drawn list card (shadow summary, morning brief, evening summary), as plain text. */
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
  worker: "Workers",
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

export function kinShadowSummaryView(card: KinShadowSummaryCard): KinDigestCardView {
  const hidden = card.total - card.entries.length;
  return digestView({
    eyebrow: "Shadow week",
    title: clamp(card.title, 200),
    rows: card.entries.map((entry) => ({
      key: entry.entryId,
      heading: null,
      text: clamp(entry.preview, 280) || clamp(entry.tool, 60),
      note: clamp(entry.wouldTarget, 120) || null,
      link: null,
    })),
    more: hidden > 0 ? `${hidden} more today` : null,
  });
}

export function kinRoutineView(card: KinRoutineCard): KinDigestCardView {
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

/**
 * What a message's card draws. Anything this build can't read falls back to plain text, including
 * reserved types whose cards haven't shipped, such as `shadow_review` and `promotion`.
 */
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
    case "shadow_summary": {
      const card = decodeShadowSummary(widget.state);
      return Option.isSome(card)
        ? { kind: "digest", digest: kinShadowSummaryView(card.value) }
        : { kind: "unknown" };
    }
    case "routine": {
      const card = decodeRoutine(widget.state);
      return Option.isSome(card)
        ? { kind: "digest", digest: kinRoutineView(card.value) }
        : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}
