// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  kinWorkMove,
  type KinWorkMoveGroup,
  KIN_RECORD_COMMENT_FILES_MAX,
  type KinAttachment,
  type KinProjectNote,
  type KinRecordChange,
  type KinRecordComment,
  type KinRecordDetail,
  type KinRecordWaiting,
  type KinWorkPrincipal,
} from "@t3tools/contracts";

import { kinAwayDay } from "./kinAway.ts";
import { kinSafeWebUrl } from "./kinLinks.ts";
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
import { kinWorkStatusOffer } from "./kinWorkChanges.ts";

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
  addNote: "Add a note…",
  removed: "removed this note",
  older: "Show earlier notes",
  openDraft: "Open the draft",
  openQuestion: "Open the question",
  waitingSend: "A draft is waiting for your OK",
  waitingQuestion: "A question is waiting",
  briefMoved: "The brief now says:",
  removeDetail: "It stays in Activity as removed, without its words or files.",
  noteTooLong: (max: number) => `Keep a note under ${max.toLocaleString()} characters.`,
  fromProject: "From the project",
  toldWhenBack: (name: string, day: string) =>
    `${name} is away until ${day}, so they'll be told when they're back.`,
} as const;

/** A task's note box and its notes, on web and phone. */
export const KIN_TASK_NOTE_COPY = {
  send: "Add note",
  sending: "Sending…",
  retry: "Retry",
  discard: "Discard",
  remove: "Remove",
  removeTitle: "Remove this note?",
  offline: "You're offline. Your note stays here until you're back.",
  tooMany: `A note takes up to ${KIN_RECORD_COMMENT_FILES_MAX} files.`,
  notAdded: "Your note wasn't added.",
  notRemoved: "The note wasn't removed.",
  olderFailed: "Earlier notes didn't load.",
} as const;

/** "Add a link" on a task: a web page with an optional name. */
export const KIN_TASK_LINK = {
  add: "Add a link",
  url: "Web address",
  urlPlaceholder: "https://",
  name: "Name (optional)",
  save: "Add link",
  next: "Next",
  cancel: "Cancel",
  remove: (label: string) => `Remove the link ${label}`,
  removeTitle: "Remove this link?",
  removeConfirm: "Remove",
  notWeb: "A link needs a web address that starts with https:// or http://.",
  notAdded: "The link wasn't added.",
  notRemoved: "The link wasn't removed.",
} as const;

/** What stops this address being added as a link, or null when it is a web page. */
export const kinTaskLinkProblem = (url: string): string | null =>
  url.trim() === "" ? null : kinSafeWebUrl(url.trim()) === null ? KIN_TASK_LINK.notWeb : null;

/** A project's one note, shown at the top of each of its tasks. */
export const KIN_PROJECT_NOTE = {
  title: "Note for every task",
  hint: "Every task in this project shows it at the top of its Activity.",
  placeholder: "Write a note for every task…",
  empty: "No note yet.",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  clear: "Clear",
  notSaved: "The note wasn't saved.",
} as const;

/** "From the project" at the top of a task's Activity: who wrote it, when, and which project. */
export function kinProjectNoteLine(note: KinProjectNote, names: KinWorkNames, now: Date) {
  return {
    who: kinWorkActorName(note.by, names),
    avatar: kinWorkAvatar(note.by),
    when: formatKinTime(new Date(note.at), now),
    body: note.body,
    project: note.project,
  };
}

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
 * Who asked for it: the person the host stored when it was made. Older entries have none, so
 * then the person who made it, else the person who gave it to its holder; an agent that wrote
 * the task down asked nothing. Null when no person is on record.
 */
export const kinRecordAskedBy = (
  item: Pick<KinRecordDetail, "createdBy" | "assignedBy" | "askedBy">,
): KinWorkPrincipal | null =>
  item.askedBy !== undefined
    ? { _tag: "person", personId: item.askedBy }
    : item.createdBy._tag === "person"
      ? item.createdBy
      : item.assignedBy?._tag === "person"
        ? item.assignedBy
        : null;

const samePrincipal = (a: KinWorkPrincipal, b: KinWorkPrincipal) =>
  a._tag === "person"
    ? b._tag === "person" && a.personId === b.personId
    : b._tag === "agent" && a.agentId === b.agentId;

/** The newest comment still standing, by `who` when given. */
function kinLatestComment(
  item: Pick<KinRecordDetail, "comments">,
  who?: KinWorkPrincipal,
): KinRecordComment | null {
  const comments = item.comments ?? [];
  for (let index = comments.length - 1; index >= 0; index--) {
    const comment = comments[index]!;
    if (comment.removed !== undefined || comment.body.trim() === "") continue;
    if (who === undefined || samePrincipal(comment.by, who)) return comment;
  }
  return null;
}

/** How late something due at `dueAt` is: "3 days late", "1 day late", or "Late" the same day. */
export function kinLateWords(dueAt: string, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(dueAt).getTime()) / DAY_MS);
  return days >= 2 ? `${days} days late` : days === 1 ? "1 day late" : "Late";
}

