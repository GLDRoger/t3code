import {
  KinChatError,
  KinDay,
  KinProjectBilling,
  KinRecordKey,
  type KinMoney,
  type KinOrgId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { KinToolText } from "./leadSchemas.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { projectPage } from "./crm.ts";
import { sectionsOf } from "./docBody.ts";
import { versionOf } from "./docs.ts";
import { type FieldValue, fieldList, fieldText, isMoney, parseFields } from "./lists.ts";
import { dayIn, dayWords, formatMoney, parseAmount } from "./money.ts";
import { principalOfText, principalText, specChangesOf } from "./projectSpine.ts";
import type { ToolNamer } from "./toolNames.ts";
import { seenBy, type KinViewer } from "./teamView.ts";
import { matchName } from "./nameMatch.ts";
import { ownerZone, type RecordRow, selectRecords, toRecord } from "./recordRows.ts";

/**
 * The project spine's agent inputs and reads: milestones, sizes, reasons, the spec section a task
 * came from, meetings, and a project's billing and people; and the one read of a whole project.
 */

const Who = KinToolText(120);
const Size = Schema.Literals(["S", "M", "L"]).annotate({ description: "S, M or L." });
const Reason = KinToolText(
  200,
  'One line on why its owner was picked, such as "Kabir: tech, 3 open, free Thursday". Shown beside the task.',
);
const From = Schema.NullOr(
  Schema.Struct({
    doc: KinRecordKey,
    section: KinToolText(120),
  }),
).annotate({
  description:
    "The doc and section id (from doc_read's outline) it was written from. Kin flags the task when that section changes; giving it again re-anchors it. null clears.",
});

/** What a Work or project row may also carry; rows of other lists refuse them. */
export const SpineInputs = {
  milestone: Schema.optional(Schema.NullOr(KinToolText(200))).annotate({
    description:
      "A task's milestone: its key (M-2) or exact name in the task's project. Sets the project too when it has none. null clears.",
  }),
  size: Schema.optional(Schema.NullOr(Size)),
  reason: Schema.optional(Schema.NullOr(Reason)),
  from: Schema.optional(From),
  at: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(40)))).annotate({
    description: "A meeting's start: a time with its offset (2026-11-20T15:00+05:30).",
  }),
  attendees: Schema.optional(Schema.Array(Who).check(Schema.isMaxLength(30))).annotate({
    description: "A meeting's people: each as owner is named.",
  }),
  where: Schema.optional(Schema.NullOr(KinToolText(200))),
  billing: Schema.optional(Schema.NullOr(KinProjectBilling)).annotate({
    description: "A project's billing: fixed, hourly or retainer.",
  }),
  value: Schema.optional(Schema.NullOr(KinToolText(60))).annotate({
    description: 'A project\'s value as said ("6 lakh", "$12,000"); for a retainer, per period.',
  }),
  startsOn: Schema.optional(Schema.NullOr(KinDay)).annotate({
    description: "When a project or a goal's period starts.",
  }),
  renewsOn: Schema.optional(Schema.NullOr(KinDay)).annotate({
    description: "A retainer's next renewal day.",
  }),
  members: Schema.optional(Schema.Array(Who).check(Schema.isMaxLength(50))).annotate({
    description:
      "A project's people and agents besides its owner (its lead), each as owner is named; replaces the list.",
  }),
};
type SpineRow = {
  readonly [K in keyof typeof SpineInputs]?: Schema.Schema.Type<(typeof SpineInputs)[K]>;
};
/** Inputs only the owner's own turn sets: a teammate's are their tasks, not the plan's money or people. */
export const OWNERS_SPINE = ["milestone", "from", "billing", "value", "members"] as const;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

type Resolve<E, R> = {
  readonly who: (text: string) => Effect.Effect<KinWorkPrincipal, E, R>;
  readonly at: (text: string) => Effect.Effect<number, KinChatError>;
};

