import {
  formatKinWhen,
  type KinChatId,
  type KinChatMember,
  type KinChatPin,
  type KinGoal,
  type KinOrgId,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { kinFailureText } from "./kinAnswers.ts";
import { kinChatListRows } from "./kinChatListRows.ts";
import type { KinInboxView } from "./kinInboxModel.ts";
import type { KinAvatarView, KinDirectory } from "./kinScreenState.ts";
import { kinWorkDueDays, kinWorkDueZone, type KinWorkNames } from "./kinWork.ts";

export type KinPinZones = Pick<KinWorkNames, "zone" | "readerZone">;

export interface KinPinView {
  readonly title: string;
  readonly line: string | null;
  readonly tone: "normal" | "late" | "muted";
  readonly opens: { readonly kind: "task" | "project" | "goal"; readonly key: KinRecordKey } | null;
}

export interface KinPinItem {
  readonly pin: KinChatPin;
  readonly view: KinPinView;
  readonly canUnpin: boolean;
}

export interface KinPinStrip {
  readonly items: ReadonlyArray<KinPinItem>;
  readonly count: number;
  readonly first: KinPinItem | null;
  readonly rest: number;
  readonly more: string | null;
  readonly largeLabel: string;
  readonly canUnpinAny: boolean;
  readonly hasActions: boolean;
}

export interface KinPinnableChat {
  readonly chatId: KinChatId;
  readonly title: string;
  readonly avatar: KinAvatarView;
  readonly company: boolean;
  readonly teamRoom: boolean;
}

/** Shared copy for pinned live cards on web and phone. */
export const KIN_PINS_COPY = {
  stripLabel: "Pinned in this chat",
  sheetTitle: "Pinned in this chat",
  pinToChat: "Pin to a chat",
  unpinFromChat: "Unpin from chat",
  moreCount: (rest: number) => `+${rest}`,
  largeCount: (count: number) => `${count} pinned`,
  noChats: "No chats you can pin to.",
  loadingChats: "Loading chats…",
  pinnedTo: (chatTitle: string) => `Pinned to ${chatTitle}.`,
  pinFailed: "Couldn't pin that.",
  unpinFailed: "Couldn't unpin that.",
  unpinLabel: (title: string) => `Unpin ${title} from chat`,
  openListLabel: (count: number) =>
    count === 1 ? "Show pinned item" : `Show all ${count} pinned items`,
} as const;

const daysText = (days: number) => `${days} ${days === 1 ? "day" : "days"}`;
const lateText = (days: number) => `${daysText(days)} late`;

const taskDue = (days: number) =>
  days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${daysText(days)}`;
const projectDue = (days: number) =>
  days === 0 ? "ends today" : days === 1 ? "ends tomorrow" : `ends in ${daysText(days)}`;

const weekday = (at: string, zone: string | null) =>
  formatKinWhen(DateTime.toEpochMillis(DateTime.makeUnsafe(at)), "weekdayShort", {
    zone: zone ?? undefined,
  });

const stateText = {
  open: "Open",
  doing: "In progress",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
} as const;

const figures = new Intl.NumberFormat("en", { maximumFractionDigits: 3 });

export const kinPinView = (pin: KinChatPin, now: Date, names: KinPinZones): KinPinView => {
  if (pin._tag === "gone")
    return { title: "No longer in Kin", line: null, tone: "muted", opens: null };
  if (pin._tag === "hidden")
    return { title: "A pin you can't open", line: null, tone: "muted", opens: null };

  const title = pin._tag === "project" ? pin.name : pin.title;
  const opens = { kind: pin._tag, key: pin.key };
  if (pin.state === "done" || pin.state === "dropped")
    return { title, line: stateText[pin.state], tone: "muted", opens };

  if (pin._tag === "goal") {
    const unit =
      pin.unit ?? { clients_won: "clients", tasks_done: "tasks", manual: "" }[pin.measure];
    const count = `${figures.format(pin.current)} of ${figures.format(pin.target)}`;
    const progress = unit.length === 0 ? count : `${count} ${unit}`;
    return {
      title,
      line: pin.behind ? `${progress} · behind` : progress,
      tone: pin.behind ? "late" : "normal",
      opens,
    };
  }
  if (pin._tag === "project") {
    const days = kinWorkDueDays({ dueAt: pin.targetAt, dueAllDay: pin.targetAllDay }, names, now);
    const parts = [`${pin.done} of ${pin.total} done`];
    if (pin.late > 0) parts.push(`${pin.late} late`);
    if (days !== null) parts.push(days < 0 ? lateText(-days) : projectDue(days));
    return {
      title,
      line: parts.join(" · "),
      tone: pin.late > 0 || (days !== null && days < 0) ? "late" : "normal",
      opens,
    };
  }

  const days = kinWorkDueDays(pin, names, now);
  const parts = [];
  if (pin.steps !== undefined) parts.push(`${pin.steps.done} of ${pin.steps.total} steps`);
  if (days !== null) {
    const due =
      days < 0
        ? lateText(-days)
        : pin.steps !== undefined && pin.dueAt !== null && days >= 2 && days <= 7
          ? `Due ${weekday(pin.dueAt, kinWorkDueZone(pin.dueAllDay, names))}`
          : taskDue(days);
    parts.push(parts.length === 0 ? due : due.replace(/^Due/, "due"));
  }
  return {
    title,
    line: parts.length === 0 ? stateText[pin.state] : parts.join(" · "),
    tone: pin.late || (days !== null && days < 0) ? "late" : "normal",
    opens,
  };
};

export function kinNextDayStart(now: Date, zones: ReadonlyArray<string | null>): Date | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const zone of new Set(zones)) {
    const zoned = DateTime.makeZoned(now, {
      timeZone: zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (Option.isNone(zoned)) continue;
    const next = DateTime.startOf(DateTime.add(zoned.value, { days: 1 }), "day");
    earliest = Math.min(earliest, DateTime.toEpochMillis(next));
  }
  return Number.isFinite(earliest) ? DateTime.toDateUtc(DateTime.makeUnsafe(earliest)) : null;
}

/** Whether this person holds an active writable membership in the chat. */
export function kinChatMayWritePins(
  members: ReadonlyArray<KinChatMember>,
  personId: string | null,
): boolean {
  if (personId === null) return false;
  return members.some(
    (member) =>
      member.leftAt === null &&
      member.role !== "guest" &&
      member.principal._tag === "person" &&
      member.principal.personId === personId,
  );
}

/** Money goals can't be pinned in a chat; non-Money goals can. */
export const kinGoalPinnable = (goal: Pick<KinGoal, "measure" | "currency">): boolean =>
  goal.measure !== "revenue_received" && goal.currency === undefined;

/** Shapes a chat's pinned list into the strip and popover/sheet model shared by web and phone. */
export function kinPinStrip(
  pins: ReadonlyArray<KinChatPin>,
  views: ReadonlyArray<KinPinView>,
  options: {
    readonly canUnpin: boolean;
    readonly writable: boolean;
    /** Goals live inside Money on web and phone; without Money a pinned goal is a glance only. */
    readonly hasMoney?: boolean;
  },
): KinPinStrip {
  const canOpenGoal = options.hasMoney !== false;
  const items: Array<KinPinItem> = [];
  for (let index = 0; index < pins.length; index += 1) {
    const pin = pins[index];
    const rawView = views[index];
    if (pin === undefined || rawView === undefined) continue;
    const view =
      !canOpenGoal && rawView.opens?.kind === "goal" ? { ...rawView, opens: null } : rawView;
    items.push({
      pin,
      view,
      canUnpin: options.canUnpin && options.writable && pin._tag !== "hidden",
    });
  }
  const count = items.length;
  const rest = Math.max(0, count - 1);
  return {
    items,
    count,
    first: items[0] ?? null,
    rest,
    more: rest > 0 ? KIN_PINS_COPY.moreCount(rest) : null,
    largeLabel: KIN_PINS_COPY.largeCount(count),
    canUnpinAny: items.some((item) => item.canUnpin),
    hasActions: count > 1 || items.some((item) => item.view.opens !== null || item.canUnpin),
  };
}

/** The viewer's active writable chats in this org, in chat-list order. */
export function kinPinnableChats(input: {
  readonly orgId: KinOrgId;
  readonly inbox: KinInboxView;
  readonly directory: KinDirectory;
}): ReadonlyArray<KinPinnableChat> {
  return kinChatListRows(input.inbox, input.directory)
    .filter(
      (row) =>
        row.chat.orgId === input.orgId &&
        row.chat.archivedAt === null &&
        !row.retired &&
        row.chat.members.some(
          (member) =>
            member.leftAt === null &&
            member.role !== "guest" &&
            member.principal._tag === "person" &&
            input.directory.me.has(member.principal.personId),
        ),
    )
    .map((row) => ({
      chatId: row.chat.chatId,
      title: row.view.title ?? "Chat",
      avatar: row.view.avatar,
      company: row.company,
      teamRoom: row.teamRoom,
    }));
}

/** Plain words for a pin or unpin failure, keeping the server's refusal sentence verbatim. */
export const kinPinFailureText = (cause: unknown, action: "pin" | "unpin"): string =>
  kinFailureText(cause, action === "pin" ? KIN_PINS_COPY.pinFailed : KIN_PINS_COPY.unpinFailed);
