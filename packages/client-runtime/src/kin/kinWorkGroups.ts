// @effect-diagnostics globalDate:off - Pure view helpers compare due times with the company's day, outside an Effect runtime.
import type { KinRecord, KinRecordKey, KinWorkPrincipal } from "@t3tools/contracts";

import {
  kinWorkAvatar,
  kinWorkClosed,
  kinWorkDueDays,
  kinWorkName,
  kinWorkPrincipalKey,
  type KinWorkFilter,
  type KinWorkMark,
  type KinWorkNames,
} from "./kinWork.ts";
import { kinTasksBlock } from "./kinAttention.ts";
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
      /** A project's heading opens that project. */
      readonly project?: KinRecordKey;
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
      /** Under "On me", why it leads: late, due today or stuck. */
      readonly mark?: KinWorkMark;
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
  | {
      readonly kind: "project";
      readonly key: KinRecordKey | null;
      readonly title: string | null;
    };

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
 * Why one of your tasks leads "On me": late, then due by the end of today, then handed back to
 * you or stuck waiting.
 */
function kinWorkMark(record: KinRecord, names: KinWorkNames, now: Date): KinWorkMark | null {
  if (kinWorkClosed(record.state)) return null;
  if (record.late) return "late";
  if ((kinWorkDueDays(record, names, now) ?? 1) <= 0) return "today";
  if (record.handedBack !== undefined) return "handed_back";
  return record.state === "waiting" ? "stuck" : null;
}

const MARK_ORDER: Record<KinWorkMark, number> = { late: 0, today: 1, stuck: 2, handed_back: 2 };

/**
 * Tasks as one reader reads them: On me, On others and On agents, each by whom it waits on, then
 * the rest by project. The rows are the ones the list already holds, in its own order, except that
 * On me leads with what is late, due today or stuck, each marked.
 */
export function kinWorkGroups<R extends KinRecord>(
  records: ReadonlyArray<R>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinWorkGroupItem<R>> {
  const mine: Array<R> = [];
  const waits = { others: new Map<string, Array<R>>(), agents: new Map<string, Array<R>>() };
  const whoOf = new Map<string, KinWorkPrincipal>();
  const projects = new Map<
    string,
    { key: KinRecordKey | null; title: string | null; records: Array<R> }
  >();
  for (const record of records) {
    const where = whereOf(record, names);
    if (where.kind === "mine") mine.push(record);
    else if (where.kind === "project") {
      const key = where.key ?? "";
      const held = projects.get(key);
      if (held === undefined)
        projects.set(key, { key: where.key, title: where.title, records: [record] });
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
  const section = (
    kind: KinWorkGroupKind,
    key: string,
    title: string,
    count: number,
    project: KinRecordKey | null = null,
  ) => {
    if (count > 0)
      items.push({
        type: "section",
        key: `section:${key}`,
        kind,
        title,
        count,
        ...(project === null ? {} : { project }),
      });
  };
  section("mine", "mine", KIN_WORK_GROUPS.mine, mine.length);
  const marked = mine.map((record) => ({ record, mark: kinWorkMark(record, names, now) }));
  marked.sort(
    (a, b) =>
      (a.mark === null ? 3 : MARK_ORDER[a.mark]) - (b.mark === null ? 3 : MARK_ORDER[b.mark]),
  );
  for (const { record, mark } of marked)
    items.push({
      type: "task",
      key: record.key,
      record,
      section: "mine",
      ...(mark === null ? {} : { mark }),
    });
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
      project.key,
    );
    tasks(project.records, "project");
  }
  return items;
}

/**
 * The top of Tasks and the list under it, each task under one heading: yours stay in "On me" and
 * leave the owner's block; a task the block shows leaves the list below. Null `block` for anyone
 * but the owner and a co-owner, and whenever it would be empty.
 */
export function kinTasksTop<R extends KinRecord>(
  input: Omit<Parameters<typeof kinTasksBlock>[0], "onMe"> & {
    readonly records: ReadonlyArray<R>;
    readonly names: KinWorkNames;
    readonly now: Date;
  },
): {
  readonly block: ReturnType<typeof kinTasksBlock>;
  readonly items: ReadonlyArray<KinWorkGroupItem<R>>;
} {
  const { records, names, now } = input;
  const onMe = new Set(
    records.filter((record) => whereOf(record, names).kind === "mine").map((record) => record.key),
  );
  const block = kinTasksBlock({ ...input, onMe });
  const inBlock = new Set<string>([
    ...(block?.attention ?? []).flatMap((row) =>
      row.open.type === "record" ? [row.open.key] : [],
    ),
    ...(block?.needs ?? []).flatMap((row) => (row.open.type === "task" ? [row.open.key] : [])),
  ]);
  return {
    block,
    items: kinWorkGroups(
      inBlock.size === 0 ? records : records.filter((record) => !inBlock.has(record.key)),
      names,
      now,
    ),
  };
}