/**
 * Whose move a record is for this viewer (`kinWorkMove`), from what its page holds: the card
 * waiting on them, and who asked for it. `ownerLevel` is whether they keep suggestions.
 */
export function kinRecordMove(
  item: Pick<
    KinRecordDetail,
    | "state"
    | "owner"
    | "waitingOn"
    | "late"
    | "confirmed"
    | "createdBy"
    | "assignedBy"
    | "askedBy"
    | "givenBy"
    | "waiting"
  >,
  names: KinWorkNames,
  ownerLevel: boolean,
): KinWorkMoveGroup | null {
  if (names.me === null) return null;
  const asker = kinRecordAskedBy(item);
  return kinWorkMove(
    {
      state: item.state,
      owner: item.owner,
      waitingOn: item.waitingOn,
      late: item.late,
      confirmed: item.confirmed,
      askedBy: asker?._tag === "person" ? asker.personId : null,
      givenBy: item.givenBy ?? null,
      card: item.waiting !== undefined,
    },
    { personId: names.me, ownerLevel },
  );
}

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
  if (item.late && item.dueAt !== null)
    return { tone: "late", label: kinLateWords(item.dueAt, now) };
  const handedToMe = item.handedBack !== undefined && isMe(item.owner, names);
  // Tasks' Needs you and this chip read one rule; a plain task of your own says its status.
  const move = kinRecordMove(item, names, view.can.confirm);
  if (handedToMe || (move === "needsYou" && !isMe(item.owner, names)))
    return { tone: "wait", label: "Waiting on you" };
  if (item.state === "doing" || item.working) return { tone: "doing", label: "In progress" };
  if (item.state === "waiting") return { tone: "wait", label: view.status };
  return { tone: "plain", label: view.status };
}

export type KinNextStepAct =
  | "keep"
  | "decline"
  | "done"
  | "reopen"
  | "give"
  | "handBack"
  | "openWaiting";

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
  /** Someone's own words, quoted: the holder's latest note, or a done task's last one. */
  readonly words: string | null;
  readonly note: string | null;
  /** A draft or question waiting in a chat about this task; `openWaiting` opens it there. */
  readonly waiting: KinRecordWaiting | null;
  readonly acts: ReadonlyArray<{ readonly id: KinNextStepAct; readonly label: string }>;
}

type NextStepInput = {
  readonly item: KinRecordDetail;
  readonly view: KinWorkItemView;
  readonly names: KinWorkNames;
  readonly now: Date;
  /** This viewer may change the task, and give it to someone. */
  readonly change: boolean;
  readonly give: boolean;
};

export function kinNextStep(input: NextStepInput): KinNextStepView {
  const step = stepFor(input);
  const { item } = input;
  // A note beats the stored reason: it is the latest thing they said.
  const said =
    step.kind === "closed"
      ? item.state === "done"
        ? kinLatestComment(item)
        : null
      : step.kind === "agent" || step.kind === "held" || step.kind === "late"
        ? kinLatestComment(item, item.owner)
        : null;
  const waiting = item.waiting ?? null;
  return {
    ...step,
    words: said?.body ?? step.words,
    waiting,
    acts:
      waiting === null
        ? step.acts
        : [
            {
              id: "openWaiting",
              label:
                waiting.kind === "send" ? KIN_TASK_RECORD.openDraft : KIN_TASK_RECORD.openQuestion,
            },
            ...step.acts,
          ],
  };
}

/**
 * Where a task page's own controls sit for this viewer: status on the page, the rest in the ••• /
 * More menu; the Brief section carries the page's edit. Each is present only where the host takes
 * that move from this viewer, and Done or Reopen only where the next-step card doesn't offer it.
 */
export function kinTaskControls(input: {
  readonly view: Pick<
    KinWorkItemView,
    "state" | "closed" | "can" | "assignLabel" | "handBackTo" | "takeBack"
  >;
  /** This viewer may change the task, and give it to someone. */
  readonly change: boolean;
  readonly give: boolean;
  /** What the next-step card offers (`kinNextStep(...).acts`). */
  readonly step: ReadonlyArray<{ readonly id: KinNextStepAct }>;
}) {
  const { view, change, give } = input;
  const onCard = (id: KinNextStepAct) => input.step.some((act) => act.id === id);
  const offer = kinWorkStatusOffer(view);
  const states =
    change && !view.closed && offer.states.some((c) => view.can.states.includes(c.state));
  const waiting = change && !view.closed && offer.waiting;
  const done = change && offer.done && !onCard("done");
  const reopen = change && offer.reopen && !onCard("reopen");
  return {
    page: {
      status: done || reopen || states || waiting ? { done, reopen, states, waiting } : null,
    },
    menu: {
      give: give && view.assignLabel !== null,
      takeBack: give && view.takeBack,
      handBack: change && view.handBackTo !== null,
      drop: change && !view.closed && offer.drop,
    },
  };
}

