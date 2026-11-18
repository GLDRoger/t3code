import type { KinPersonId } from "./kinChat.ts";
import type { KinRecordState, KinWorkMoveGroup, KinWorkPrincipal } from "./kinWork.ts";

/** What decides whose move an open task is, read the same from a list row or a record. */
export interface KinWorkMoveFacts {
  readonly state: KinRecordState;
  readonly owner: KinWorkPrincipal;
  readonly waitingOn: KinWorkPrincipal | null;
  readonly late: boolean;
  /** False while an agent only suggested it. */
  readonly confirmed: boolean;
  /** The person on record as asking for it, when one is. */
  readonly askedBy: KinPersonId | null;
  readonly givenBy: KinWorkPrincipal | null;
  /** A draft to send or a question about it waits on the reader in a chat they read. */
  readonly card: boolean;
}

const isPerson = (who: KinWorkPrincipal | null, personId: KinPersonId) =>
  who !== null && who._tag === "person" && who.personId === personId;

/**
 * Whose move an open task is for this reader; null once it is closed. Needs you: a card waits on
 * them, a suggestion waits for their keep (owner level), it waits on them, they hold it, or it is
 * late with someone they asked. Waiting: they asked someone, or what they hold waits on someone.
 */
export function kinWorkMove(
  task: KinWorkMoveFacts,
  reader: { readonly personId: KinPersonId; readonly ownerLevel: boolean },
): KinWorkMoveGroup | null {
  if (task.state === "done" || task.state === "dropped") return null;
  const me = reader.personId;
  if (task.card) return "needsYou";
  if (!task.confirmed && reader.ownerLevel) return "needsYou";
  const waitingOn = task.state === "waiting" ? task.waitingOn : null;
  if (isPerson(waitingOn, me)) return "needsYou";
  if (isPerson(task.owner, me)) return waitingOn !== null && !task.late ? "waiting" : "needsYou";
  if (task.askedBy === me || isPerson(task.givenBy, me)) return task.late ? "needsYou" : "waiting";
  return "rest";
}

/** Inside a group: late first, then soonest due, then no date; then oldest, then key. */
export function kinWorkMoveOrder(
  a: {
    readonly late: boolean;
    readonly dueMs: number | null;
    readonly createdMs: number;
    readonly key: string;
  },
  b: {
    readonly late: boolean;
    readonly dueMs: number | null;
    readonly createdMs: number;
    readonly key: string;
  },
): number {
  if (a.late !== b.late) return a.late ? -1 : 1;
  if (a.dueMs !== b.dueMs) {
    if (a.dueMs === null) return 1;
    if (b.dueMs === null) return -1;
    return a.dueMs - b.dueMs;
  }
  if (a.createdMs !== b.createdMs) return a.createdMs - b.createdMs;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export const KIN_WORK_MOVE_GROUPS: ReadonlyArray<KinWorkMoveGroup> = [
  "needsYou",
  "waiting",
  "rest",
];
