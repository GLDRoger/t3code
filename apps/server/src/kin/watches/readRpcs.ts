import {
  KinAgentId,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  type KinWatch,
  type KinWatchActor,
  type KinWatchesListInput,
  type KinWatchesLogInput,
  type KinWatchesLogResult,
  type KinWatchLine,
  type KinWatchLogLook,
  type KinWatchLogRow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { DAY_MS } from "../durations.ts";
import { dayIn } from "../work/money.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { viewerOf } from "../work/ownerWork.ts";
import { endOfDay, ownerZone, startOfDay } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, viewSees, viewerOfPeople, type KinViewer } from "../work/teamView.ts";
import { ALL_KINDS } from "./kinds/all.ts";

/** Who reads or acts: their person, and what they see. */
export interface WatchReader {
  readonly personId: KinPersonId;
  readonly viewer: KinViewer;
}

// A teammate reaches only work kinds; money, mail and host watches are the owner level's, and a
// kind this host doesn't know yet stays theirs too.
const TEAM_KINDS = ALL_KINDS.filter((kind) => kind.reach === "work").map((kind) => kind.kind);

/** Watches `w` this reader may see: a teammate's own records' and the ones they asked for. */
export const watchSeen = (sql: SqlClient.SqlClient, reader: WatchReader): Statement.Fragment =>
  reader.viewer._tag === "ownerLevel"
    ? sql`1 = 1`
    : sql`(w.kind IN ${sql.in(TEAM_KINDS)} AND (w.for_person_id = ${reader.personId}
        OR (w.record_id IS NOT NULL AND EXISTS (SELECT 1 FROM kin_records r
          WHERE r.org_id = w.org_id AND r.record_id = w.record_id
            AND ${viewSees(sql, reader.viewer.people)}))))`;

/** The caller in that org and what they see; `not_found` for an org they aren't in. */
export const watchReader = Effect.fn("KinWatches.reader")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId).pipe(
    Effect.mapError(
      () => new KinChatError({ reason: "not_found", message: "No such company here." }),
    ),
  );
  const personId = viewer.person.personId;
  return {
    personId,
    viewer: viewer.teammate ? viewerOfPeople([personId]) : KIN_OWNER_LEVEL,
  } satisfies WatchReader;
});

/**
 * A record read with its watch line, for a reader who may see that watch. A failed read of the
 * watch leaves the record as it was.
 */
export const withWatch = Effect.fn("KinWatches.withWatch")(function* <
  A extends { readonly orgId: KinOrgId; readonly recordId: string },
>(people: ReadonlyArray<PersonIdentity>, detail: A) {
  const watch = yield* watchReader(people, detail.orgId).pipe(
    Effect.flatMap((reader) => lineOn(detail.orgId, reader, detail.recordId)),
    Effect.orElseSucceed(() => undefined),
  );
  return watch === undefined ? detail : { ...detail, watch };
});

/** Closed and stopped watches stay in the list this long; the log keeps their looks as long. */
const LIST_CLOSED_MS = 30 * DAY_MS;
const LIST_CAP = 500;
/** A folded run of nothing-new looks carries at most this many to open. */
const FOLD_SHOWN = 50;
/** Its line offers Watch again this long after it closed or stopped. */
const LINE_AGAIN_MS = 3 * DAY_MS;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

interface Row {
  readonly watchId: string;
  readonly kind: string;
  readonly source: string;
  readonly about: string;
  readonly closesWhen: string;
  readonly recordKey: string | null;
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly latestBy: number | null;
  readonly setAfterOutside: number;
  readonly state: "open" | "closed" | "stopped";
  readonly lookedAt: number | null;
  readonly nextLookAt: number;
  readonly lastOutcome: KinWatch["lastOutcome"];
  readonly lastLine: string | null;
  readonly askedLookAt: number | null;
  readonly aside: number;
  readonly asideUntil: number | null;
  readonly closedAt: number | null;
  readonly closedHow: string | null;
  readonly closedByKind: "person" | "agent" | "code" | null;
  readonly closedById: string | null;
  readonly closedByName: string | null;
  readonly createdAt: number;
}

