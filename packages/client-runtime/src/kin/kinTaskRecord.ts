// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import type { KinRecordChange, KinRecordDetail, KinWorkPrincipal } from "@t3tools/contracts";

import { formatKinTime, type KinAvatarView } from "./kinScreenState.ts";
import {
  kinWorkActorName,
  kinWorkAvatar,
  kinWorkChangeText,
  kinWorkDueDayText,
  kinWorkDueText,
  kinWorkName,
  type KinWorkItemView,
  type KinWorkNames,
} from "./kinWork.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export const KIN_TASK_RECORD = {
  details: "Details",
  askedBy: "Asked by",
  heldBy: "Held by",
  due: "Due",
  brief: "Brief",
  noBrief: "No brief yet.",
  activity: "Activity",
  linked: "Linked",
  edit: "Edit",
  more: "More",
  nothingNeeded: "Nothing needed from you yet.",
  noActivity: "Nothing has happened here yet.",
} as const;

/** Someone the record names, as a row draws them: "Rhea (you)", or the agent's name. */
export interface KinRecordWho {
  readonly name: string;
  readonly avatar: KinAvatarView;
}

export function kinRecordWho(who: KinWorkPrincipal, names: KinWorkNames): KinRecordWho {
  const mine = who._tag === "person" && who.personId === names.me;
  const own = mine ? names.people.get(who.personId) : undefined;
  return {
    name: mine ? (own === undefined ? "You" : `${own} (you)`) : kinWorkName(who, names),
    avatar: kinWorkAvatar(who),
  };
}

const isMe = (who: KinWorkPrincipal, names: KinWorkNames) =>
  who._tag === "person" && who.personId === names.me;

/**
 * Who asked for it: the person who made it, else the person who gave it to its holder. An agent
 * that wrote the task down asked nothing; null when no person is on record.
 */
export const kinRecordAskedBy = (
  item: Pick<KinRecordDetail, "createdBy" | "assignedBy">,
): KinWorkPrincipal | null =>
  item.createdBy._tag === "person"
    ? item.createdBy
    : item.assignedBy?._tag === "person"
      ? item.assignedBy
      : null;

export type KinRecordChipTone = "wait" | "doing" | "late" | "done" | "plain";

/** The state chip above the title: the one word on where it stands for this viewer. */
export function kinRecordChip(
  item: KinRecordDetail,
  view: Pick<KinWorkItemView, "suggestion" | "can" | "status" | "closed">,
  names: KinWorkNames,
  now: Date,
): { readonly tone: KinRecordChipTone; readonly label: string } {
  if (item.state === "done") return { tone: "done", label: "Done" };
  if (item.state === "dropped") return { tone: "plain", label: "Dropped" };
  if (item.late && item.dueAt !== null) {
    const days = Math.floor((now.getTime() - new Date(item.dueAt).getTime()) / DAY_MS);
    return {
      tone: "late",
      label: days >= 2 ? `${days} days late` : days === 1 ? "1 day late" : "Late",
    };
  }
  const handedToMe = item.handedBack !== undefined && isMe(item.owner, names);
  const waitsOnMe =
    item.state === "waiting" && item.waitingOn !== null && isMe(item.waitingOn, names);
  if ((view.suggestion !== null && view.can.confirm) || handedToMe || waitsOnMe)
    return { tone: "wait", label: "Waiting on you" };
  if (item.state === "doing" || item.working) return { tone: "doing", label: "In progress" };
  if (item.state === "waiting") return { tone: "wait", label: view.status };
  return { tone: "plain", label: view.status };
}

export type KinNextStepAct = "keep" | "decline" | "done" | "reopen" | "give" | "handBack";

/**
 * The one thing that moves this task for this viewer, drawn as a card under the title. `acts`
 * holds only moves the host takes from this viewer; the first is the primary one.
 */
