import type {
  KinChatSummary,
  KinOpenRead,
  KinOrgId,
  KinPulseScreenRead,
  KinWaitingItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { kinCount } from "./kinCount.ts";
import type { KinInboxState } from "./kinInboxModel.ts";
import type { KinInboxScreenState } from "./kinScreenState.ts";
import { kinTasksDealFactsOf } from "./kinTasksList.ts";
import { kinWorkDueText, type KinWorkNames } from "./kinWork.ts";
import { kinNeedsWaitingRow, type KinNeedsYouRow } from "./kinWorkHome.ts";

/**
 * Every place that shows or counts what waits on a person reads one list, the host's
 * `kin.open.subscribe`: each shows a filter of it, and each count is the count of that filter.
 */

/** The list as a pulse page of its facts, for the screens that draw facts (`kinAttention`). */
export function kinOpenFacts(read: KinOpenRead): KinPulseScreenRead {
  const facts = read.rows.flatMap((row) => (row.item._tag === "fact" ? [row.item.fact] : []));
  return { asOf: read.asOf, total: facts.length, facts };
}

/** What waits in chats, the viewer's own and others' to look at, in the list's order. */
export const kinOpenWaitingItems = (read: KinOpenRead): ReadonlyArray<KinWaitingItem> =>
  read.rows.flatMap((row) => (row.item._tag === "waiting" ? [row.item.waiting] : []));

const inboxCache = new WeakMap<KinInboxState, WeakMap<KinOpenRead, KinInboxState>>();

/**
 * The inbox with this org's waiting rows taken from the list, so Waiting on you, its banner and
 * the chats it marks Needs you show the list's. Unchanged while there is no list (an older host),
 * or when the host's row cap cut some of the viewer's cards: the inbox holds every one.
 */
export function kinInboxWithOpen(
  inbox: KinInboxState,
  orgId: KinOrgId | null,
  read: KinOpenRead | null | undefined,
): KinInboxState {
  if (read == null || orgId === null) return inbox;
  const held = inboxCache.get(inbox)?.get(read);
  if (held !== undefined) return held;
  const items = kinOpenWaitingItems(read);
  if (items.filter((item) => item.waitsFor === undefined).length < read.counts.waiting)
    return inbox;
  const next: KinInboxState = {
    ...inbox,
    waiting: [...inbox.waiting.filter((item) => item.orgId !== orgId), ...items],
  };
  const byRead = inboxCache.get(inbox) ?? new WeakMap<KinOpenRead, KinInboxState>();
  byRead.set(read, next);
  inboxCache.set(inbox, byRead);
  return next;
}

/** `kinInboxWithOpen` on a screen's inbox, once it is ready. */
export function kinInboxScreenWithOpen(
  state: KinInboxScreenState,
  orgId: KinOrgId | null,
  read: KinOpenRead | null | undefined,
): KinInboxScreenState {
  if (state._tag !== "ready") return state;
  const value = kinInboxWithOpen(state.inbox.value, orgId, read);
  return value === state.inbox.value ? state : { ...state, inbox: { ...state.inbox, value } };
}

/**
 * The Tasks badge and Tasks' Needs you heading: the list's tasks Tasks counts and its deal facts
 * (`kinNeedsYouCount`). Null from a host whose list doesn't count Tasks' tasks.
 */
export function kinOpenTasksCount(
  read: KinOpenRead,
  viewer: { readonly ownerLevel: boolean; readonly me: string | null },
): number | null {
  if (read.counts.tasks === undefined) return null;
  return read.counts.tasks + kinTasksDealFactsOf(kinOpenFacts(read), viewer).length;
}

/**
 * Needs attention, or On me, from the list: its facts as attention rows (`facts`), and its tasks,
 * overdue money and what waits on the viewer as rows, in the list's order. `owed` is Money's own
 * row for overdue invoices, in Money's words, when Money has been read. `hidden` counts what the
 * host counted past the rows it sent.
 */
export function kinOpenNeeds(
  read: KinOpenRead,
  input: {
    readonly owed: KinNeedsYouRow | null;
    readonly chats: ReadonlyArray<KinChatSummary>;
    readonly agentNames: ReadonlyMap<string, string>;
    readonly names: KinWorkNames;
    readonly now: Date;
  },
): {
  readonly facts: KinPulseScreenRead;
  readonly needs: ReadonlyArray<KinNeedsYouRow>;
  readonly hidden: number;
} {
  const needs: Array<KinNeedsYouRow> = [];
  let sent = 0;
  for (const row of read.rows) {
    const { item } = row;
    if (item._tag === "waiting" && item.waiting.waitsFor !== undefined) continue;
    sent += 1;
    if (item._tag === "task") {
      const day = kinWorkDueText(
        {
          dueAt: item.dueAt === undefined ? null : DateTime.formatIso(item.dueAt),
          dueAllDay: item.dueAllDay === true,
        },
        input.names,
        input.now,
      );
      needs.push({
        id: row.id,
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
      });
    } else if (item._tag === "money")
      needs.push(
        input.owed ?? {
          id: row.id,
          kind: "money",
          title: "Invoices overdue",
          detail: kinCount(item.invoices, "invoice"),
          late: true,
          open: { type: "money" },
        },
      );
    else if (item._tag === "waiting")
      needs.push(kinNeedsWaitingRow(item.waiting, input.chats, input.agentNames));
  }
  return {
    facts: kinOpenFacts(read),
    needs,
    hidden: Math.max(0, read.counts.needsYou - sent),
  };
}

/**
 * Needs attention as a screen reads it, its open facts the list's: what was handled or set aside,
 * and what the host counted past its cap, stay the attention read's, since none of them waits.
 */
export function kinOpenAttention(
  read: KinPulseScreenRead | null,
  open: KinOpenRead,
): KinPulseScreenRead | null {
  if (read === null) return null;
  const kept = read.facts.filter(
    (fact) => fact.handled !== null || fact.sense === "sense_overflow",
  );
  const facts = [...kinOpenFacts(open).facts, ...kept];
  return { ...read, total: facts.length, facts };
}

/**
 * The list as it stands once these facts were answered here: they leave at once, with their
 * count, until the host's list says where they stand now.
 */
export function kinOpenShown(read: KinOpenRead, answered: ReadonlySet<string>): KinOpenRead {
  if (answered.size === 0) return read;
  const rows = read.rows.filter(
    (row) => row.item._tag !== "fact" || !answered.has(row.item.fact.key),
  );
  if (rows.length === read.rows.length) return read;
  return {
    ...read,
    rows,
    counts: {
      ...read.counts,
      needsYou: Math.max(0, read.counts.needsYou - (read.rows.length - rows.length)),
    },
  };
}
