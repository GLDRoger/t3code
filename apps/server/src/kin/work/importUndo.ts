import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinRecords } from "./KinRecords.ts";
import { workFailure } from "./recordRows.ts";
import { searchIndexed } from "./searchIndex.ts";

const CHUNK = 100;
const MAX_LISTED = 2_000;
const BATCH = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeLists = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeFills = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      filled: Schema.optional(
        Schema.Array(
          Schema.Struct({
            recordId: Schema.String,
            key: Schema.String,
            rev: Schema.Number,
            fields: Schema.Array(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

export type UndoReport = {
  readonly batch: string;
  readonly applied: boolean;
  readonly includeChanged: boolean;
  readonly removes: {
    readonly clients: number;
    readonly projects: number;
    readonly entries: number;
    readonly payments: number;
    readonly contacts: number;
    readonly deals: number;
  };
  /** Fields the batch filled on records Kin had, emptied again. */
  readonly restored: number;
  /** Keys imported, then changed by someone; kept unless asked to include them. */
  readonly changed: ReadonlyArray<string>;
  /** Imported rows kept because something outside the batch uses or paid them, and what. */
  readonly kept: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
  readonly lists: ReadonlyArray<{
    readonly list: string;
    readonly action: "remove" | "keep";
    readonly entries: number;
  }>;
};

const PAID_IN_KIN = "a payment recorded in Kin is on it";
const numberedIn = (number: string) => `Kin issued it ${number}, which stays in its series`;

/**
 * Entries of `ids` holding a number Kin issued or adopted itself, not one the import kept: the
 * number's change is logged by someone other than the import. Nothing takes those away.
 */
const kinNumbered = (sql: SqlClient.SqlClient, orgId: KinOrgId, ids: Statement.Fragment) =>
  sql<{ id: string; number: string }>`SELECT n.record_id AS id, n.number FROM kin_issued_numbers n
    WHERE n.org_id = ${orgId} AND n.record_id IN ${ids}
      AND EXISTS (SELECT 1 FROM kin_record_changes c, json_each(c.fields_json) f
        WHERE c.org_id = n.org_id AND c.record_id = n.record_id AND c.via <> 'import'
          AND json_extract(f.value, '$.field') = 'number')
    ORDER BY n.record_id`;
const changedSinceFilled = (fields: ReadonlyArray<string>) =>
  `it changed since the import filled in its ${fields.join(", ")}, so they stay`;

const batchRange = (sql: SqlClient.SqlClient, batch: string) => {
  // `;` sorts right after `:`, so the range is every key with this batch's prefix.
  const from = `import:${batch}:`;
  const to = `import:${batch};`;
  return {
    from,
    inBatch: (column: string) => sql`${sql(column)} >= ${from} AND ${sql(column)} < ${to}`,
  };
};

const GENERATED = "a generated document";
const LOGGED = "a logged contact";

/**
 * What outside the removal points at `ids`: their client or project, a link, a link field, a
 * generated document, contact logged with a client, which keeps its contacts too (`by` null).
 * Each keeps its target. Every table with a foreign key to a record an import makes (it makes no
 * docs) is here or deleted with it, so nothing refuses the delete.
 */
const usersOf = (sql: SqlClient.SqlClient, orgId: KinOrgId, ids: Statement.Fragment) =>
  sql<{ target: string; by: string | null; byKey: string }>`
    SELECT r.party_id AS target, r.record_id AS "by", r.key AS "byKey" FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.party_id IN ${ids}
    UNION ALL SELECT r.project_id, r.record_id, r.key FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.project_id IN ${ids}
    UNION ALL SELECT l.target, l.record_id, r.key FROM kin_record_links l
      JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
      WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.target IN ${ids}
    UNION ALL SELECT j.value, r.record_id, r.key FROM kin_records r, json_each(r.fields_json) j
      WHERE r.org_id = ${orgId} AND j.type = 'text' AND j.value IN ${ids}
    UNION ALL SELECT d.entry_record_id, NULL, ${GENERATED} FROM kin_doc_jobs d
      WHERE d.org_id = ${orgId} AND d.entry_record_id IN ${ids}
    UNION ALL SELECT DISTINCT t.party_id, NULL, ${LOGGED} FROM kin_client_touches t
      WHERE t.org_id = ${orgId} AND t.party_id IN ${ids}
    UNION ALL SELECT DISTINCT c.record_id, NULL, ${LOGGED} FROM kin_records c
      JOIN kin_client_touches t ON t.org_id = c.org_id AND t.party_id = c.party_id
      WHERE c.org_id = ${orgId} AND c.register_id = 'contacts' AND c.record_id IN ${ids}`;

/** Deletes these records and what hangs off them, inside the undo's transaction. */
const removeChunk = Effect.fn("KinImport.removeChunk")(function* (
  orgId: KinOrgId,
  chunk: ReadonlyArray<string>,
  indexed: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const these = sql.in(chunk);
  if (indexed)
    yield* sql`DELETE FROM kin_search WHERE rowid IN (SELECT id FROM kin_search_rows
      WHERE org_id = ${orgId} AND record_id IN ${these})`;
  yield* sql`DELETE FROM kin_search_rows WHERE org_id = ${orgId} AND record_id IN ${these}`;
  yield* sql`DELETE FROM kin_record_links WHERE org_id = ${orgId} AND record_id IN ${these}`;
  yield* sql`DELETE FROM kin_record_payments WHERE org_id = ${orgId} AND record_id IN ${these}`;
  // Its number goes with it; the series stays where it is, so none is issued twice.
  yield* sql`DELETE FROM kin_issued_numbers WHERE org_id = ${orgId} AND record_id IN ${these}`;
  yield* sql`DELETE FROM kin_record_comment_files WHERE org_id = ${orgId}
    AND comment_id IN (SELECT comment_id FROM kin_record_comments
      WHERE org_id = ${orgId} AND record_id IN ${these})`;
  yield* sql`DELETE FROM kin_record_comments WHERE org_id = ${orgId} AND record_id IN ${these}`;
  yield* sql`DELETE FROM kin_record_changes WHERE org_id = ${orgId} AND record_id IN ${these}`;
  yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId} AND record_id IN ${these}`;
});

/** What taking a batch away would do: what it made that nobody changed, paid in Kin or uses since. */
const decide = Effect.fn("KinImport.undoPlan")(function* (
  orgId: KinOrgId,
  batch: string,
  options: { readonly apply: boolean; readonly includeChanged: boolean },
) {
  const sql = yield* SqlClient.SqlClient;
  const { from, inBatch } = batchRange(sql, batch);
  const rows = yield* sql<{
    recordId: string;
    key: string;
    registerId: string;
    originKey: string;
  }>`
    SELECT record_id AS "recordId", key, register_id AS "registerId", origin_key AS "originKey"
    FROM kin_records WHERE org_id = ${orgId} AND ${inBatch("origin_key")} ORDER BY origin_key`;
  const ids = sql`SELECT record_id FROM kin_records WHERE org_id = ${orgId} AND ${inBatch("origin_key")}`;
  // A payment Kin recorded is never the batch's to take: its entry stays, changed or not.
  const paid = new Set(
    (yield* sql<{ id: string }>`SELECT DISTINCT p.record_id AS id FROM kin_record_payments p
      WHERE p.org_id = ${orgId} AND p.record_id IN (${ids}) AND NOT (${inBatch("p.origin_key")})
      ORDER BY p.record_id`).map((one) => one.id),
  );
  const numbered = new Map(
    (yield* kinNumbered(sql, orgId, sql`(${ids})`)).map((one) => [one.id, one.number]),
  );
  const edited = new Set(
    (yield* sql<{ id: string }>`SELECT DISTINCT c.record_id AS id FROM kin_record_changes c
      WHERE c.org_id = ${orgId} AND c.via <> 'import' AND c.record_id IN (${ids})
      ORDER BY c.record_id`)
      .map((one) => one.id)
      .filter((id) => !paid.has(id) && !numbered.has(id)),
  );
  const removing = new Set(
    rows
      .filter(
        (one) =>
          !paid.has(one.recordId) &&
          !numbered.has(one.recordId) &&
          (options.includeChanged || !edited.has(one.recordId)),
      )
      .map((one) => one.recordId),
  );
  // Each user outside the removal keeps its target, and so on until nothing moves.
  const refs = yield* usersOf(sql, orgId, sql`(${ids})`);
  const keyOf = new Map(rows.map((one) => [one.recordId, one.key]));
  const users = new Map<string, Set<string>>();
  let moved = true;
  while (moved) {
    moved = false;
    for (const ref of refs) {
      if (!removing.has(ref.target) || (ref.by !== null && removing.has(ref.by))) continue;
      removing.delete(ref.target);
      moved = true;
    }
  }
  // Listed: what stays only because something kept uses it, not what someone changed.
  for (const ref of refs) {
    const { target, by } = ref;
    if (!keyOf.has(target) || removing.has(target) || by === target) continue;
    if ((edited.has(target) && !options.includeChanged) || (by !== null && removing.has(by)))
      continue;
    users.set(target, (users.get(target) ?? new Set()).add(ref.byKey));
  }
  const kept = [...new Set([...paid, ...numbered.keys(), ...users.keys()])]
    .map((target) => {
      const by = users.get(target);
      const number = numbered.get(target);
      return {
        key: keyOf.get(target) ?? target,
        reason: [
          ...(paid.has(target) ? [PAID_IN_KIN] : []),
          ...(number === undefined ? [] : [numberedIn(number)]),
          ...(by === undefined
            ? []
            : [`${[...by].toSorted().join(", ")} ${by.size === 1 ? "uses" : "use"} it`]),
        ].join("; "),
      };
    })
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const kindOf = (originKey: string) => originKey.slice(from.length).split(":")[0] ?? "";
  const gone = rows.filter((one) => removing.has(one.recordId));
  const keptPaid = yield* sql<{ id: string; n: number }>`SELECT record_id AS id, COUNT(*) AS n
    FROM kin_record_payments WHERE org_id = ${orgId} AND record_id IN (${ids}) GROUP BY record_id`;
  const payments = keptPaid.reduce((sum, one) => sum + (removing.has(one.id) ? one.n : 0), 0);

  // The lists the batch made since it was last undone, and whether anything else is on them.
  // An undo that never finished (the host stopped) took away only part: it counts as none.
  const runs = yield* sql<{ action: string; lists: string; summary: string | null }>`SELECT
      action, lists_json AS lists, summary_json AS summary
    FROM kin_import_runs WHERE org_id = ${orgId} AND batch = ${batch}
      AND (action = 'apply' OR (action = 'undo' AND finished_at IS NOT NULL))
    ORDER BY seq`;
  const made = new Set<string>();
  const fills = new Map<string, { key: string; rev: number; fields: ReadonlyArray<string> }>();
  for (const one of runs) {
    if (one.action === "undo") {
      made.clear();
      fills.clear();
    } else {
      for (const list of Option.getOrElse(decodeLists(one.lists), () => [])) made.add(list);
      const filled = Option.getOrUndefined(decodeFills(one.summary ?? "{}"))?.filled ?? [];
      for (const fill of filled) fills.set(fill.recordId, fill);
    }
  }
  // A filled record emptied again only as the import left it: any change since keeps it whole.
  const filledNow =
    fills.size === 0
      ? []
      : yield* sql<{ id: string; rev: number }>`SELECT
      record_id AS id, rev FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in([...fills.keys()])} ORDER BY record_id`;
  const restoring = filledNow.flatMap((one) => {
    const fill = fills.get(one.id);
    return fill !== undefined && fill.rev === one.rev ? [{ recordId: one.id, ...fill }] : [];
  });
  const changedFills = filledNow.flatMap((one) => {
    const fill = fills.get(one.id);
    return fill !== undefined && fill.rev !== one.rev
      ? [{ key: fill.key, reason: changedSinceFilled(fill.fields) }]
      : [];
  });
  const lists: Array<UndoReport["lists"][number]> = [];
  for (const list of made) {
    const [held] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
      WHERE org_id = ${orgId} AND register_id = ${list}`;
    const left = (held?.n ?? 0) - gone.filter((one) => one.registerId === list).length;
    lists.push({ list, action: left === 0 ? "remove" : "keep", entries: left });
  }

  const report: UndoReport = {
    batch,
    applied: options.apply,
    includeChanged: options.includeChanged,
    removes: {
      clients: gone.filter((one) => kindOf(one.originKey) === "client").length,
      projects: gone.filter((one) => kindOf(one.originKey) === "project").length,
      entries: gone.filter((one) => kindOf(one.originKey) === "entry").length,
      payments,
      contacts: gone.filter((one) => kindOf(one.originKey) === "contact").length,
      deals: gone.filter((one) => kindOf(one.originKey) === "deal").length,
    },
    restored: restoring.length,
    changed: rows
      .filter((one) => edited.has(one.recordId))
      .map((one) => one.key)
      .slice(0, MAX_LISTED),
    kept: [...kept, ...changedFills].slice(0, MAX_LISTED),
    lists,
  };
  return { report, gone, restoring, lists };
});

export const IMPORT_BUSY =
  "Kin is importing or undoing a file for this company now. Wait for it to finish, then try again.";
/** An unfinished apply's row is held this long past its last chunk (`$.beat`); past it, its host stopped. */
export const IMPORT_LEASE_MS = 60_000;
export const beating = (beat: number | undefined, now: number) =>
  beat !== undefined && beat > now - IMPORT_LEASE_MS;

/** In the caller's transaction: refused while any process on this database applies for the org. */
export const notImporting = Effect.fn("KinImport.notImporting")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const [held] = yield* sql<{ seq: number }>`SELECT seq FROM kin_import_runs
    WHERE org_id = ${orgId} AND action = 'apply' AND finished_at IS NULL
      AND json_extract(summary_json, '$.beat') > ${now - IMPORT_LEASE_MS}
    ORDER BY seq LIMIT 1`;
  if (held !== undefined)
    return yield* new KinChatError({ reason: "conflict", message: IMPORT_BUSY });
});