export interface KinNextStepView {
  readonly kind: "suggested" | "handedBack" | "yours" | "late" | "agent" | "held" | "closed";
  readonly who: KinRecordWho | null;
  /** What follows the name: "suggested this task", "is on it". */
  readonly line: string;
  readonly when: string | null;
  /** Someone's own words, quoted. */
  readonly words: string | null;
  readonly note: string | null;
  readonly acts: ReadonlyArray<{ readonly id: KinNextStepAct; readonly label: string }>;
}

export function kinNextStep(input: {
  readonly item: KinRecordDetail;
  readonly view: KinWorkItemView;
  readonly names: KinWorkNames;
  readonly now: Date;
  /** This viewer may change the task, and give it to someone. */
  readonly change: boolean;
  readonly give: boolean;
}): KinNextStepView {
  const { item, view, names, now } = input;
  const to = (state: KinRecordDetail["state"]) => input.change && view.can.states.includes(state);
  const giveAct =
    input.give && view.can.give ? [{ id: "give" as const, label: view.assignLabel ?? "" }] : [];
  const holder = kinRecordWho(item.owner, names);
  const due = kinWorkDueText(item, names, now);
  if (view.suggestion !== null) {
    const acts =
      input.change && view.can.confirm
        ? [
            { id: "keep" as const, label: "Keep it" },
            { id: "decline" as const, label: "Not needed" },
          ]
        : [];
    return {
      kind: "suggested",
      who: item.createdBy._tag === "system" ? null : kinRecordWho(item.createdBy, names),
      line:
        item.createdBy._tag === "system" ? "An agent suggested this task" : "suggested this task",
      when: formatKinTime(new Date(item.createdAt), now),
      words: null,
      note: acts.length === 0 ? KIN_TASK_RECORD.nothingNeeded : null,
      acts,
    };
  }
  if (view.closed) {
    const closing = item.changes.find((change) =>
      change.fields.some((field) => field.field === "state" && field.to === item.state),
    );
    const by = closing?.by;
    const finished = item.state === "done" ? "finished this" : "dropped this";
    const at = closing?.at ?? item.closedAt;
    return {
      kind: "closed",
      who: by === undefined || by._tag === "system" ? null : kinRecordWho(by, names),
      line: by === undefined || by._tag === "system" ? capital(finished) : finished,
      when: at === null ? null : formatKinTime(new Date(at), now),
      words: null,
      note: null,
      acts: to("open") ? [{ id: "reopen", label: "Reopen" }] : [],
    };
  }
  const done = to("done") ? [{ id: "done" as const, label: "Mark done" }] : [];
  if (item.handedBack !== undefined && isMe(item.owner, names)) {
    return {
      kind: "handedBack",
      who: kinRecordWho(item.handedBack.by, names),
      line: "handed this back",
      when: formatKinTime(new Date(item.handedBack.at), now),
      words: view.reason,
      note: null,
      acts: [...done, ...giveAct],
    };
  }
  if (isMe(item.owner, names)) {
    const back =
      input.change && view.handBackTo !== null
        ? [{ id: "handBack" as const, label: `Hand back to ${view.handBackTo}` }]
        : [];
    return {
      kind: "yours",
      who: { name: "You", avatar: holder.avatar },
      line: "have this",
      when: due === null ? null : `due ${due}`,
      words: view.reason,
      note: null,
      acts: [...done, ...back],
    };
  }
  if (item.late) {
    return {
      kind: "late",
      who: holder,
      line: due === null ? "has this." : `has this. It was due ${due}.`,
      when: null,
      words: null,
      note: giveAct.length === 0 ? KIN_TASK_RECORD.nothingNeeded : null,
      acts: giveAct,
    };
  }
  if (item.owner._tag === "agent") {
    if (view.owner.retired)
      return {
        kind: "agent",
        who: holder,
        line: "is retired",
        when: null,
        words: null,
        note: "Nobody is working on this.",
        acts: giveAct,
      };
    const agent = item.owner.agentId;
    const latest = item.changes.find(
      (change) => change.by._tag === "agent" && change.by.agentId === agent,
    );
    return {
      kind: "agent",
      who: holder,
      line: item.working ? "is working on it now" : "is on it",
      when: latest === undefined ? null : `updated ${formatKinTime(new Date(latest.at), now)}`,
      words: null,
      note: KIN_TASK_RECORD.nothingNeeded,
      acts: [],
    };
  }
  return {
    kind: "held",
    who: holder,
    line: item.state === "waiting" ? view.status.replace(/^Waiting/, "is waiting") : "has this",
    when: due === null ? null : `due ${due}`,
    words: null,
    note: KIN_TASK_RECORD.nothingNeeded,
    acts: [],
  };
}

