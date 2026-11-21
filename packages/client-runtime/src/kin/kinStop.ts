import type { KinOrgState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { KIN_RETRY, kinFailure } from "./kinAnswers.ts";
import { formatKinDeferralTime } from "./kinDeferralPresentation.ts";
import type { KinWorkReadState } from "./kinWorkForms.ts";

/** The company stop switch (`kin.org.*`): its Settings row and the line a stopped chat shows. */
export const KIN_STOP = {
  title: "All agents",
  running: "Agents are working.",
  stopped: "All agents are stopped.",
  loading: "Checking whether agents are working…",
  loadFailed: "Couldn't check whether agents are working.",
  stop: "Stop all agents",
  stopping: "Stopping…",
  resume: "Resume",
  resuming: "Resuming…",
  ask: {
    title: "Stop all agents?",
    detail:
      "Every agent stops now, for everyone, and scheduled work due while they are stopped is skipped. Messages wait up to a day for Resume, and nothing anyone Confirms goes out while they are stopped.",
    reasonLabel: "Reason (optional)",
    reasonHint: "Only owners and co-owners see the reason.",
    confirm: "Stop all agents",
    cancel: "Cancel",
  },
  chat: {
    owner: "All agents are stopped. Messages wait until you resume them in Settings.",
    member: "All agents are stopped. Messages wait until an owner resumes them.",
  },
} as const;

export const KIN_STOP_REASON_MAX = 200;

export type KinStopBusy = "stop" | "resume" | null;

export type KinStopRowView =
  | { readonly _tag: "loading"; readonly detail: string }
  /** `retry` is null where trying again can't help, such as a refusal. */
  | { readonly _tag: "failed"; readonly detail: string; readonly retry: string | null }
  | {
      readonly _tag: "running" | "stopped";
      /** One or two short lines: the state, then who stopped it and when. */
      readonly lines: ReadonlyArray<string>;
      readonly reason: string | null;
      /** Null for someone who may not stop or resume. */
      readonly action: {
        readonly kind: "stop" | "resume";
        readonly label: string;
        readonly busy: boolean;
      } | null;
      readonly problem: string | null;
    };

const stoppedBy = (name: string | null, when: string) =>
  name === null ? `Stopped ${when}.` : `Stopped by ${name}, ${when}.`;

/** What the row says now; `timeZone` is the device's unless given. */
export function kinStopRow(input: {
  readonly read: KinWorkReadState<KinOrgState>;
  readonly canAct: boolean;
  readonly busy: KinStopBusy;
  /** Why the last stop or resume didn't go through (`kinListSend`), until the next one. */
  readonly problem: string | null;
  readonly nameOf: (personId: string) => string | null;
  readonly timeZone?: string;
}): KinStopRowView {
  const { read, canAct, busy, problem } = input;
  if (read._tag === "loading") return { _tag: "loading", detail: KIN_STOP.loading };
  if (read._tag !== "ready") {
    const failure = kinFailure(read._tag === "failed" ? read.cause : null, KIN_STOP.loadFailed);
    return { _tag: "failed", detail: failure.text, retry: failure.retry ? KIN_RETRY : null };
  }
  const state = read.value;
  if (!state.paused)
    return {
      _tag: "running",
      lines: [KIN_STOP.running],
      reason: null,
      action: canAct
        ? {
            kind: "stop",
            label: busy === "stop" ? KIN_STOP.stopping : KIN_STOP.stop,
            busy: busy !== null,
          }
        : null,
      problem,
    };
  const when = formatKinDeferralTime(DateTime.toEpochMillis(state.pausedAt), input.timeZone);
  const reason = state.reason?.trim() ?? "";
  return {
    _tag: "stopped",
    lines: [KIN_STOP.stopped, stoppedBy(input.nameOf(state.pausedBy), when)],
    reason: reason === "" ? null : `Reason: ${reason}`,
    action: canAct
      ? {
          kind: "resume",
          label: busy === "resume" ? KIN_STOP.resuming : KIN_STOP.resume,
          busy: busy !== null,
        }
      : null,
    problem,
  };
}

/** The pause's input: a reason only when one was typed, and never longer than the box allows. */
export const kinStopReason = (typed: string): { readonly reason?: string } => {
  const reason = typed.trim().slice(0, KIN_STOP_REASON_MAX);
  return reason === "" ? {} : { reason };
};

/** The stop line before a line the chat already shows, so neither hides the other. */
export const kinStopNotice = (stopLine: string | null, other: string | null): string | null =>
  stopLine === null ? other : other === null ? stopLine : `${stopLine} ${other}`;

/** The line a chat with an agent shows while every agent is stopped; null while they work. */
export const kinStopChatLine = (state: KinOrgState | null, canResume: boolean): string | null =>
  state?.paused === true ? (canResume ? KIN_STOP.chat.owner : KIN_STOP.chat.member) : null;