/**
 * Takes a batch away, or with `apply` false says what that would do. Applied, it is one
 * transaction that decides again inside it: whatever refuses part way (a busy or full database)
 * takes nothing away. Keys never go back, as memory and chats name entries by key.
 */
export const undoBatch = Effect.fn("KinImport.undo")(function* (
  orgId: KinOrgId,
  owner: KinPersonId,
  batch: string,
  options: { readonly apply: boolean; readonly includeChanged: boolean },
  /** How far it is, for whoever watches. */
  entry?: { done: number; of: number },
) {
  const sql = yield* SqlClient.SqlClient;
  if (!BATCH.test(batch)) return yield* invalid(`${batch} isn't a batch name.`);
  if (!options.apply) return (yield* decide(orgId, batch, options)).report;
  const records = yield* KinRecords;
  const writer = { actor: { _tag: "person" as const, personId: owner }, via: "import" as const };
  const { report, lists } = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* notImporting(orgId);
      const started = yield* Clock.currentTimeMillis;
      const plan = yield* decide(orgId, batch, options);
      const { gone, restoring, lists } = plan;
      if (entry !== undefined) entry.of = gone.length;
      for (const fill of restoring) {
        const fields: Record<string, null> = {};
        for (const name of fill.fields) {
          if (name === "notes") continue;
          fields[name] = null;
          if (name === "email" || name === "phone") fields[`${name}s`] = null;
        }
        yield* records.update(
          orgId,
          writer,
          fill.key,
          {
            ...(Object.keys(fields).length === 0 ? {} : { fields }),
            ...(fill.fields.includes("notes") ? { notes: "" } : {}),
          },
          fill.rev,
        );
      }
      const indexed = yield* searchIndexed();
      for (let index = 0; index < gone.length; index += CHUNK) {
        const chunk = gone.slice(index, index + CHUNK).map((one) => one.recordId);
        yield* removeChunk(orgId, chunk, indexed);
        if (entry !== undefined) entry.done = Math.min(gone.length, index + CHUNK);
      }
      // A list's number series outlives it: defined again, the list carries on its numbers.
      for (const one of lists)
        if (one.action === "remove")
          yield* sql`DELETE FROM kin_registers WHERE org_id = ${orgId} AND register_id = ${one.list}
            AND NOT EXISTS (SELECT 1 FROM kin_records WHERE org_id = ${orgId} AND register_id = ${one.list})`;
      const { report } = plan;
      yield* sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at,
          finished_at, lists_json, summary_json)
        VALUES (${orgId}, ${batch}, 'undo', ${owner}, ${started}, ${yield* Clock.currentTimeMillis},
          ${encodeJson(lists.filter((one) => one.action === "remove").map((one) => one.list))},
          ${encodeJson({ ...report.removes, restored: report.restored, changed: report.changed.length, kept: report.kept.length, includeChanged: options.includeChanged })})`;
      return plan;
    }),
  );
  if (lists.some((one) => one.action === "remove"))
    yield* (yield* KinRefreshObserver).touch(orgId, "workLists");
  return report;
}, workFailure);
