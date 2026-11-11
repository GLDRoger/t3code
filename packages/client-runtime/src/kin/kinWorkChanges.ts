import type {
  KinOrgId,
  KinRecord,
  KinRecordDetail,
  KinRecordKey,
  KinRecordSide,
  KinRecordState,
  KinWorkAssignInput,
  KinWorkConfirmInput,
  KinWorkPrincipal,
  KinWorkUpdateInput,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_NOTES_MAX,
  KIN_WORK_TITLE_MAX,
  kinWorkClosed,
  kinWorkName,
  kinWorkSamePrincipal,
  kinWorkSettled,
  type KinWorkChangeResult,
  type KinWorkNames,
  type KinWorkRef,
} from "./kinWork.ts";
import type { KinWorkLive } from "./kinWorkStream.ts";

/** One thing the owner does to a task. */
export type KinWorkAction =
  | {
      readonly type: "state";
      readonly state: KinRecordState;
      /** Who it waits on, with `waiting`. */
      readonly waitingOn?: KinWorkPrincipal | null;
    }
  /** A calendar day, `YYYY-MM-DD`; null takes the date off. */
  | { readonly type: "due"; readonly day: string | null }
  /** Only what the owner retyped, so a lead's change to the other field stays. */
  | { readonly type: "edit"; readonly title?: string; readonly notes?: string }
  /** Keep a lead's suggestion, or say no to it. */
  | { readonly type: "confirm" }
  | { readonly type: "decline" }
  | { readonly type: "give"; readonly to: KinWorkPrincipal }
  | { readonly type: "takeBack" }
  /** Which client and project it belongs to, and whose move it is. Null takes one off. */
  | {
      readonly type: "place";
      readonly party?: KinWorkRef | null;
      readonly project?: KinWorkRef | null;
      readonly side?: KinRecordSide;
    }
  /** The task's own label; its client or project can still keep it private. */
  | { readonly type: "private"; readonly private: boolean };

export const KIN_WORK_OFFLINE_CHANGE = "You're offline. Changes need a connection.";
export const KIN_WORK_EDIT_CHANGED =
  "This changed while you were looking at it. The latest is shown and your edit is still here. Save again to keep it.";

export const KIN_WORK_COPY = {
  done: "Mark done",
  reopen: "Reopen",
  status: "Status",
  drop: "Drop it",
  waitingOn: "Waiting on",
  waitingOnNobody: "No one in particular",
  takeBack: "Take it back",
  keep: "Keep",
  decline: "Not needed",
  edit: "Edit",
  editTitle: "Edit task",
  save: "Save",
  cancel: "Cancel",
  saving: "Saving…",
  undo: "Undo",
  noDate: "No date",
  pickDate: "Pick a date",
  openThread: "Open thread",
};

export const KIN_WORK_STATE_CHOICES: ReadonlyArray<{
  readonly state: "open" | "doing";
  readonly label: string;
}> = [
  { state: "open", label: "Not started" },
  { state: "doing", label: "In progress" },
];

type Patch = Partial<
  Pick<
    KinRecordDetail,
    | "state"
    | "waitingOn"
    | "owner"
    | "dueAt"
    | "dueAllDay"
    | "confirmed"
    | "title"
    | "notes"
    | "late"
    | "working"
    | "side"
    | "sensitive"
  >
>;

export interface KinWorkNotice {
  readonly key: KinRecordKey;
  /** `saved` went through; `conflict` was refused because the task had moved on. */
  readonly kind: "saved" | "failed" | "conflict" | "offline";
  readonly text: string;
  /** The way back from a change that closed or dropped something. */
  readonly undo: KinWorkAction | null;
}

export interface KinWorkEdit {
  readonly key: KinRecordKey;
  readonly title: string;
  readonly notes: string;
  /** What the task said when the owner started typing. */
  readonly from: { readonly title: string; readonly notes: string };
}

export interface KinWorkChangesState {
  /** What the owner just asked for, shown as done while the host answers, by task. */
  readonly pending: Readonly<Record<string, Patch>>;
  /** The host's last answer for each task changed here, shown until a read catches up. */
  readonly answers: Readonly<Record<string, KinRecordDetail>>;
  /** The title and notes being typed. Kept through a refusal, so nothing typed is lost. */
  readonly edit: KinWorkEdit | null;
  readonly notice: KinWorkNotice | null;
}