const columns = (sql: SqlClient.SqlClient) => sql`w.watch_id AS "watchId", w.kind, w.source,
  w.about, w.closes_when AS "closesWhen", rec.key AS "recordKey", w.agent_id AS "agentId",
  ag.display_name AS "agentName", w.latest_by AS "latestBy",
  w.set_after_outside AS "setAfterOutside", w.state, w.looked_at AS "lookedAt",
  w.next_look_at AS "nextLookAt", w.last_outcome AS "lastOutcome", w.last_line AS "lastLine",
  w.asked_look_at AS "askedLookAt", w.aside, w.aside_until AS "asideUntil",
  w.closed_at AS "closedAt", w.closed_how AS "closedHow", w.closed_by_kind AS "closedByKind",
  w.closed_by_id AS "closedById",
  CASE w.closed_by_kind WHEN 'person' THEN pe.display_name WHEN 'agent' THEN cag.display_name END
    AS "closedByName",
  w.created_at AS "createdAt"`;

const joins = (sql: SqlClient.SqlClient) => sql`kin_watches w
  LEFT JOIN kin_records rec ON rec.org_id = w.org_id AND rec.record_id = w.record_id
  LEFT JOIN kin_agents ag ON ag.org_id = w.org_id AND ag.agent_id = w.agent_id
  LEFT JOIN kin_people pe ON pe.org_id = w.org_id AND pe.person_id = w.closed_by_id
  LEFT JOIN kin_agents cag ON cag.org_id = w.org_id AND cag.agent_id = w.closed_by_id`;

const lineOf = (row: Row, reader: WatchReader): KinWatchLine => {
  const closedBy: KinWatchActor | null =
    row.closedByKind === null
      ? null
      : {
          kind: row.closedByKind,
          name: row.closedByName,
          you: row.closedByKind === "person" && row.closedById === reader.personId,
        };
  return {
    watchId: row.watchId,
    kind: row.kind,
    about: row.about,
    state: row.state,
    lookedAt: isoOrNull(row.lookedAt),
    nextLookAt: row.state === "open" ? iso(row.nextLookAt) : null,
    lastOutcome: row.lastOutcome,
    lastLine: row.lastLine,
    looking: row.state === "open" && row.askedLookAt !== null,
    aside: row.state === "open" && row.aside === 1 ? { until: isoOrNull(row.asideUntil) } : null,
    closedAt: isoOrNull(row.closedAt),
    closedHow: row.closedHow,
    closedBy,
  };
};

const watchOf = (row: Row, reader: WatchReader): KinWatch => ({
  ...lineOf(row, reader),
  source: row.source,
  closesWhen: row.closesWhen,
  recordKey: row.recordKey,
  agentId: row.agentId === null ? null : KinAgentId.make(row.agentId),
  agentName: row.agentName,
  latestBy: isoOrNull(row.latestBy),
  setAfterOutside: row.setAfterOutside === 1,
  createdAt: iso(row.createdAt),
});