export type KinActivityIcon =
  | "made"
  | "gave"
  | "due"
  | "brief"
  | "title"
  | "state"
  | "link"
  | "change";

/** One line of a task's Activity, with what a change replaced shown beside what it became. */
export interface KinActivityLine {
  readonly key: string;
  readonly icon: KinActivityIcon;
  /** Set in bold ahead of `text`; null when the line names nobody first. */
  readonly who: string | null;
  readonly text: string;
  readonly when: string;
  readonly before: string | null;
  readonly after: string | null;
}

const SHOWN_CHANGES = ["due", "title", "notes"] as const;

function changeIcon(change: KinRecordChange): KinActivityIcon {
  if (change.kind === "created") return "made";
  if (change.kind === "linked") return "link";
  const has = (name: string) => change.fields.some((field) => field.field === name);
  if (has("owner")) return "gave";
  if (has("state")) return "state";
  if (has("due")) return "due";
  if (has("notes")) return "brief";
  if (has("title")) return "title";
  return "change";
}

function beforeAfter(change: KinRecordChange, names: KinWorkNames, now: Date) {
  if (change.kind !== "updated") return { before: null, after: null };
  for (const name of SHOWN_CHANGES) {
    const field = change.fields.find((held) => held.field === name);
    if (field === undefined) continue;
    if (name === "due")
      return {
        before: kinWorkDueDayText(field.from, now, names.zone) ?? "No date",
        after: kinWorkDueDayText(field.to, now, names.zone) ?? "No date",
      };
    const before = field.from?.trim() || null;
    const after = field.to?.trim() || null;
    if (before !== null || after !== null) return { before, after };
  }
  return { before: null, after: null };
}

/** A task's changes as Activity reads them: oldest first, each with who, when and what moved. */
export function kinTaskActivity(
  item: Pick<KinRecordDetail, "changes">,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinActivityLine> {
  return [...item.changes].reverse().map((change) => {
    const full = kinWorkChangeText(change, names, now, "work", "brief");
    const who = kinWorkActorName(change.by, names);
    const named = full.startsWith(`${who} `);
    return {
      key: String(change.seq),
      icon: changeIcon(change),
      who: named ? who : null,
      text: named ? full.slice(who.length + 1) : full,
      when: formatKinTime(new Date(change.at), now),
      ...beforeAfter(change, names, now),
    };
  });
}

/** Who wrote the brief as it reads now, and when: "Rhea, 12 Nov". Null with no brief. */
export function kinBriefBy(
  item: Pick<KinRecordDetail, "notes" | "changes" | "createdBy" | "createdAt">,
  names: KinWorkNames,
  now: Date,
): { readonly name: string; readonly avatar: KinAvatarView | null; readonly when: string } | null {
  if (item.notes.trim() === "") return null;
  const wrote = item.changes.find((change) =>
    change.fields.some((field) => field.field === "notes"),
  );
  const by = wrote?.by ?? item.createdBy;
  return {
    name: kinWorkActorName(by, names),
    avatar: by._tag === "system" ? null : kinWorkAvatar(by),
    when: formatKinTime(new Date(wrote?.at ?? item.createdAt), now),
  };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