const KIN_WORK_NO_CHANGES: KinWorkChangesState = {
  pending: {},
  answers: {},
  edit: null,
  notice: null,
};

const editOf = (item: KinRecordDetail): KinWorkEdit => ({
  key: item.key,
  title: item.title,
  notes: item.notes,
  from: { title: item.title, notes: item.notes },
});

/**
 * What the task says now where that differs from what the owner started typing over, so a form
 * can show someone else's change beside the owner's own words. Null where nothing moved.
 */
export const kinWorkEditMoved = (
  edit: KinWorkEdit,
  item: Pick<KinRecordDetail, "title" | "notes">,
): { readonly title: string | null; readonly notes: string | null } => ({
  title: item.title === edit.from.title ? null : item.title,
  notes: item.notes === edit.from.notes ? null : item.notes.trim() || "No notes.",
});

/** Where the changes start: nothing done, and a form already typing over `editing` if given. */
export const kinWorkChangesStart = (editing?: KinRecordDetail): KinWorkChangesState =>
  editing === undefined ? KIN_WORK_NO_CHANGES : { ...KIN_WORK_NO_CHANGES, edit: editOf(editing) };

/**
 * What a list says above its rows: a change that failed, or one with a way back. A change that
 * simply worked shows in the row itself, and the task's own sheet says the rest while it is open.
 */
export const kinWorkListNotice = (
  state: KinWorkChangesState,
  openKey: KinRecordKey | null,
): KinWorkNotice | null => {
  const { notice } = state;
  return notice !== null &&
    notice.key !== openKey &&
    (notice.kind !== "saved" || notice.undo !== null)
    ? notice
    : null;
};

/** A task as the owner should see it now: the host's newest word, then what is being saved. */
export function kinWorkApplied<R extends KinRecord>(record: R, state: KinWorkChangesState): R {
  const answer = state.answers[record.key];
  const base: R =
    answer !== undefined && answer.rev > record.rev ? { ...record, ...answer } : record;
  const pending = state.pending[record.key];
  return pending === undefined ? base : { ...base, ...pending };
}

const stops = (record: KinRecord, action: KinWorkAction): boolean => {
  if (record.owner._tag !== "agent" || kinWorkClosed(record.state)) return false;
  switch (action.type) {
    case "state":
      return kinWorkClosed(action.state);
    case "give":
      return !kinWorkSamePrincipal(record.owner, action.to);
    case "decline":
    case "takeBack":
      return true;
    default:
      return false;
  }
};

/** What happened, in a few words, once the host says it did. */
function savedText(record: KinRecord, action: KinWorkAction, names: KinWorkNames): string {
  const holder = kinWorkName(record.owner, names);
  const told = stops(record, action) ? ` ${holder} was told to stop.` : "";
  switch (action.type) {
    case "state":
      if (action.state === "done") return `Marked done.${told}`;
      if (action.state === "dropped") return `Dropped.${told}`;
      if (kinWorkClosed(record.state))
        return record.owner._tag === "agent" ? `Reopened. ${holder} has it again.` : "Reopened.";
      if (action.state === "doing") return "Marked in progress.";
      if (action.state === "open") return "Back to not started.";
      return action.waitingOn == null
        ? "Marked waiting."
        : `Waiting on ${kinWorkName(action.waitingOn, names, "you")}.`;
    case "due":
      return action.day === null ? "Due date removed." : "Due date changed.";
    case "edit":
      return "Saved.";
    case "confirm":
      return "Kept.";
    case "decline":
      return `Dropped.${told}`;
    case "give":
      return `Given to ${kinWorkName(action.to, names, "you")}.${told}`;
    case "takeBack":
      return `It's yours again.${told}`;
    case "place":
      if (action.party != null) return `Now under ${action.party.title}.`;
      if (action.project != null) return `Now in ${action.project.title}.`;
      if (action.side !== undefined)
        return action.side === "theirs" ? "Marked as theirs to do." : "Marked as ours to do.";
      return action.party === null ? "Taken off its client." : "Taken out of its project.";
    case "private":
      return action.private ? "Kept private." : "No longer private.";
  }
}

/** Closing has a way back: to where the task stood. Nothing else needs one. */
const undoOf = (record: KinRecord, action: KinWorkAction): KinWorkAction | null =>
  !kinWorkClosed(record.state) &&
  (action.type === "decline" || (action.type === "state" && kinWorkClosed(action.state)))
    ? { type: "state", state: record.state, waitingOn: record.waitingOn }
    : null;