/** A milestone by key, or by exact name within the project, among those the viewer sees. */
const milestoneRow = Effect.fn("KinLeadSpine.milestone")(function* (
  orgId: KinOrgId,
  text: string,
  projectId: string | null | undefined,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const all = yield* sql<{ key: string; name: string; projectId: string | null }>`SELECT r.key,
      r.title AS name, r.project_id AS "projectId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'milestones'
      AND (r.key = ${text.toUpperCase()}
        OR ${projectId ?? null} IS NULL OR r.project_id = ${projectId ?? null})
      AND ${seenBy(sql, viewer)}
    ORDER BY r.key LIMIT 2000`;
  const match = matchName(text, all);
  const rows =
    match._tag === "found" ? [match.item] : match._tag === "ambiguous" ? match.items : [];
  if (rows.length === 0)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No milestone ${text.slice(0, 60)}.${
        match._tag === "none" && match.nearest.length > 0
          ? ` Nearest: ${match.nearest.map((one) => `${one.name} (${one.key})`).join(", ")}.`
          : ""
      } Create it first with list milestones and its project.`,
    });
  if (rows.length > 1)
    return yield* invalid(
      `Several milestones are named ${text.slice(0, 60)}: ${rows.map((row) => row.key).join(", ")}. Use the key.`,
    );
  return rows[0]!;
});

/** The section's hash now, so a later edit of it shows; a doc the viewer can't see is none. */
const anchorOf = Effect.fn("KinLeadSpine.anchor")(function* (
  orgId: KinOrgId,
  from: { readonly doc: string; readonly section: string },
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const [doc] = yield* sql<{ recordId: string; key: string }>`SELECT r.record_id AS "recordId",
      r.key FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'docs'
      AND r.key = ${from.doc.toUpperCase()} AND ${seenBy(sql, viewer)} ORDER BY r.key LIMIT 1`;
  if (doc === undefined)
    return yield* new KinChatError({ reason: "not_found", message: `No doc ${from.doc}.` });
  const version = yield* versionOf(orgId, doc.recordId);
  const sections = sectionsOf(version?.body ?? "");
  const section = sections.find((one) => one.id === from.section);
  if (section === undefined)
    return yield* invalid(
      `${doc.key} has no section ${from.section.slice(0, 60)}. Its sections: ${sections
        .filter((one) => one.id !== "top")
        .map((one) => one.id)
        .join(", ")
        .slice(0, 600)}.`,
    );
  return { fromDoc: doc.key, fromSection: section.id, fromHash: section.hash };
});

/**
 * The fields a row's spine inputs write, and the project a milestone brings. The list's own
 * definition refuses a field it doesn't have, so a client row naming a milestone fails there.
 */
export const spineFields = Effect.fn("KinLeadSpine.fields")(function* <E, R>(
  orgId: KinOrgId,
  row: SpineRow,
  projectId: string | null | undefined,
  viewer: KinViewer,
  resolve: Resolve<E, R> & { readonly currency: string },
) {
  const fields: Record<string, FieldValue | null> = {};
  let project: string | undefined;
  if (row.milestone !== undefined) {
    if (row.milestone === null) fields.milestone = null;
    else {
      const found = yield* milestoneRow(orgId, row.milestone, projectId, viewer);
      if (projectId !== undefined && projectId !== null && found.projectId !== projectId)
        return yield* invalid(`${found.key} is another project's milestone.`);
      fields.milestone = found.key;
      if ((projectId === undefined || projectId === null) && found.projectId !== null)
        project = found.projectId;
    }
  }
  if (row.from !== undefined) {
    const anchor =
      row.from === null
        ? { fromDoc: null, fromSection: null, fromHash: null }
        : yield* anchorOf(orgId, row.from, viewer);
    Object.assign(fields, anchor);
  }
  const people = (list: ReadonlyArray<string>) =>
    Effect.forEach(list, (text) => resolve.who(text).pipe(Effect.map(principalText)));
  if (row.attendees !== undefined) fields.attendees = yield* people(row.attendees);
  if (row.members !== undefined) fields.members = yield* people(row.members);
  for (const key of ["size", "reason", "where", "billing", "startsOn", "renewsOn"] as const)
    if (row[key] !== undefined) fields[key] = row[key] ?? null;
  if (row.value !== undefined) {
    if (row.value === null) fields.value = null;
    else {
      const parsed = parseAmount(row.value, resolve.currency);
      if ("error" in parsed) return yield* parsed.error;
      fields.value = parsed.money;
    }
  }
  const at =
    row.at === undefined
      ? {}
      : row.at === null
        ? { dateAt: null, dateAllDay: false }
        : { dateAt: yield* resolve.at(row.at), dateAllDay: false };
  return { fields, at, ...(project === undefined ? {} : { projectId: project }) };
});

