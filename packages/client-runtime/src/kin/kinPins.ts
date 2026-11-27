import { formatKinWhen, type KinChatPin, type KinRecordKey } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { kinWorkDueDays, kinWorkDueZone, type KinWorkNames } from "./kinWork.ts";

export type KinPinZones = Pick<KinWorkNames, "zone" | "readerZone">;

export interface KinPinView {
  readonly title: string;
  readonly line: string | null;
  readonly tone: "normal" | "late" | "muted";
  readonly opens: { readonly kind: "task" | "project" | "goal"; readonly key: KinRecordKey } | null;
}

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