function patchOf(record: KinRecord, action: KinWorkAction, names: KinWorkNames): Patch {
  switch (action.type) {
    case "state": {
      const closing = kinWorkClosed(action.state);
      return {
        state: action.state,
        waitingOn: action.state === "waiting" ? (action.waitingOn ?? null) : null,
        ...(closing ? { late: false, working: false } : {}),
      };
    }
    case "due":
      return action.day === null
        ? { dueAt: null, dueAllDay: false, late: false }
        : // Midday keeps the picked day the same day in the owner's zone until the host answers.
          { dueAt: `${action.day}T12:00:00.000Z`, dueAllDay: true, late: false };
    case "edit":
      return {
        ...(action.title === undefined ? {} : { title: action.title }),
        ...(action.notes === undefined ? {} : { notes: action.notes }),
      };
    case "confirm":
      return { confirmed: true };
    case "decline":
      return { state: "dropped", late: false, working: false };
    case "give":
      return { owner: action.to, working: false };
    case "takeBack":
      return names.me === null
        ? {}
        : { owner: { _tag: "person", personId: names.me }, working: false };
    case "place":
      // The client and project show once the host answers with them; only the side is known now.
      return action.side === undefined ? {} : { side: action.side };
    case "private":
      return { sensitive: action.private };
  }
}

type Sent = Promise<AtomCommandResult<KinRecordDetail, unknown>>;

/**
 * The owner's changes to tasks, for a list and a task sheet alike. Each shows at once and is
 * taken back if the host refuses; a task that moved on is read again and nothing typed is thrown
 * away. One change per task runs at a time, and none is queued for later.
 */
