import type { KinRecord, KinWorkPrincipal } from "@t3tools/contracts";

import {
  kinWorkAvatar,
  kinWorkName,
  kinWorkPrincipalKey,
  type KinWorkFilter,
  type KinWorkNames,
} from "./kinWork.ts";
import type { KinAvatarView } from "./kinScreenState.ts";

/** What Tasks says over each part of the list, the same on web and phone. */
const KIN_WORK_GROUPS = {
  mine: "On me",
  others: "On others",
  agents: "On agents",
  noProject: "Not in a project",
} as const;

export type KinWorkGroupKind = "mine" | "others" | "agents" | "project";

/** One line of the grouped list: a part's heading, whom a run of tasks waits on, or a task. */
export type KinWorkGroupItem<R extends KinRecord> =
  | {
      readonly type: "section";
      readonly key: string;
      readonly kind: KinWorkGroupKind;
      readonly title: string;
      readonly count: number;
    }
  | {
      readonly type: "who";
      readonly key: string;
      readonly name: string;
      readonly avatar: KinAvatarView;
      readonly count: number;
    }
  | {
      readonly type: "task";
      readonly key: string;
      readonly record: R;
      /** The part it is under; under its project's heading the row needn't name the project. */
      readonly section: KinWorkGroupKind | null;
    };

/** What a task's row needn't repeat under its heading (`kinWorkRow`'s `within`). */
export const kinWorkGroupWithin = <R extends KinRecord>(
  item: Extract<KinWorkGroupItem<R>, { readonly type: "task" }>,
  filter: KinWorkFilter,
): KinWorkFilter =>
  item.section === "project" && item.record.project !== undefined
    ? { ...filter, project: { key: item.record.project.key, title: item.record.project.title } }
    : filter;

/** Whether the list groups: only the plain list, not one narrowed by a filter or a search. */
export const kinWorkGroupsShown = (
  filter: Pick<KinWorkFilter, "owner" | "party" | "project" | "text">,
  me: KinWorkNames["me"],
) =>
  me !== null &&
  filter.owner === null &&
  filter.party === null &&
  filter.project === null &&
  filter.text.trim() === "";

type Where =
  | { readonly kind: "mine" }
  | { readonly kind: "others" | "agents"; readonly who: KinWorkPrincipal }
  | { readonly kind: "project"; readonly key: string | null; readonly title: string | null };

const isMe = (who: KinWorkPrincipal, names: KinWorkNames) =>
  who._tag === "person" && who.personId === names.me;

/**
 * Where a task sits for this reader. On me: they hold it. On others or On agents: someone else
 * holds what they gave, or what they hold waits on someone else. The rest by project.
 */
const whereOf = (record: KinRecord, names: KinWorkNames): Where => {
  const waitingOn = record.state === "waiting" ? record.waitingOn : null;
  const mine = isMe(record.owner, names);
  const waiting = waitingOn !== null && !isMe(waitingOn, names) ? waitingOn : null;
  const on = mine
    ? waiting
    : record.givenBy !== undefined && isMe(record.givenBy, names)
      ? record.owner
      : null;
  if (on !== null) return { kind: on._tag === "agent" ? "agents" : "others", who: on };
  if (mine) return { kind: "mine" };
  return {
    kind: "project",
    key: record.project?.key ?? null,
    title: record.project?.title ?? null,
  };
};

/**
 * Tasks as one reader reads them: On me, On others and On agents, each by whom it waits on, then
 * the rest by project. The rows are the ones the list already holds, in its own order.
 */
export function kinWorkGroups<R extends KinRecord>(
  records: ReadonlyArray<R>,
  names: KinWorkNames,
): ReadonlyArray<KinWorkGroupItem<R>> {
  const mine: Array<R> = [];
  const waits = { others: new Map<string, Array<R>>(), agents: new Map<string, Array<R>>() };
  const whoOf = new Map<string, KinWorkPrincipal>();
  const projects = new Map<string, { title: string | null; records: Array<R> }>();
  for (const record of records) {
    const where = whereOf(record, names);
    if (where.kind === "mine") mine.push(record);
    else if (where.kind === "project") {
      const key = where.key ?? "";
      const held = projects.get(key);
      if (held === undefined) projects.set(key, { title: where.title, records: [record] });
      else held.records.push(record);
    } else {
      const key = kinWorkPrincipalKey(where.who);
      whoOf.set(key, where.who);
      const held = waits[where.kind].get(key);
      if (held === undefined) waits[where.kind].set(key, [record]);
      else held.push(record);
    }
  }
  const items: Array<KinWorkGroupItem<R>> = [];
  const tasks = (rows: ReadonlyArray<R>, section: KinWorkGroupKind) => {
    for (const record of rows) items.push({ type: "task", key: record.key, record, section });
  };
  const section = (kind: KinWorkGroupKind, key: string, title: string, count: number) => {
    if (count > 0) items.push({ type: "section", key: `section:${key}`, kind, title, count });
  };
  section("mine", "mine", KIN_WORK_GROUPS.mine, mine.length);
  tasks(mine, "mine");
  for (const kind of ["others", "agents"] as const) {
    const held = [...waits[kind]].map(([key, rows]) => ({
      key,
      rows,
      name: kinWorkName(whoOf.get(key)!, names),
    }));
    // Whoever holds up the most first, then by name.
    held.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
    section(
      kind,
      kind,
      KIN_WORK_GROUPS[kind],
      held.reduce((sum, one) => sum + one.rows.length, 0),
    );
    for (const one of held) {
      items.push({
        type: "who",
        key: `${kind}:${one.key}`,
        name: one.name,
        avatar: kinWorkAvatar(whoOf.get(one.key)!),
        count: one.rows.length,
      });
      tasks(one.rows, kind);
    }
  }
  const byProject = [...projects].sort(([a, x], [b, y]) =>
    a === "" ? 1 : b === "" ? -1 : (x.title ?? "").localeCompare(y.title ?? ""),
  );
  for (const [key, project] of byProject) {
    section(
      "project",
      `project:${key}`,
      project.title ?? KIN_WORK_GROUPS.noProject,
      project.records.length,
    );
    tasks(project.records, "project");
  }
  return items;
}
