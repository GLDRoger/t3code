import {
  KIN_CHOICE_CARD_TTL_MS,
  KIN_PULSE_URGENT,
  type KinOpenRead,
  type KinOpenRow,
  type KinOrgId,
  type KinPersonId,
  type KinWaitingItem,
  KinRecordKey,
  kinPulseFactRecord,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { waitingFor } from "../chat/KinChatService.ts";
import { carriesEntry } from "../connections/ConnectionRows.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { screenFacts } from "../pulse/people.ts";
import { iso, type SensedFact } from "../pulse/senses/shared.ts";
import { validZone } from "../triggers/quietHold.ts";
import { dayIn } from "../work/money.ts";
import { moneyViewer } from "../work/ownerMoney.ts";
import { endOfDay, owedInvoices, ownerZone } from "../work/recordRows.ts";
import { viewSees } from "../work/teamView.ts";

/**
 * Everything open for one person, built at read time from the reads that already exist: the
 * pulse's facts, what waits on them in chats, their own tasks due today, and overdue invoices.
 * Nothing is stored; every visibility rule is the source's own.
 */

const ROW_CAP = 200;
const FACT_CAP = 200;
const CHUNK = 500;

export type OpenViewer = {
  readonly personId: KinPersonId;
  /** From `mayActAsOwner`: the owner and co-owners see every fact. */
  readonly ownerLevel: boolean;
};

/** Why an open waiting row no longer counts: its card's approval, send or question settled. */
export type WaitingSettled = "approval_not_live" | "send_not_open" | "question_settled";

export type OwnTask = {
  readonly key: string;
  readonly title: string;
  readonly dueAt: number;
  readonly dueAllDay: boolean;
  readonly projectTitle: string | null;
  readonly clientTitle: string | null;
};

/** The person's day end: the start of tomorrow in their zone, or the company's. */
export const dayEndFor = Effect.fn("KinOpen.dayEnd")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`;
  const zone = validZone(row?.zone) ?? (yield* ownerZone(orgId));
  return endOfDay(dayIn(at, zone), zone) + 1;
});

/** The person's tasks not closed and due by `dayEnd`, every one of them, soonest first. */
const ownTasks = Effect.fn("KinOpen.ownTasks")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly dayEnd: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    key: string;
    title: string;
    dueAt: number;
    dueAllDay: number;
    projectTitle: string | null;
    clientTitle: string | null;
  }>`SELECT r.key, r.title, r.due_at AS "dueAt", r.due_all_day AS "dueAllDay",
      p.title AS "projectTitle", c.title AS "clientTitle"
    FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = COALESCE(r.party_id, p.party_id)
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'work' AND r.owner_kind = 'person'
      AND r.owner_id = ${input.personId} AND r.state NOT IN ('done', 'dropped')
      AND r.due_at IS NOT NULL AND r.due_at <= ${input.dayEnd}
    ORDER BY r.due_at, r.key`;
  return rows.map((row): OwnTask => ({ ...row, dueAllDay: row.dueAllDay === 1 }));
});

/** Of these open waiting rows, the ones whose card settled another way, and how. */
const settledWaiting = Effect.fn("KinOpen.settledWaiting")(function* (
  orgId: KinOrgId,
  at: number,
  items: ReadonlyArray<KinWaitingItem>,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = items.filter((item) => item.widgetId !== null).map((item) => item.waitingId);
  const settled = new Map<string, WaitingSettled>();
  for (let start = 0; start < ids.length; start += CHUNK)
    for (const row of yield* sql<{ waitingId: string; reason: WaitingSettled | null }>`SELECT
        w.waiting_id AS "waitingId",
        CASE
          WHEN w.reason = 'approval' AND NOT EXISTS (SELECT 1 FROM kin_pending_actions pa
            WHERE pa.org_id = w.org_id AND pa.action_id = json_extract(g.state_json, '$.actionId')
              AND pa.state = 'awaiting_approval' AND pa.expires_at > ${at}) THEN 'approval_not_live'
          WHEN EXISTS (SELECT 1 FROM kin_connection_asks ca WHERE ca.org_id = w.org_id
            AND ca.widget_id = w.widget_id AND (ca.state <> 'open' OR EXISTS (SELECT 1
              FROM kin_records e WHERE e.org_id = ca.org_id AND e.record_id = ca.entry_record_id
                AND e.state = 'dropped' AND ${carriesEntry(sql, "ca")})))
            THEN 'send_not_open'
          WHEN EXISTS (SELECT 1 FROM kin_questions q WHERE q.org_id = w.org_id
              AND (q.widget_id = w.widget_id OR q.raise_widget_id = w.widget_id))
            AND NOT EXISTS (SELECT 1 FROM kin_questions q WHERE q.org_id = w.org_id
              AND q.state = 'open' AND (q.widget_id = w.widget_id OR q.raise_widget_id = w.widget_id))
            THEN 'question_settled'
          -- Kin's suggestion ran out at its time limit, before the sweep closes its card.
          WHEN EXISTS (SELECT 1 FROM kin_recommendations r WHERE r.org_id = w.org_id
              AND r.widget_id = w.widget_id AND r.state = 'open'
              AND r.posted_at <= ${at - KIN_CHOICE_CARD_TTL_MS})
            THEN 'question_settled'
        END AS reason
      FROM kin_waiting w
      LEFT JOIN kin_widgets g ON g.org_id = w.org_id AND g.widget_id = w.widget_id
      WHERE w.org_id = ${orgId} AND w.waiting_id IN ${sql.in(ids.slice(start, start + CHUNK))}
        AND w.widget_id IS NOT NULL
      ORDER BY w.waiting_id`)
      if (row.reason !== null) settled.set(row.waitingId, row.reason);
  return settled;
});

/** Overdue invoices this viewer may read, or null when Money is not theirs to read. */
const overdueFor = Effect.fn("KinOpen.overdue")(function* (
  orgId: KinOrgId,
  viewer: OpenViewer,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const teammate = viewer.ownerLevel
    ? undefined
    : yield* moneyViewer(orgId, viewer.personId).pipe(
        Effect.map((person) => ({ person })),
        Effect.catchIf(
          (error) => error._tag === "KinChatError" && error.reason === "not_allowed",
          () => Effect.succeed(null),
        ),
      );
  if (teammate === null) return null;
  const owed = yield* owedInvoices({
    orgId,
    now: at,
    ...(teammate?.person === undefined ? {} : { seen: viewSees(sql, [teammate.person]) }),
  });
  return owed.filter((invoice) => invoice.overdue).length;
});

/**
 * Each source as read for this viewer, before it becomes rows: what the list is built from, and
 * what the shadow compares against today's client composition.
 */
export const sources = Effect.fn("KinOpen.sources")(function* (input: {
  readonly orgId: KinOrgId;
  readonly viewer: OpenViewer;
  readonly at: number;
  readonly acceptSenses?: ReadonlyArray<string> | undefined;
  /** What a tick already sensed (`KinPulse.lastTick`), instead of sensing again. */
  readonly sensed?: ReadonlyArray<SensedFact> | undefined;
}) {
  const { orgId, viewer, at } = input;
  const pulse = yield* KinPulse.read({
    orgId,
    at,
    sensed: input.sensed,
    viewer: viewer.ownerLevel ? { _tag: "owner" } : { _tag: "people", people: [viewer.personId] },
    includeHandled: true,
    limit: FACT_CAP,
  });
  const facts = screenFacts(pulse.facts, input.acceptSenses);
  // A fact on a record stands for its task, handled or not, as Needs you shows it today.
  const covered = new Set(facts.flatMap((fact) => kinPulseFactRecord(fact) ?? []));
  const waiting = yield* waitingFor(
    { _tag: "person", orgId, personId: viewer.personId },
    { others: true },
  );
  const dayEnd = yield* dayEndFor(orgId, viewer.personId, at);
  return {
    facts: facts.filter((fact) => fact.handled === null),
    covered,
    invoiceFact: facts.some((fact) => fact.key.startsWith("invoice_overdue:")),
    waiting,
    settled: yield* settledWaiting(orgId, at, waiting),
    dayEnd,
    tasks: yield* ownTasks({ orgId, personId: viewer.personId, dayEnd }),
    overdue: yield* overdueFor(orgId, viewer, at),
  };
});
export type OpenSources = Effect.Success<ReturnType<typeof sources>>;

/** The list from its sources: every row counted, the first `cap` sent, in Needs you's order. */
export const rowsOf = (from: OpenSources, at: number, cap = ROW_CAP): KinOpenRead => {
  const ranked: Array<{ readonly rank: number; readonly at: number; readonly row: KinOpenRow }> =
    [];
  for (const fact of from.facts) {
    const urgent = KIN_PULSE_URGENT.has(fact.sense);
    ranked.push({
      rank: fact.family === "money" ? 2 : urgent ? 0 : 1,
      at: DateTime.toEpochMillis(fact.since),
      row: { id: `fact:${fact.key}`, late: urgent, item: { _tag: "fact", fact } },
    });
  }
  for (const task of from.tasks) {
    if (from.covered.has(task.key)) continue;
    const late = task.dueAt < at;
    ranked.push({
      rank: late ? 3 : 6,
      at: task.dueAt,
      row: {
        id: `task:${task.key}`,
        late,
        item: {
          _tag: "task",
          key: KinRecordKey.make(task.key),
          title: task.title,
          dueAt: iso(task.dueAt),
          ...(task.dueAllDay ? { dueAllDay: true } : {}),
          ...(task.projectTitle === null ? {} : { projectTitle: task.projectTitle }),
          ...(task.clientTitle === null ? {} : { clientTitle: task.clientTitle }),
        },
      },
    });
  }
  if (from.overdue !== null && from.overdue > 0 && !from.invoiceFact)
    ranked.push({
      rank: 4,
      at: 0,
      row: { id: "money:overdue", late: true, item: { _tag: "money", invoices: from.overdue } },
    });
  let waiting = 0;
  let others = 0;
  for (const item of from.waiting) {
    if (from.settled.has(item.waitingId)) continue;
    // Someone else's, to look at only: listed last, and counted as nobody's need here.
    if (item.waitsFor === undefined) waiting += 1;
    else others += 1;
    ranked.push({
      rank: item.waitsFor === undefined ? 5 : 7,
      at: DateTime.toEpochMillis(DateTime.makeUnsafe(item.createdAt)),
      row: {
        id: `waiting:${item.waitingId}`,
        late: false,
        item: { _tag: "waiting", waiting: item },
      },
    });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank || a.at - b.at || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
  );
  return {
    asOf: iso(at),
    counts: { needsYou: ranked.length - others, waiting },
    rows: ranked.slice(0, cap).map((one) => one.row),
  };
};

/** Everything open for one person as of `at`, from one read-only transaction. */
export const compute = Effect.fn("KinOpen.compute")(function* (input: {
  readonly orgId: KinOrgId;
  readonly viewer: OpenViewer;
  readonly at: number;
  readonly acceptSenses?: ReadonlyArray<string> | undefined;
  readonly sensed?: ReadonlyArray<SensedFact> | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const from = yield* sql.withTransaction(sources(input)).pipe(NodeSqliteClient.readOnly);
  return rowsOf(from, input.at);
});
