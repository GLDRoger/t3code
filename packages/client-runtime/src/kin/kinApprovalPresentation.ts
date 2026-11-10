import {
  KinActionId,
  KinApprovalError,
  KinPendingActionState,
  kinApprovalActionIdOf,
  type KinApprovalView,
  type KinCheckRun,
  type KinPendingAction,
  type KinWidget,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinSentences } from "./kinScreenState.ts";

/** What a chat message's approval widget says: which action, and where it stood when drawn. */
export interface KinApprovalWidgetView {
  readonly actionId: KinActionId;
  readonly state: KinPendingActionState | null;
  readonly closed: boolean;
  /** Bumps whenever the host redraws the card, so a reader knows to read the action again. */
  readonly revision: number;
}

const WidgetState = Schema.Struct({
  actionId: KinActionId,
  state: Schema.optional(KinPendingActionState),
});
const decodeWidgetState = Schema.decodeUnknownOption(WidgetState);

/** Null when the widget isn't a server-drawn approval card for the action its id names. */
export function kinApprovalWidgetView(widget: KinWidget): KinApprovalWidgetView | null {
  const actionId = kinApprovalActionIdOf(widget.widgetId);
  const state = decodeWidgetState(widget.state);
  if (actionId === null || Option.isNone(state) || state.value.actionId !== actionId) return null;
  return {
    actionId,
    state: state.value.state ?? null,
    closed: widget.closedAt !== null,
    revision: widget.revision,
  };
}

/** Where the card is in Approve or Decline on this device; `null` while nothing is running. */
export type KinApprovalBusy = "approving" | "declining";

export interface KinApprovalFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Long-press copies it; shown whole, never cut. */
  readonly selectable: boolean;
}

export interface KinApprovalCheckRow {
  readonly key: string;
  readonly name: string;
  readonly status: KinCheckRun["status"];
  readonly label: string;
}

export interface KinApprovalCardView {
  readonly actionId: KinActionId;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly facts: ReadonlyArray<KinApprovalFact>;
  readonly checks: ReadonlyArray<KinApprovalCheckRow>;
  /** Who asked; `warning` when the request didn't come from the owner alone. */
  readonly asked: { readonly text: string; readonly warning: boolean } | null;
  readonly reason: { readonly label: string; readonly text: string } | null;
  /** The settled outcome, or what is happening now. */
  readonly status: string | null;
  readonly settled: boolean;
  /** Approve and Decline are offered: the viewer approves, and the action still waits. */
  readonly decidable: boolean;
  /** Why Approve is off while Decline stays available. */
  readonly approveBlocked: string | null;
  readonly accessibilityLabel: string;
}

// Agents write titles, reasons and branch names, so every shown string is clamped plain text.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

const METHOD: Record<PullRequestMergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

const CHECK_LABEL: Record<KinCheckRun["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  pending: "Pending",
  skipped: "Skipped",
};