/** A row's spine fields as an agent reads them. */
export const spineShown = (row: RecordRow, name: ToolNamer) => {
  const fields = parseFields(row.fieldsJson);
  const text = (key: string) => fieldText(fields, key) ?? undefined;
  const names = (key: string) => {
    const list = fieldList(fields, key).map((one) => name(principalOfText(one)) ?? "someone");
    return list.length === 0 ? undefined : list.join(", ");
  };
  const doc = text("fromDoc");
  const value = fields.value;
  const shown = {
    milestone: text("milestone"),
    size: text("size"),
    reason: text("reason"),
    from: doc === undefined ? undefined : `${doc} § ${text("fromSection") ?? ""}`,
    attendees: names("attendees"),
    where: text("where"),
    billing: text("billing"),
    value: value !== undefined && isMoney(value) ? formatMoney(value) : undefined,
    startsOn: text("startsOn"),
    renewsOn: text("renewsOn"),
    members: names("members"),
  };
  return Object.fromEntries(Object.entries(shown).filter((entry) => entry[1] !== undefined)) as {
    readonly [K in keyof typeof shown]?: string;
  };
};
export const SpineShown = {
  milestone: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
  /** The section it came from changed since; read it and update the task, then re-anchor. */
  specChanged: Schema.optional(Schema.Literal(true)),
  attendees: Schema.optional(Schema.String),
  where: Schema.optional(Schema.String),
  billing: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String),
  startsOn: Schema.optional(Schema.String),
  renewsOn: Schema.optional(Schema.String),
  members: Schema.optional(Schema.String),
};

const Line = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: Schema.String,
  owner: Schema.optional(Schema.String),
  due: Schema.optional(Schema.String),
  dueDay: Schema.optional(Schema.String),
  late: Schema.optional(Schema.Literal(true)),
  milestone: Schema.optional(Schema.String),
  size: Schema.optional(Schema.String),
  specChanged: Schema.optional(Schema.Literal(true)),
});
/** "Where are we" in one read: everything a project holds, computed now. */
export const ProjectRead = Schema.Struct({
  milestones: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      state: Schema.String,
      due: Schema.optional(Schema.String),
      dueDay: Schema.optional(Schema.String),
      done: Schema.Number,
      total: Schema.Number,
      late: Schema.optional(Schema.Literal(true)),
      atRisk: Schema.optional(Schema.Literal(true)),
    }),
  ),
  tasks: Schema.Struct({
    open: Schema.Number,
    doing: Schema.Number,
    waiting: Schema.Number,
    done: Schema.Number,
    dropped: Schema.Number,
    late: Schema.Number,
  }),
  /** Open tasks by milestone then due, at most 60. */
  openTasks: Schema.Array(Line),
  people: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      lead: Schema.optional(Schema.Literal(true)),
      member: Schema.optional(Schema.Literal(true)),
      open: Schema.Number,
      late: Schema.Number,
    }),
  ),
  docs: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, kind: Schema.String }),
  ),
  meetings: Schema.Array(Line),
  specChanged: Schema.Array(
    Schema.Struct({
      task: Schema.String,
      doc: Schema.String,
      section: Schema.String,
      gone: Schema.optional(Schema.Literal(true)),
    }),
  ),
  money: Schema.Struct({
    quoted: Schema.Array(Schema.String),
    invoiced: Schema.Array(Schema.String),
    received: Schema.Array(Schema.String),
    unpaid: Schema.Array(Schema.String),
  }),
  /** No milestones and no tasks yet: the first plan is still to be proposed. */
  noPlan: Schema.optional(Schema.Literal(true)),
});

const OPEN = ["open", "doing", "waiting"] as const;