/** Every watch this reader may see, or one record's: open first, then the newest. */
export const list = Effect.fn("KinWatches.list")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  input: Pick<KinWatchesListInput, "recordKey">,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM ${joins(sql)}
    WHERE w.org_id = ${orgId} AND ${watchSeen(sql, reader)}
      AND (w.state = 'open' OR w.closed_at >= ${at - LIST_CLOSED_MS})
      ${input.recordKey === undefined ? sql`` : sql`AND rec.key = ${input.recordKey}`}
    ORDER BY w.state = 'open' DESC, COALESCE(w.closed_at, w.created_at) DESC, w.watch_id
    LIMIT ${LIST_CAP}`;
  return { watches: rows.map((row) => watchOf(row, reader)) };
});

/** A record's line: its open watch, else one closed or stopped in the last 3 days. */
export const lineOn = Effect.fn("KinWatches.lineOn")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<Row>`SELECT ${columns(sql)} FROM ${joins(sql)}
    WHERE w.org_id = ${orgId} AND w.record_id = ${recordId} AND ${watchSeen(sql, reader)}
      AND (w.state = 'open' OR w.closed_at >= ${at - LINE_AGAIN_MS})
    ORDER BY w.state = 'open' DESC, COALESCE(w.closed_at, w.created_at) DESC, w.watch_id
    LIMIT 1`;
  return row === undefined ? undefined : lineOf(row, reader);
});

/** Newest first, a run of two or more nothing-new looks folded into one row. */
const foldLooks = (looks: ReadonlyArray<KinWatchLogLook>): ReadonlyArray<KinWatchLogRow> => {
  const rows: Array<KinWatchLogRow> = [];
  let run: Array<KinWatchLogLook> = [];
  const flush = () => {
    if (run.length === 1) rows.push({ _tag: "look", look: run[0]! });
    else if (run.length > 1)
      rows.push({
        _tag: "folded",
        folded: { at: run[0]!.at, count: run.length, looks: run.slice(0, FOLD_SHOWN) },
      });
    run = [];
  };
  for (const look of looks) {
    if (look.outcome === "nothing_new") {
      run.push(look);
      continue;
    }
    flush();
    rows.push({ _tag: "look", look });
  }
  flush();
  return rows;
};

/** One day of the log in the reader's zone (the company's by default), today unless asked. */
export const log = Effect.fn("KinWatches.log")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  input: Pick<KinWatchesLogInput, "timeZone" | "day" | "watchId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const zone = input.timeZone ?? (yield* ownerZone(orgId));
  const day = input.day ?? dayIn(at, zone);
  const from = startOfDay(day, zone);
  const to = endOfDay(day, zone);
  const one = input.watchId === undefined ? sql`` : sql`AND w.watch_id = ${input.watchId}`;
  const looks = yield* sql<{
    lookId: string;
    at: number;
    why: KinWatchLogLook["why"];
    did: KinWatchLogLook["did"];
    outcome: KinWatchLogLook["outcome"];
    line: string;
    watchId: string;
    kind: string;
    about: string;
    recordKey: string | null;
  }>`SELECT l.look_id AS "lookId", l.at, l.why, l.did, l.outcome, l.line, w.watch_id AS "watchId",
      w.kind, w.about, rec.key AS "recordKey"
    FROM kin_watch_looks l
    JOIN kin_watches w ON w.org_id = l.org_id AND w.watch_id = l.watch_id
    LEFT JOIN kin_records rec ON rec.org_id = w.org_id AND rec.record_id = w.record_id
    WHERE l.org_id = ${orgId} AND l.at BETWEEN ${from} AND ${to} AND ${watchSeen(sql, reader)} ${one}
    ORDER BY l.at DESC, l.look_id`;
  const [before] = yield* sql<{ at: number | null }>`SELECT MAX(l.at) AS at
    FROM kin_watch_looks l JOIN kin_watches w ON w.org_id = l.org_id AND w.watch_id = l.watch_id
    WHERE l.org_id = ${orgId} AND l.at < ${from} AND ${watchSeen(sql, reader)} ${one}`;
  const [open] = yield* sql<{ next: number | null; watching: number }>`SELECT
      MIN(w.next_look_at) AS next, COUNT(*) AS watching
    FROM kin_watches w
    WHERE w.org_id = ${orgId} AND w.state = 'open' AND ${watchSeen(sql, reader)} ${one}`;
  return {
    day,
    rows: foldLooks(looks.map((look) => ({ ...look, at: iso(look.at) }))),
    earlier: before?.at == null ? null : dayIn(before.at, zone),
    nextLookAt: isoOrNull(open?.next ?? null),
    watching: open?.watching ?? 0,
  } satisfies KinWatchesLogResult;
});

/** One watch as this reader sees it, or `not_found`. */
export const one = Effect.fn("KinWatches.one")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  watchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Row>`SELECT ${columns(sql)} FROM ${joins(sql)}
    WHERE w.org_id = ${orgId} AND w.watch_id = ${watchId} AND ${watchSeen(sql, reader)}`;
  if (row === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "Kin isn't watching that." });
  return watchOf(row, reader);
});