const KEY_HARDWARE: Record<"secure_enclave" | "strongbox" | "tee", string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "Secure hardware",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function checksSummary(checks: ReadonlyArray<KinCheckRun>): string {
  if (checks.length === 0) return "None reported";
  const by = (status: KinCheckRun["status"]) => checks.filter((c) => c.status === status).length;
  return [
    by("passed") > 0 ? `${by("passed")} passed` : null,
    by("failed") > 0 ? `${by("failed")} failed` : null,
    by("pending") > 0 ? `${by("pending")} pending` : null,
    by("skipped") > 0 ? `${by("skipped")} skipped` : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

type Settled = Exclude<KinPendingActionState, "awaiting_approval">;

/** One line per state; merges and level raises read differently only while they run or land. */
function statusLine(action: KinPendingAction, state: KinPendingActionState): string | null {
  const merge = action.kind === "merge_pull_request";
  const lines: Record<Settled, string> = {
    approved: merge ? "Approved. Merging soon." : "Approved. Applying soon.",
    executing: merge ? "Approved. Merging now." : "Approved. Applying now.",
    succeeded: merge ? "Merged." : "Done.",
    failed:
      action.stateReason?.startsWith("head_moved") === true
        ? "A new commit landed after you approved, so it didn't merge. Approve the new request instead."
        : "Approved, but it didn't run. Approve a new request to try again.",
    interrupted: "Approved, but it didn't finish. Approve a new request to try again.",
    rejected: "Declined.",
    expired: "Expired before anyone decided.",
    voided: "The approval lapsed before it ran.",
    cancelled: "Withdrawn.",
  };
  return state === "awaiting_approval" ? null : lines[state];
}

/** Plain status for a card drawn without its facts: web, desktop, or a redacted view. */
export const KIN_APPROVAL_STATE_TEXT: Record<KinPendingActionState, string> = {
  awaiting_approval: "Waiting for approval.",
  approved: "Approved.",
  executing: "Approved.",
  succeeded: "Done.",
  failed: "Didn't run.",
  interrupted: "Didn't finish.",
  rejected: "Declined.",
  expired: "Expired.",
  voided: "Lapsed.",
  cancelled: "Withdrawn.",
};

// Requesters the server reserves for requests a person made, not a lead (approvals spec §8).
const PERSON_REQUESTERS = new Set(["kin-promotion", "kin-approver-keys"]);

function askedLine(view: Extract<KinApprovalView, { _tag: "full" }>) {
  const { provenance, requestedBy } = view.action;
  if (provenance.ceilingBelowOwner) {
    const name = view.afterNonOwnerName === undefined ? null : clamp(view.afterNonOwnerName, 60);
    const text =
      provenance.afterNonOwnerMessage !== undefined
        ? `Asked for after ${name || "someone else"}'s message.`
        : provenance.startedBy === "github"
          ? "Asked for after activity on GitHub."
          : provenance.startedBy === "schedule"
            ? "Asked for by a scheduled check."
            : "Asked for after someone else's message.";
    return { text, warning: true };
  }
  if (PERSON_REQUESTERS.has(requestedBy.agentId))
    return { text: "You asked for this.", warning: false };
  const lead = view.leadName === undefined ? "" : clamp(view.leadName, 60);
  return { text: `Asked by ${lead || "your lead"}.`, warning: false };
}

function fullView(
  view: Extract<KinApprovalView, { _tag: "full" }>,
  input: { readonly decided: KinPendingActionState | null; readonly busy: KinApprovalBusy | null },
): KinApprovalCardView {
  const { action } = view;
  // A decision this device just made shows at once; the host's newer state wins once it lands.
  const state =
    action.state === "awaiting_approval" && input.decided !== null ? input.decided : action.state;
  const settled = state !== "awaiting_approval";
  const lead = view.leadName === undefined ? "" : clamp(view.leadName, 60);
  let title: string;
  let subtitle: string | null = null;
  const facts: Array<KinApprovalFact> = [];
  let checks: ReadonlyArray<KinApprovalCheckRow> = [];
  let approveBlocked: string | null = null;
  const fact = (key: string, label: string, value: string, selectable = false) =>
    facts.push({ key, label, value, selectable });

  if (action.target._tag === "pull_request" && action.resolved._tag === "pull_request") {
    const { target, resolved } = action;
    title = `Merge #${target.number} into ${clamp(resolved.base, 80)}`;
    subtitle = clamp(resolved.title, 200) || null;
    fact("repo", "Repository", target.repo);
    // The full SHA, as the Face ID prompt shows it: an agent could grind a matching short one.
    fact("commit", "Commit", resolved.headSha, true);
    fact("branches", "Branches", `${clamp(resolved.base, 80)} ← ${clamp(resolved.head, 80)}`);
    fact(
      "method",
      "Method",
      `${METHOD[target.mergeMethod]}${target.deleteBranchAfter ? ", then delete the branch" : ""}`,
    );
    fact(
      "changes",
      "Changes",
      `${count(resolved.files, "file")}, +${resolved.additions} −${resolved.deletions}`,
    );
    fact("checks", "Checks", checksSummary(resolved.checks));
    checks = resolved.checks
      .filter((check) => check.required)
      .map((check, index) => ({
        key: `${index}:${check.name}`,
        name: clamp(check.name, 80),
        status: check.status,
        label: CHECK_LABEL[check.status],
      }));
    const required = resolved.checks.filter((check) => check.required);
    approveBlocked = required.some((check) => check.status === "failed")
      ? "A required check failed."
      : required.some((check) => check.status === "pending")
        ? "Waiting for checks."
        : null;
  } else if (action.target._tag === "level") {
    const name = lead || action.target.agentId;
    title = `Raise ${name} to ${action.target.level}`;
    fact("lead", "Lead", name);
    fact("level", "New level", action.target.level);
    fact("where", "Applies to", action.target.chatId === undefined ? "All chats" : "One chat");
  } else if (action.target._tag === "device_key") {
    const label = view.keyDeviceLabel === undefined ? "" : clamp(view.keyDeviceLabel, 80);
    title = "Let a new phone approve";
    if (label) fact("phone", "Phone", label);
    // Whole, as the Face ID prompt shows it: the new phone shows the same key on its screen.
    fact("key", "Key", action.target.thumbprint, true);
    fact(
      "hardware",
      "Hardware",
      `${KEY_HARDWARE[action.target.hardware]}, ${action.target.attested ? "attested" : "not attested"}`,
    );
  } else {
    title = "Approve this request";
  }

  const asked = askedLine(view);
  const reason = PERSON_REQUESTERS.has(action.requestedBy.agentId)
    ? null
    : clamp(action.reason, 500)
      ? { label: `${lead || "Your lead"} says`, text: clamp(action.reason, 500) }
      : null;
  const status =
    input.busy === "approving"
      ? "Waiting for Face ID…"
      : input.busy === "declining"
        ? "Declining…"
        : statusLine(action, state);
  const decidable = !settled && input.busy === null;
  return {
    actionId: action.id,
    eyebrow: settled ? "Approval" : "Approval needed",
    title,
    subtitle,
    facts,
    checks,
    asked,
    reason,
    status,
    settled,
    decidable,
    approveBlocked: decidable ? approveBlocked : null,
    accessibilityLabel: kinSentences([
      settled ? "Approval" : "Approval needed",
      title,
      subtitle,
      ...facts.map((f) => `${f.label}: ${f.value}`),
      asked.text,
      reason === null ? null : `${reason.label}: ${reason.text}`,
      status,
    ]),
  };
}

function redactedView(view: Extract<KinApprovalView, { _tag: "redacted" }>): KinApprovalCardView {
  const settled = view.state !== "awaiting_approval";
  const waitingOn = clamp(view.waitingOn, 60) || "the owner";
  const title =
    view.kind === "merge_pull_request" && view.number !== null
      ? `Merge #${view.number}${view.repo === null ? "" : ` in ${view.repo}`}`
      : view.kind === "set_level"
        ? "Change a lead's level"
        : view.kind === "register_approver_key"
          ? "Let a new phone approve"
          : "A request for the owner";
  const subtitle = view.title === null ? null : clamp(view.title, 200) || null;
  const eyebrow = settled ? "Approval" : `Waiting on ${waitingOn}`;
  const status = settled ? KIN_APPROVAL_STATE_TEXT[view.state] : null;
  return {
    actionId: view.actionId,
    eyebrow,
    title,
    subtitle,
    facts: [],
    checks: [],
    asked: null,
    reason: null,
    status,
    settled,
    decidable: false,
    approveBlocked: null,
    accessibilityLabel: kinSentences([eyebrow, title, subtitle, status]),
  };
}

/**
 * The approval card, drawn only from the host's record of the action. `decided` is the state this
 * device's own Approve or Decline just returned, shown until the host's redraw catches up.
 */
export function kinApprovalCardView(
  view: KinApprovalView,
  input: {
    readonly decided?: KinPendingActionState | null;
    readonly busy?: KinApprovalBusy | null;
  } = {},
): KinApprovalCardView {
  return view._tag === "full"
    ? fullView(view, { decided: input.decided ?? null, busy: input.busy ?? null })
    : redactedView(view);
}

/** What the phone's key module rejects with; mirrors `KinApprovalKeyErrorCode`. */
export type KinApprovalDeviceCode =
  | "E_MODULE_UNAVAILABLE"
  | "E_NO_SECURE_HARDWARE"
  | "E_UNSUPPORTED_OS"
  | "E_BIOMETRY_UNAVAILABLE"
  | "E_BIOMETRY_LOCKOUT"
  | "E_KEY_EXISTS"
  | "E_KEY_NOT_FOUND"
  | "E_KEY_INVALIDATED"
  | "E_USER_CANCELED"
  | "E_AUTH_FAILED"
  | "E_BUSY"
  | "E_NOT_A_GRANT"
  | "E_NO_ACTIVITY"
  | "E_OBSCURED"
  | "E_ATTESTATION_FAILED"
  | "E_INVALID_INPUT"
  | "E_KEYCHAIN"
  | "E_KEYSTORE";

/** Approve or Decline didn't land. `reenrol` means the fix is setting up this phone's key again. */
export interface KinApprovalFailure {
  readonly text: string;
  /** Read the action again: the host changed it. */
  readonly refresh: boolean;
  readonly reenrol: boolean;
}

const DEVICE_TEXT: Record<KinApprovalDeviceCode, KinApprovalFailure | null> = {
  // Canceling Face ID or the sheet is a choice, not a failure.
  E_USER_CANCELED: null,
  E_MODULE_UNAVAILABLE: {
    text: "This build of the app can't approve. Update it, then try again.",
    refresh: false,
    reenrol: false,
  },
  E_NO_SECURE_HARDWARE: {
    text: "This device has no secure hardware for an approval key.",
    refresh: false,
    reenrol: false,
  },
  E_UNSUPPORTED_OS: {
    text: "Approving needs a newer version of the operating system.",
    refresh: false,
    reenrol: false,
  },
  E_BIOMETRY_UNAVAILABLE: {
    text: "Turn on Face ID for this app in Settings, then try again.",
    refresh: false,
    reenrol: false,
  },
  E_BIOMETRY_LOCKOUT: {
    text: "Face ID is locked. Unlock your phone with its passcode, then try again.",
    refresh: false,
    reenrol: false,
  },
  E_KEY_EXISTS: { text: "This phone already has an approval key.", refresh: false, reenrol: false },
  E_KEY_NOT_FOUND: {
    text: "This phone has no approval key. Set up approvals again.",
    refresh: false,
    reenrol: true,
  },
  E_KEY_INVALIDATED: {
    text: "Face ID changed since this phone's key was made. Set up approvals again.",
    refresh: false,
    reenrol: true,
  },
  E_AUTH_FAILED: { text: "Face ID didn't match. Try again.", refresh: false, reenrol: false },
  E_BUSY: { text: "Another approval is open. Finish it first.", refresh: false, reenrol: false },
  E_NOT_A_GRANT: {
    text: "Your phone refused to sign this request. Nothing was approved.",
    refresh: true,
    reenrol: false,
  },
  E_NO_ACTIVITY: {
    text: "Open the app and unlock your phone, then try again.",
    refresh: false,
    reenrol: false,
  },
  E_OBSCURED: {
    text: "Something covered the approval sheet, so nothing was signed. Try again.",
    refresh: false,
    reenrol: false,
  },
  E_ATTESTATION_FAILED: {
    text: "Your phone couldn't prove its key to Apple. Check your connection and try again.",
    refresh: false,
    reenrol: false,
  },
  E_INVALID_INPUT: {
    text: "Your phone refused to sign this request. Nothing was approved.",
    refresh: true,
    reenrol: false,
  },
  E_KEYCHAIN: { text: "The keychain didn't answer. Try again.", refresh: false, reenrol: false },
  E_KEYSTORE: { text: "The keystore didn't answer. Try again.", refresh: false, reenrol: false },
};

const isApprovalError = Schema.is(KinApprovalError);

/** Plain text for what went wrong, or null when nothing needs saying (the user canceled). */
export function kinApprovalFailure(
  cause: unknown,
  deviceCode: KinApprovalDeviceCode | null = null,
): KinApprovalFailure | null {
  if (deviceCode !== null) return DEVICE_TEXT[deviceCode];
  if (!isApprovalError(cause))
    return { text: "Kin didn't answer. Try again.", refresh: false, reenrol: false };
  switch (cause.reason) {
    case "stale":
    case "head_moved":
    case "target_mismatch":
      return {
        text: "This changed since you opened it. Check it again before you approve.",
        refresh: true,
        reenrol: false,
      };
    case "invalid_state":
    case "replayed":
      return { text: "This was already decided.", refresh: true, reenrol: false };
    case "unknown_key":
    case "revoked_key":
    case "unattested":
      return {
        text: "This phone's approval key isn't active. Set up approvals again.",
        refresh: false,
        reenrol: true,
      };
    case "time_window":
      return {
        text: "Your phone's clock is off. Set it automatically, then try again.",
        refresh: false,
        reenrol: false,
      };
    case "not_owner":
    case "session_mismatch":
      return { text: "Only the owner can decide this.", refresh: false, reenrol: false };
    case "not_found":
      return { text: "This request is gone.", refresh: true, reenrol: false };
    case "unavailable":
      return {
        text: clamp(cause.message, 200) || "Kin can't approve this right now. Try again later.",
        refresh: false,
        reenrol: false,
      };
    default:
      return {
        text: "Kin refused this approval. Nothing changed.",
        refresh: true,
        reenrol: false,
      };
  }
}
