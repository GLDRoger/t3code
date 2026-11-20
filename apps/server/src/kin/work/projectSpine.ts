import {
  KinRecordId,
  type KinMilestone,
  type KinMoney,
  type KinOrgId,
  type KinProjectMoney,
  type KinProjectPerson,
  type KinRecord,
  type KinRecordRef,
  type KinSpecChange,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import { latestOf } from "./docs.ts";
import { KinRecords } from "./KinRecords.ts";
import { fieldList, fieldText, parseFields } from "./lists.ts";
import { iso, principal, type RecordRow, selectRecords, toRecord } from "./recordRows.ts";
import { playbookThreshold } from "./playbooks.ts";
import { listDef } from "./registers.ts";
import { seenBy, type KinViewer } from "./teamView.ts";

/**
 * The project spine on read: milestones and their progress, the people on it, its meetings, the
 * tasks whose spec section changed, and its money. Computed from entries every time; nothing stored.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN = ["open", "doing", "waiting"] as const;
const titled = (title: string) => title as KinRecordRef["title"];
const ref = (recordId: string, key: string, title: string): KinRecordRef => ({
  recordId: KinRecordId.make(recordId),
  key,
  title: titled(title),
});

/** `person:<id>` or `agent:<id>`, as `members` and `attendees` store them. */
export const principalOfText = (text: string): KinWorkPrincipal | null => {
  const at = text.indexOf(":");
  return at < 0 ? null : principal(text.slice(0, at), text.slice(at + 1));
};
export const principalText = (who: KinWorkPrincipal) =>
  who._tag === "person" ? `person:${who.personId}` : `agent:${who.agentId}`;
const sameWho = (a: KinWorkPrincipal, b: KinWorkPrincipal) => principalText(a) === principalText(b);

/** A task's milestone, or a milestone's tasks (open first, then by due), for their sheets. */
export const milestoneLinks = Effect.fn("KinProjectSpine.milestoneLinks")(function* (
  row: Pick<RecordRow, "orgId" | "registerId" | "key" | "fieldsJson">,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  if (row.registerId === "work") {
    const key = fieldText(parseFields(row.fieldsJson), "milestone");
    if (key === null) return {};
    const [found] = yield* sql<{ recordId: string; key: string; title: string }>`SELECT
        r.record_id AS "recordId", r.key, r.title FROM kin_records r
      WHERE r.org_id = ${row.orgId} AND r.register_id = 'milestones' AND r.key = ${key}
        AND ${seenBy(sql, viewer)} ORDER BY r.record_id`;
    return found === undefined ? {} : { milestone: ref(found.recordId, found.key, found.title) };
  }
  if (row.registerId !== "milestones") return {};
  const tasks = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${row.orgId} AND r.register_id = 'work'
      AND json_extract(r.fields_json, '$.milestone') = ${row.key} AND ${seenBy(sql, viewer)}
    ORDER BY r.state IN ('done', 'dropped'), r.due_at IS NULL, r.due_at, r.key LIMIT 100`;
  return { tasks };
});

/**
 * The milestone rule: late once its day passed while open; at risk when it is due within the
 * playbook's `milestone_heads_up_days` and one of its open tasks is late or due after it.
 */
export const milestoneRisk = (input: {
  readonly state: string;
  readonly dueAt: number | null;
  readonly now: number;
  readonly headsUpDays: number;
  readonly tasks: ReadonlyArray<{ readonly dueAt: number | null; readonly open: boolean }>;
}) => {
  const open = input.state === "open";
  const late = open && input.dueAt !== null && input.dueAt < input.now;
  const atRisk =
    open &&
    !late &&
    input.dueAt !== null &&
    input.dueAt - input.now <= input.headsUpDays * DAY_MS &&
    input.tasks.some(
      (task) =>
        task.open &&
        task.dueAt !== null &&
        (task.dueAt < input.now || task.dueAt > (input.dueAt ?? Number.POSITIVE_INFINITY)),
    );
  return { late, atRisk };
};

export const milestonesOf = Effect.fn("KinProjectSpine.milestones")(function* (
  orgId: KinOrgId,
  projectId: string,
  now: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    state: KinMilestone["state"];
    dueAt: number | null;
    dueAllDay: number;
    rev: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.state, r.due_at AS "dueAt",
      r.due_all_day AS "dueAllDay", r.rev
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'milestones'
      AND r.project_id = ${projectId} AND ${seenBy(sql, viewer)}
    ORDER BY r.state = 'dropped', r.due_at IS NULL, r.due_at, r.key LIMIT 50`;
  if (rows.length === 0) return [];
  const headsUpDays = (yield* playbookThreshold(orgId, "milestone_heads_up_days")).value;
  const tasks = yield* sql<{ milestone: string; state: string; dueAt: number | null }>`
    SELECT json_extract(r.fields_json, '$.milestone') AS milestone, r.state, r.due_at AS "dueAt"
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
      AND json_extract(r.fields_json, '$.milestone') IN ${sql.in(rows.map((row) => row.key))}
      AND r.state != 'dropped' AND ${seenBy(sql, viewer)}
    ORDER BY r.key`;
  return rows.map((row): KinMilestone => {
    const mine = tasks
      .filter((task) => task.milestone === row.key)
      .map((task) => ({
        dueAt: task.dueAt,
        open: (OPEN as ReadonlyArray<string>).includes(task.state),
      }));
    return {
      ...ref(row.recordId, row.key, row.title),
      state: row.state,
      dueAt: row.dueAt === null ? null : iso(row.dueAt),
      dueAllDay: row.dueAllDay === 1,
      total: mine.length,
      done: mine.filter((task) => !task.open).length,
      ...milestoneRisk({ state: row.state, dueAt: row.dueAt, now, headsUpDays, tasks: mine }),
      rev: row.rev,
    };
  });
});

/** Its lead, its members, then whoever else holds its open tasks; each with what they hold. */
export const peopleOf = Effect.fn("KinProjectSpine.people")(function* (
  project: RecordRow,
  now: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const held = yield* sql<{ kind: string; id: string; open: number; late: number }>`
    SELECT r.owner_kind AS kind, r.owner_id AS id, COUNT(*) AS open,
      SUM(r.due_at IS NOT NULL AND r.due_at < ${now}) AS late
    FROM kin_records r WHERE r.org_id = ${project.orgId} AND r.register_id = 'work'
      AND r.project_id = ${project.recordId} AND r.state IN ${sql.in(OPEN)}
      AND ${seenBy(sql, viewer)}
    GROUP BY r.owner_kind, r.owner_id ORDER BY COUNT(*) DESC, r.owner_kind, r.owner_id`;
  const lead = principal(project.ownerKind, project.ownerId);
  const members = fieldList(parseFields(project.fieldsJson), "members").flatMap((text) => {
    const who = principalOfText(text);
    return who === null ? [] : [who];
  });
  const holders = held.flatMap((row) => {
    const who = principal(row.kind, row.id);
    return who === null ? [] : [{ who, open: row.open, late: row.late ?? 0 }];
  });
  const everyone: Array<KinWorkPrincipal> = [];
  for (const who of [...(lead === null ? [] : [lead]), ...members, ...holders.map((h) => h.who)])
    if (!everyone.some((one) => sameWho(one, who))) everyone.push(who);
  return everyone.map((who): KinProjectPerson => {
    const holds = holders.find((one) => sameWho(one.who, who));
    return {
      who,
      lead: lead !== null && sameWho(lead, who),
      member: members.some((one) => sameWho(one, who)),
      open: holds?.open ?? 0,
      late: holds?.late ?? 0,
    };
  });
});

/** Its meetings from a day ago on, and any earlier one nobody has closed yet. */
export const meetingsOf = Effect.fn("KinProjectSpine.meetings")(function* (
  orgId: KinOrgId,
  projectId: string,
  now: number,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.category = 'meeting'
      AND r.project_id = ${projectId} AND r.state != 'dropped' AND ${seenBy(sql, viewer)}
      AND (r.state IN ${sql.in(OPEN)} OR r.date_at >= ${now - DAY_MS})
    ORDER BY r.date_at IS NULL, r.date_at, r.key LIMIT 10`;
  return rows.map((row): KinRecord => toRecord(row, now));
});

/**
 * Open tasks written from a doc section that reads differently now. A task stores the doc's key,
 * the section id and that section's hash when it was written; changing them re-anchors it.
 */
export const specChangesOf = Effect.fn("KinProjectSpine.specChanges")(function* (
  orgId: KinOrgId,
  tasks: ReadonlyArray<RecordRow>,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const anchored = tasks.flatMap((task) => {
    const fields = parseFields(task.fieldsJson);
    const doc = fieldText(fields, "fromDoc");
    const section = fieldText(fields, "fromSection");
    const hash = fieldText(fields, "fromHash");
    return doc === null || section === null || hash === null ? [] : [{ task, doc, section, hash }];
  });
  if (anchored.length === 0) return [];
  const docs = yield* sql<{ recordId: string; key: string; title: string }>`
    SELECT r.record_id AS "recordId", r.key, r.title FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.key IN ${sql.in([...new Set(anchored.map((one) => one.doc))])}
      AND ${seenBy(sql, viewer)}
    ORDER BY r.key`;
  const latest = yield* latestOf(
    orgId,
    docs.map((doc) => doc.recordId),
  );
  const sections = new Map(
    docs.map((doc) => {
      const body = latest.get(doc.recordId)?.body ?? "";
      return [
        doc.key,
        { doc, hashes: new Map(sectionsOf(body).map((one) => [one.id, one.hash])) },
      ] as const;
    }),
  );
  return anchored.flatMap(({ task, doc, section, hash }): ReadonlyArray<KinSpecChange> => {
    const found = sections.get(doc);
    if (found === undefined) return [];
    const now = found.hashes.get(section);
    if (now === hash) return [];
    return [
      {
        record: ref(task.recordId, task.key, task.title),
        doc: ref(found.doc.recordId, found.doc.key, found.doc.title),
        section,
        gone: now === undefined,
      },
    ];
  });
});

export const projectSpecChanges = Effect.fn("KinProjectSpine.projectSpecChanges")(function* (
  orgId: KinOrgId,
  projectId: string,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.project_id = ${projectId}
      AND r.state IN ${sql.in(OPEN)} AND ${seenBy(sql, viewer)} AND json_extract(r.fields_json, '$.fromDoc') IS NOT NULL
    ORDER BY r.key LIMIT 200`;
  return yield* specChangesOf(orgId, tasks, viewer);
});

/**
 * Quotes, invoices and receipts filed under the project, by the counted rule, per currency. A
 * draft quote or invoice is no figure yet, as in what is still to invoice; a Draft receipt only
 * lacks its number, so receipts count unless void.
 */
export const moneyOf = Effect.fn("KinProjectSpine.money")(function* (
  orgId: KinOrgId,
  projectId: string,
  viewer: KinViewer,
) {
  const records = yield* KinRecords;
  const sums = Effect.fn("KinProjectSpine.sums")(function* (list: string, issuedOnly: boolean) {
    const def = yield* listDef(orgId, list);
    if (def === undefined) return undefined;
    return yield* records.totals(orgId, {
      list,
      projectId,
      ...(issuedOnly
        ? { states: def.states.filter((state) => state !== "open" && state !== "dropped") }
        : {}),
      ...(viewer._tag === "ownerLevel" ? {} : { view: viewer.people }),
    });
  });
  const quotes = yield* sums("quotes", true);
  const invoices = yield* sums("invoices", true);
  const receipts = yield* sums("receipts", false);
  const of = (money: ReadonlyArray<KinMoney> | undefined) => [...(money ?? [])];
  return {
    quoted: of(quotes?.total),
    invoiced: of(invoices?.total),
    received: of(receipts?.total),
    unpaid: of(invoices?.owed),
  } satisfies KinProjectMoney;
});