export function createKinWorkChanges(options: {
  readonly orgId: KinOrgId;
  readonly update: (input: KinWorkUpdateInput) => Sent;
  readonly assign: (input: KinWorkAssignInput) => Sent;
  readonly confirm: (input: KinWorkConfirmInput) => Sent;
  readonly decline: (input: KinWorkConfirmInput) => Sent;
  /** Reads a task again after the host said it had moved on. */
  readonly reread: (key: KinRecordKey) => void;
  readonly online: () => boolean;
  /** A form that opens already typing over this task. */
  readonly editing?: KinRecordDetail;
  readonly onChange: (state: KinWorkChangesState) => void;
}) {
  const { orgId } = options;
  let state = kinWorkChangesStart(options.editing);
  const set = (patch: Partial<KinWorkChangesState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const without = <A>(held: Readonly<Record<string, A>>, key: string) => {
    const { [key]: _gone, ...rest } = held;
    return rest;
  };

  const send = async (record: KinRecord, action: KinWorkAction): Promise<KinWorkChangeResult> => {
    const at = { orgId, key: record.key, rev: record.rev };
    switch (action.type) {
      case "state":
        return kinWorkSettled(
          await options.update({
            ...at,
            state: action.state,
            ...(action.state === "waiting" ? { waitingOn: action.waitingOn ?? null } : {}),
          }),
        );
      case "due":
        return kinWorkSettled(
          await options.update(
            action.day === null
              ? { ...at, dueAt: null }
              : { ...at, dueAt: action.day, dueAllDay: true },
          ),
        );
      case "edit":
        return kinWorkSettled(
          await options.update({
            ...at,
            ...(action.title === undefined ? {} : { title: action.title }),
            ...(action.notes === undefined ? {} : { notes: action.notes }),
          }),
        );
      case "confirm":
        return kinWorkSettled(await options.confirm(at));
      case "decline":
        return kinWorkSettled(await options.decline(at), "decline");
      case "give":
        return kinWorkSettled(await options.assign({ ...at, to: action.to }), "give");
      case "takeBack":
        return kinWorkSettled(await options.assign({ ...at, to: null }), "give");
      case "place":
        return kinWorkSettled(
          await options.update({
            ...at,
            ...(action.party === undefined ? {} : { party: action.party?.key ?? null }),
            ...(action.project === undefined ? {} : { project: action.project?.key ?? null }),
            ...(action.side === undefined ? {} : { side: action.side }),
          }),
        );
      case "private":
        return kinWorkSettled(await options.update({ ...at, sensitive: action.private }));
    }
  };

  /** Makes one change to the task as the owner sees it. Resolves true when the host took it. */
  const run = async (
    record: KinRecord,
    action: KinWorkAction,
    names: KinWorkNames,
  ): Promise<boolean> => {
    const { key } = record;
    if (state.pending[key] !== undefined) return false;
    if (!options.online()) {
      set({ notice: { key, kind: "offline", text: KIN_WORK_OFFLINE_CHANGE, undo: null } });
      return false;
    }
    set({
      pending: { ...state.pending, [key]: patchOf(record, action, names) },
      notice: null,
    });
    const outcome = await send(record, action);
    const pending = without(state.pending, key);
    if (outcome.ok) {
      set({
        pending,
        answers: { ...state.answers, [key]: outcome.item },
        notice: {
          key,
          kind: "saved",
          text: savedText(record, action, names),
          undo: undoOf(record, action),
        },
      });
      return true;
    }
    if (outcome.changed) options.reread(key);
    set({
      pending,
      notice: {
        key,
        kind: outcome.changed ? "conflict" : "failed",
        text: outcome.changed && action.type === "edit" ? KIN_WORK_EDIT_CHANGED : outcome.problem,
        undo: null,
      },
    });
    return false;
  };

  return {
    getState: () => state,
    run,
    /**
     * Takes back the change the notice offers to undo, against the host's answer to it, or
     * `latest` when the screen holds a newer copy. Works after a list has dropped the task.
     */
    undo: (names: KinWorkNames, latest?: KinRecord) => {
      const { notice } = state;
      const answer = notice === null ? undefined : state.answers[notice.key];
      if (notice === null || notice.undo === null || answer === undefined)
        return Promise.resolve(false);
      const record =
        latest !== undefined && latest.key === notice.key && latest.rev > answer.rev
          ? latest
          : answer;
      return run(record, notice.undo, names);
    },
    dismiss: () => set({ notice: null }),
    startEdit: (item: KinRecordDetail) => set({ edit: editOf(item), notice: null }),
    setEdit: (patch: Partial<Pick<KinWorkEdit, "title" | "notes">>) => {
      if (state.edit !== null) set({ edit: { ...state.edit, ...patch } });
    },
    cancelEdit: () => set({ edit: null }),
    /** Saves what was typed over the task as it is now; what was typed stays until it is saved. */
    saveEdit: async (item: KinRecordDetail, names: KinWorkNames): Promise<boolean> => {
      const { edit } = state;
      if (edit === null || edit.key !== item.key) return false;
      const title = edit.title.trim();
      const notes = edit.notes.trim();
      const problem =
        title === ""
          ? "A task needs a title."
          : title.length > KIN_WORK_TITLE_MAX
            ? `Keep the title under ${KIN_WORK_TITLE_MAX} characters.`
            : notes.length > KIN_WORK_NOTES_MAX
              ? "Those notes are too long. Say the rest in chat."
              : null;
      if (problem !== null) {
        set({ notice: { key: item.key, kind: "failed", text: problem, undo: null } });
        return false;
      }
      const retyped = {
        ...(title === edit.from.title.trim() ? {} : { title }),
        ...(notes === edit.from.notes.trim() ? {} : { notes }),
      };
      if (retyped.title === undefined && retyped.notes === undefined) {
        set({ edit: null });
        return true;
      }
      const saved = await run(item, { type: "edit", ...retyped }, names);
      if (saved) set({ edit: null });
      return saved;
    },
  };
}

export type KinWorkChanges = ReturnType<typeof createKinWorkChanges>;

/**
 * Decides when an open task is read again. A change that names another task reads nothing, and
 * neither does one this device already holds the answer to (its own change, usually). A change
 * with no name is read, since it could be this task.
 */
export function createKinWorkItemWatch(options: {
  readonly key: KinRecordKey;
  readonly reread: () => void;
}) {
  let seen: number | null = null;
  return {
    /** Call with each state of Work and the task as held; `held` is null while it is first read. */
    changed: (
      live: Pick<KinWorkLive, "changed" | "unnamed">,
      held: { readonly seq?: number | undefined } | null,
    ) => {
      const named = live.changed[options.key] ?? 0;
      const at = Math.max(named, live.unnamed);
      const first = seen === null;
      if (seen !== null && at <= seen) return;
      seen = at;
      if (held === null) return;
      // On opening, only a change that names this task says the copy held is old.
      const behind = held.seq === undefined ? !first : held.seq < (first ? named : at);
      if (behind) options.reread();
    },
  };
}
