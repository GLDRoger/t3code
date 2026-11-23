import type { KinOrgId, KinPersonId, KinRecordState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { workFailure } from "../work/recordRows.ts";
import { type KinViewer, seenBy, teamSeesField } from "../work/teamView.ts";

/**
 * What the canvas reads of Work, each through the viewer's own `seenBy`: an entry they can't read
 * answers exactly as one that doesn't exist.
 */

/** The lists whose entries the canvas shows as cards: what changed and what an agent touched. */
const CANVAS_LISTS = ["work", "docs", "projects"] as const;

type Entry = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly registerId: string;
  readonly state: KinRecordState;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
};

const CHUNK = 500;
const chunks = <A>(all: ReadonlyArray<A>) => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < all.length; i += CHUNK) out.push(all.slice(i, i + CHUNK));
  return out;
};

/** The entries of these keys or record ids this viewer may read now, by key or by id. */
export const shownEntries = Effect.fn("KinCanvas.shownEntries")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  by: { readonly keys: ReadonlyArray<string> } | { readonly ids: ReadonlyArray<string> },
) {
  const sql = yield* SqlClient.SqlClient;
  const named = [...new Set("keys" in by ? by.keys : by.ids)];
  const found: Array<Entry> = [];
  for (const part of chunks(named))
    found.push(
      ...(yield* sql<Entry>`SELECT r.record_id AS "recordId", r.key, r.title,
            r.register_id AS "registerId", r.state, r.due_at AS "dueAt",
            r.due_all_day AS "dueAllDay"
          FROM kin_records r
          WHERE r.org_id = ${orgId}
            AND ${"keys" in by ? sql`r.key IN ${sql.in(part)}` : sql`r.record_id IN ${sql.in(part)}`}
            AND ${seenBy(sql, viewer)}
          ORDER BY r.key`),
    );
  return found;
}, workFailure);

type ProjectCounts = {
  readonly projectId: string;
  readonly done: number;
  /** Every task but the dropped ones. */
  readonly total: number;
  readonly open: number;
  readonly doing: number;
  readonly waiting: number;
  readonly late: number;
};

/** Each project's tasks this viewer may read, counted as Work's summary counts them. */
export const projectCounts = Effect.fn("KinCanvas.projectCounts")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  projectIds: ReadonlyArray<string>,
  now: number,
) {
  if (projectIds.length === 0) return new Map<string, ProjectCounts>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ProjectCounts>`SELECT r.project_id AS "projectId",
        SUM(r.state = 'done') AS done, SUM(r.state <> 'dropped') AS total,
        SUM(r.state NOT IN ('done', 'dropped')) AS open, SUM(r.state = 'doing') AS doing,
        SUM(r.state = 'waiting') AS waiting,
        SUM(r.state NOT IN ('done', 'dropped') AND r.due_at IS NOT NULL AND r.due_at < ${now})
          AS late
      FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = 'work'
        AND r.project_id IN ${sql.in([...new Set(projectIds)])} AND ${seenBy(sql, viewer)}
      GROUP BY r.project_id ORDER BY r.project_id`;
  return new Map(rows.map((row) => [row.projectId, row]));
}, workFailure);

type ChangeRow = {
  readonly seq: number;
  readonly at: number;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly kind: string;
  readonly fieldsJson: string;
  readonly key: string;
  readonly title: string;
  readonly registerId: string;
  readonly projectId: string | null;
  readonly createdAt: number;
};

const fieldNames = (json: string): ReadonlyArray<{ readonly field: string }> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.flatMap((one: unknown) =>
          typeof one === "object" &&
          one !== null &&
          typeof (one as { field?: unknown }).field === "string"
            ? [{ field: (one as { field: string }).field }]
            : [],
        )
      : [];
  } catch {
    return [];
  }
};

/** The newest changes a return looks through; after a long absence the rest are folded away. */
const SINCE_SCAN = 2000;

/**
 * Changes to the canvas's entries this viewer may read, made after `after` by anyone but `me`,
 * newest first. A teammate's tasks outside the projects they lead keep only the changes their
 * history shows (`teamChanges`); `led` holds those projects' record ids.
 */
export const changesSince = Effect.fn("KinCanvas.changesSince")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  me: KinPersonId,
  after: number,
  led: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ChangeRow>`SELECT c.seq, c.at, c.actor_kind AS "actorKind",
        c.actor_id AS "actorId", c.kind, c.fields_json AS "fieldsJson", r.key, r.title,
        r.register_id AS "registerId", r.project_id AS "projectId", r.created_at AS "createdAt"
      FROM kin_record_changes c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      WHERE c.org_id = ${orgId} AND c.at > ${after}
        AND NOT (c.actor_kind = 'person' AND c.actor_id IS ${me})
        AND r.register_id IN ${sql.in(CANVAS_LISTS)} AND ${seenBy(sql, viewer)}
      ORDER BY c.seq DESC
      LIMIT ${SINCE_SCAN}`;
  if (viewer._tag === "ownerLevel") return rows;
  return rows.filter(
    (row) =>
      row.registerId !== "work" ||
      (row.projectId !== null && led.has(row.projectId)) ||
      (row.kind !== "linked" &&
        (row.kind !== "updated" ||
          fieldNames(row.fieldsJson).some((one) => teamSeesField(one.field)))),
  );
}, workFailure);

/** The canvas entries each running wake-up changed that this viewer may read, newest first. */
export const wakeupKeys = Effect.fn("KinCanvas.wakeupKeys")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  wakeupIds: ReadonlyArray<string>,
  max: number,
) {
  const keys = new Map<string, Array<string>>();
  if (wakeupIds.length === 0) return keys;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ wakeupId: string; key: string }>`SELECT c.wakeup_id AS "wakeupId",
        r.key, MAX(c.seq) AS seq
      FROM kin_record_changes c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      WHERE c.org_id = ${orgId} AND c.wakeup_id IN ${sql.in([...new Set(wakeupIds)])}
        AND r.register_id IN ${sql.in(CANVAS_LISTS)} AND ${seenBy(sql, viewer)}
      GROUP BY c.wakeup_id, r.key ORDER BY seq DESC, r.key`;
  for (const row of rows) {
    const held = keys.get(row.wakeupId) ?? [];
    if (held.length < max) held.push(row.key);
    keys.set(row.wakeupId, held);
  }
  return keys;
}, workFailure);