export type KinTaskPageStatus = NonNullable<ReturnType<typeof kinTaskControls>["page"]["status"]>;

function stepFor(input: NextStepInput): Omit<KinNextStepView, "waiting"> {
  const { item, view, names, now } = input;
  const to = (state: KinRecordDetail["state"]) => input.change && view.can.states.includes(state);
  const giveAct =
    input.give && view.can.give ? [{ id: "give" as const, label: view.assignLabel ?? "" }] : [];
  const holder = kinRecordWho(item.owner, names);
  const due = kinWorkDueText(item, names, now);
  const toldLater =
    item.toldWhenBack === undefined
      ? null
      : KIN_TASK_RECORD.toldWhenBack(holder.name, kinAwayDay(item.toldWhenBack, now));
  // A task waiting on this viewer never tells them nothing is needed: it says what it waits on.
  const waitsOnMe =
    item.state === "waiting" && item.waitingOn !== null && isMe(item.waitingOn, names);
  const nothingNeeded = waitsOnMe ? `${view.status}.` : KIN_TASK_RECORD.nothingNeeded;
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
      note: acts.length === 0 ? nothingNeeded : null,
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
      note: toldLater ?? (giveAct.length === 0 || waitsOnMe ? nothingNeeded : null),
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
      note: nothingNeeded,
      acts: [],
    };
  }
  const waiting =
    item.state === "waiting" &&
    !(item.waitingOn !== null && samePrincipal(item.waitingOn, item.owner));
  return {
    kind: "held",
    who: holder,
    line: waiting ? view.status.replace(/^Waiting/, "is waiting") : "has this",
    when: due === null ? null : `due ${due}`,
    words: null,
    // The line already says it waits on this viewer.
    note: toldLater ?? (waitsOnMe ? null : KIN_TASK_RECORD.nothingNeeded),
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

/**
 * One line of a task's Activity: a change, with what it replaced beside what it became, or a
 * note someone left, with its files.
 */
export interface KinActivityLine {
  readonly key: string;
  readonly icon: KinActivityIcon | "comment";
  /** Set in bold ahead of `text`; null when the line names nobody first. */
  readonly who: string | null;
  readonly text: string;
  readonly when: string;
  readonly before: string | null;
  readonly after: string | null;
  /** An agent that did it for `who`, or their coding-agent key: "via Chief of staff". */
  readonly via: string | null;
  /** A note's own words and files; null on a change. */
  readonly comment: {
    readonly commentId: string;
    readonly body: string;
    readonly files: ReadonlyArray<KinAttachment>;
    readonly removed: boolean;
    readonly canRemove: boolean;
  } | null;
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

function changeLine(change: KinRecordChange, names: KinWorkNames, now: Date): KinActivityLine {
  const full = kinWorkChangeText(change, names, now, "work", "brief");
  const actor = kinWorkActorName(change.by, names);
  const named = full.startsWith(`${actor} `);
  // An agent acting for a person: the person did it, through the agent.
  const asker = change.by._tag === "agent" && named ? change.askedBy : undefined;
  return {
    key: `change:${change.seq}`,
    icon: changeIcon(change),
    who:
      asker !== undefined
        ? kinWorkActorName({ _tag: "person", personId: asker }, names)
        : named
          ? actor
          : null,
    text: named ? full.slice(actor.length + 1) : full,
    when: formatKinTime(new Date(change.at), now),
    ...beforeAfter(change, names, now),
    via:
      asker !== undefined
        ? actor
        : named && change.by._tag === "person"
          ? (change.codingAgent ?? null)
          : null,
    comment: null,
  };
}

function commentLine(comment: KinRecordComment, names: KinWorkNames, now: Date): KinActivityLine {
  const removed = comment.removed !== undefined;
  return {
    key: `comment:${comment.commentId}`,
    icon: "comment",
    who: kinWorkActorName(comment.by, names),
    text: removed ? KIN_TASK_RECORD.removed : "",
    when: formatKinTime(new Date(comment.at), now),
    before: null,
    after: null,
    via: comment.by._tag === "person" ? (comment.codingAgent ?? null) : null,
    comment: {
      commentId: comment.commentId,
      body: comment.body,
      files: comment.files,
      removed,
      canRemove: comment.canRemove === true,
    },
  };
}

/**
 * A task's Activity: its changes and notes in one thread, oldest first, each with who, when and
 * what moved. A note and a change at the same moment read change first.
 */
export function kinTaskActivity(
  item: Pick<KinRecordDetail, "changes" | "comments">,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinActivityLine> {
  const lines = [
    ...[...item.changes].reverse().map((change) => ({
      at: Date.parse(change.at),
      order: 0,
      line: changeLine(change, names, now),
    })),
    ...(item.comments ?? []).map((comment) => ({
      at: Date.parse(comment.at),
      order: 1,
      line: commentLine(comment, names, now),
    })),
  ];
  return lines
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.at - b.at || a.order - b.order || a.index - b.index)
    .map((entry) => entry.line);
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
