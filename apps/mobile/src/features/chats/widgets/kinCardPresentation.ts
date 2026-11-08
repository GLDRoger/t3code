import { KinTaskCardState, type EnvironmentId, type KinWidget } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const KIN_UNKNOWN_CARD_TEXT = "This card needs a newer version of Kin.";
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

// Agents write widget state, so every string is clamped and shown as plain text.
const clamp = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Only web links open from a card; anything else an agent wrote is dropped. */
function safeWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function kinTaskCardView(
  state: KinTaskCardState,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
): KinTaskCardView {
  const { label, tone } = STATUS[state.status];
  const title = clamp(state.title, 200);
  const model = state.model === null ? null : clamp(state.model, 60) || null;
  const detail =
    state.lastError !== null && (state.status === "failed" || state.status === "blocked")
      ? clamp(state.lastError, 280) || null
      : null;
  const environmentId = state.remoteEnvironmentId ?? state.environmentId;
  const known = isKnownEnvironment(environmentId);
  const open =
    state.threadId !== null && known ? { environmentId, threadId: state.threadId } : null;
  const pullRequests = state.pullRequests.flatMap((pr) => {
    const url = safeWebUrl(pr.url);
    return url === null ? [] : [{ url, label: `PR ${pr.number}` }];
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
    accessibilityLabel: `${parts.filter((part) => part !== null).join(". ")}.`,
  };
}

/** What a message's card draws. Anything this build can't read falls back to plain text. */
export function kinCardView(
  widget: KinWidget | undefined,
  isKnownEnvironment: (environmentId: EnvironmentId) => boolean,
): KinCardView {
  if (widget === undefined) return { kind: "missing" };
  if (widget.widgetClass !== "native") return { kind: "unknown" };
  switch (widget.type) {
    case "task": {
      const state = decodeTaskState(widget.state);
      return Option.isSome(state)
        ? { kind: "task", task: kinTaskCardView(state.value, isKnownEnvironment) }
        : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}