export const projectRead = Effect.fn("KinLeadSpine.projectRead")(function* (
  row: RecordRow,
  now: number,
  name: ToolNamer,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const page = yield* projectPage(row, now, 0, viewer);
  const open = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${row.orgId} AND r.register_id = 'work' AND r.project_id = ${row.recordId}
      AND r.state IN ${sql.in(OPEN)} AND COALESCE(r.category, '') != 'meeting'
      AND ${seenBy(sql, viewer)}
    ORDER BY json_extract(r.fields_json, '$.milestone') IS NULL,
      json_extract(r.fields_json, '$.milestone'), r.due_at IS NULL, r.due_at, r.key LIMIT 60`;
  const ids = (page.meetings ?? []).map((one) => one.recordId);
  const meetings =
    ids.length === 0
      ? []
      : yield* sql<RecordRow>`${selectRecords(sql)}
          WHERE r.org_id = ${row.orgId} AND r.record_id IN ${sql.in(ids)}
          ORDER BY r.date_at IS NULL, r.date_at, r.key`;
  const changed = new Set(
    (yield* specChangesOf(row.orgId as KinOrgId, open, viewer)).map((one) => one.record.key),
  );
  const docs = yield* sql<{ key: string; title: string; kind: string | null }>`SELECT r.key,
      r.title, r.category AS kind FROM kin_records r
    WHERE r.org_id = ${row.orgId} AND r.register_id = 'docs' AND r.project_id = ${row.recordId}
      AND r.state = 'open' AND ${seenBy(sql, viewer)} ORDER BY r.category, r.key LIMIT 50`;
  // An all-day due is stored as the end of the company's day: its day is read in that zone.
  const zone = yield* ownerZone(row.orgId as KinOrgId);
  const day = (at: string | null, allDay: boolean) =>
    at === null ? undefined : allDay ? dayIn(Date.parse(at), zone) : at;
  const words = (at: string | null) => (at === null ? undefined : dayWords(Date.parse(at), zone));
  const line = (task: RecordRow) => {
    const record = toRecord(task, now);
    const fields = parseFields(task.fieldsJson);
    return {
      key: record.key,
      title: record.title,
      state: record.state,
      owner: name(record.owner),
      due: day(record.dueAt, record.dueAllDay) ?? record.dateAt,
      dueDay: words(record.dueAt),
      ...(record.late ? { late: true as const } : {}),
      milestone: fieldText(fields, "milestone") ?? undefined,
      size: fieldText(fields, "size") ?? undefined,
      ...(changed.has(record.key) ? { specChanged: true as const } : {}),
    };
  };
  const shownMoney = (money: ReadonlyArray<KinMoney> | undefined) => (money ?? []).map(formatMoney);
  const milestones = page.milestones ?? [];
  const counts = page.counts;
  const tasksTotal = Object.values(counts).reduce((sum, one) => sum + one, 0) - counts.late;
  return {
    milestones: milestones.map((one) => ({
      key: one.key,
      title: one.title,
      state: one.state,
      due: day(one.dueAt, one.dueAllDay),
      dueDay: words(one.dueAt),
      done: one.done,
      total: one.total,
      ...(one.late ? { late: true as const } : {}),
      ...(one.atRisk ? { atRisk: true as const } : {}),
    })),
    tasks: counts,
    openTasks: open.map(line),
    people: (page.people ?? []).map((one) => ({
      name: name(one.who) ?? "someone",
      ...(one.lead ? { lead: true as const } : {}),
      ...(one.member ? { member: true as const } : {}),
      open: one.open,
      late: one.late,
    })),
    docs: docs.map((doc) => ({ key: doc.key, title: doc.title, kind: doc.kind ?? "other" })),
    meetings: meetings.map(line),
    specChanged: (page.specChanged ?? []).map((one) => ({
      task: one.record.key,
      doc: one.doc.key,
      section: one.section,
      ...(one.gone ? { gone: true as const } : {}),
    })),
    money: {
      quoted: shownMoney(page.money?.quoted),
      invoiced: shownMoney(page.money?.invoiced),
      received: shownMoney(page.money?.received),
      unpaid: shownMoney(page.money?.unpaid),
    },
    ...(milestones.length === 0 && tasksTotal === 0 ? { noPlan: true as const } : {}),
  } satisfies typeof ProjectRead.Type;
});

/** Whether a task's spec section changed since it was written from it. */
export const taskSpecChanged = Effect.fn("KinLeadSpine.taskSpecChanged")(function* (
  row: RecordRow,
  viewer: KinViewer,
) {
  return (yield* specChangesOf(row.orgId as KinOrgId, [row], viewer)).length > 0;
});
