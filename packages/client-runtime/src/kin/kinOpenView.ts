import type {
  KinChatSummary,
  KinOpenRead,
  KinPulseFact,
  KinPulseScreenRead,
  KinWaitingItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import {
  kinAttention,
  kinTasksAttention,
  kinTasksBadgeCount,
  type KinAttentionRow,
} from "./kinAttention.ts";
import { kinWorkDueText, type KinWorkNames } from "./kinWork.ts";
import { kinNeedsYou, type KinNeedsYouRow } from "./kinWorkHome.ts";

/**
 * The host's list of open things (`kin.open.subscribe`) as the screens draw it: one count for every
 * badge, and the rows Needs you and the Tasks block already know how to draw. Null `open` is a host
 * that doesn't stream it, where today's reads stand.
 */

/** The Tasks badge: every open thing, or today's count on a host without the open list. */
export const kinOpenBadge = (input: {
  readonly open: KinOpenRead | null;
  readonly ownerLevel: boolean;
  readonly attention: KinPulseScreenRead | null;
  readonly mineDue: ReadonlyArray<unknown> | null;
}) => (input.open === null ? kinTasksBadgeCount(input) : input.open.counts.needsYou);

/** `read` less the facts answered on this device, as `kinAttentionShown` does for the pulse's. */
export function kinOpenShown(read: KinOpenRead, answered: ReadonlySet<string>): KinOpenRead {
  if (answered.size === 0) return read;
  const rows = read.rows.filter(
    (row) => !(row.item._tag === "fact" && answered.has(row.item.fact.key)),
  );
  const gone = read.rows.length - rows.length;
  if (gone === 0) return read;
  return {
    ...read,
    counts: { ...read.counts, needsYou: Math.max(0, read.counts.needsYou - gone) },
    rows,
  };
}

/** What waits on the viewer in chats, oldest first, for Waiting on you (`selectKinInboxView`). */
export const kinOpenWaiting = (read: KinOpenRead): ReadonlyArray<KinWaitingItem> =>
  read.rows.flatMap((row) => (row.item._tag === "waiting" ? [row.item.waiting] : []));

const sameItems = (
  a: ReadonlyArray<KinWaitingItem> | null,
  b: ReadonlyArray<KinWaitingItem> | null,
) =>
  a === b ||
  (a !== null && b !== null && a.length === b.length && a.every((item, i) => item === b[i]));

/**
 * `kinOpenWaiting` of `read`, null where it isn't read. Held rows keep their objects across a
 * change, so a change elsewhere in the list leaves this value the same reference.
 */
export const kinOpenWaitingAtom = (read: Atom.Atom<KinOpenRead | null | undefined>) =>
  Atom.make((get): ReadonlyArray<KinWaitingItem> | null => {
    const open = get(read);
    return open == null ? null : kinOpenWaiting(open);
  }).pipe(Atom.withEquality(sameItems), Atom.withLabel("kin:open:waiting"));

/**
 * Needs you's rows from the open list, in its order, shaped as `kinTasksBlock` takes them: facts
 * as attention rows with money facts as one Money row, then tasks, overdue invoices and waiting.
 * `hidden` is what the host counted past the rows it sent, so the block's total is `needsYou`.
 */
export function kinOpenNeeds(
  read: KinOpenRead,
  input: {
    readonly names: KinWorkNames;
    readonly chats: ReadonlyArray<KinChatSummary>;
    readonly agentNames: ReadonlyMap<string, string>;
    readonly now: Date;
  },
): {
  readonly attention: ReadonlyArray<KinAttentionRow>;
  readonly needs: ReadonlyArray<KinNeedsYouRow>;
  readonly hidden: number;
  /** The open list carries no handled facts; their Undo stays with the pulse's own read. */
  readonly handled: ReadonlyArray<KinAttentionRow>;
} {
  const facts: Array<KinPulseFact> = [];
  for (const row of read.rows) if (row.item._tag === "fact") facts.push(row.item.fact);
  const { open } = kinAttention(
    { asOf: read.asOf, total: facts.length, facts },
    {
      scope: { type: "all" },
      names: new Map([...input.names.agents, ...input.names.people]),
      now: input.now,
    },
  );
  const split = kinTasksAttention(open);
  const waitingRows = new Map(
    kinNeedsYou({
      mine: [],
      money: null,
      lists: [],
      waiting: kinOpenWaiting(read),
      chats: input.chats,
      agentNames: input.agentNames,
      names: input.names,
      now: input.now,
    }).map((row) => [row.id, row]),
  );
  const needs = read.rows.flatMap((row): ReadonlyArray<KinNeedsYouRow> => {
    const { item } = row;
    switch (item._tag) {
      case "fact":
        return [];
      case "waiting": {
        const one = waitingRows.get(`waiting:${item.waiting.waitingId}`);
        return one === undefined ? [] : [one];
      }
      case "task": {
        const day = kinWorkDueText(
          { dueAt: DateTime.formatIso(item.dueAt), dueAllDay: item.dueAllDay === true },
          input.names,
          input.now,
        );
        return [
          {
            id: `task:${item.key}`,
            kind: "task",
            title: item.title,
            detail: [
              item.key,
              item.projectTitle ?? item.clientTitle ?? null,
              row.late ? "Late" : null,
              day === null ? null : `Due ${day}`,
            ]
              .filter((part) => part !== null)
              .join(" · "),
            late: row.late,
            open: { type: "task", key: item.key },
          },
        ];
      }
      case "money":
        return [
          {
            id: "money:overdue",
            kind: "money",
            title: "Invoices overdue",
            detail:
              item.invoices === 1 ? "1 invoice past due" : `${item.invoices} invoices past due`,
            late: true,
            open: { type: "money" },
          },
        ];
    }
  });
  return {
    attention: split.rows,
    needs: split.moneyRow === null ? needs : [split.moneyRow, ...needs],
    hidden: Math.max(0, read.counts.needsYou - read.rows.length),
    handled: [],
  };
}
