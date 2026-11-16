import type { KinOrgId } from "./kinChat.ts";
import type { KinDocListRow, KinDocRow } from "./kinDocs.ts";
import type { KinPulseFact, KinPulseOutline } from "./kinPulse.ts";
import type { KinRecord, KinRecordCan, KinRecordCompact, KinWorkListResult } from "./kinWork.ts";

// Opt-in wire shapes (`acceptCompactRows`, `acceptSlimLatest`): the server sends them only to a
// client that asked, and the client restores them before any screen reads the answer.

const canKey = (can: KinRecordCan) =>
  JSON.stringify([
    can.states,
    can.edit,
    can.party,
    can.project,
    can.clearProject,
    can.give,
    can.takeBack,
    can.mark,
    can.unmark,
    can.share,
    can.confirm,
  ]);

/** The `can` most rows carry, sent once; none when a row has no `can` to fall back from. */
function sharedCan(records: ReadonlyArray<KinRecord>): KinRecordCan | undefined {
  const counts = new Map<string, { can: KinRecordCan; count: number }>();
  for (const record of records) {
    if (record.can === undefined) return undefined;
    const key = canKey(record.can);
    const held = counts.get(key);
    counts.set(key, { can: record.can, count: (held?.count ?? 0) + 1 });
  }
  let best: { can: KinRecordCan; count: number } | undefined;
  for (const one of counts.values()) if (best === undefined || one.count > best.count) best = one;
  return best?.can;
}

function compactRecord(record: KinRecord, shared: string | undefined): KinRecordCompact {
  const {
    orgId: _orgId,
    waitingOn,
    category,
    dueAt,
    dueAllDay,
    late,
    confirmed,
    sensitive,
    working,
    pullRequest,
    closedAt,
    can,
    ...rest
  } = record;
  return {
    ...rest,
    ...(waitingOn === null ? {} : { waitingOn }),
    ...(category === null ? {} : { category }),
    ...(dueAt === null ? {} : { dueAt }),
    ...(dueAllDay ? { dueAllDay: true as const } : {}),
    ...(late ? { late: true as const } : {}),
    ...(confirmed ? {} : { confirmed: false as const }),
    ...(sensitive ? { sensitive: true as const } : {}),
    ...(working ? { working: true as const } : {}),
    ...(pullRequest === null ? {} : { pullRequest }),
    ...(closedAt === null ? {} : { closedAt }),
    ...(can === undefined || canKey(can) === shared ? {} : { can }),
  };
}

/** The server's side of `acceptCompactRows`. */
export function kinCompactWorkList(result: KinWorkListResult): KinWorkListResult {
  const { records, ...rest } = result;
  const can = sharedCan(records);
  const shared = can === undefined ? undefined : canKey(can);
  return {
    ...rest,
    records: [],
    rows: records.map((record) => compactRecord(record, shared)),
    ...(can === undefined ? {} : { can }),
  };
}

/** The client's side: the page as `records` again, whatever shape the host answered in. */
export function kinRestoreWorkList(result: KinWorkListResult, orgId: KinOrgId): KinWorkListResult {
  if (result.rows === undefined) return result;
  const { rows, can: shared, ...rest } = result;
  return {
    ...rest,
    records: rows.map((row): KinRecord => {
      const can = row.can ?? shared;
      return {
        ...row,
        orgId: row.orgId ?? orgId,
        waitingOn: row.waitingOn ?? null,
        category: row.category ?? null,
        dueAt: row.dueAt ?? null,
        dueAllDay: row.dueAllDay === true,
        late: row.late === true,
        confirmed: row.confirmed !== false,
        sensitive: row.sensitive === true,
        working: row.working === true,
        pullRequest: row.pullRequest ?? null,
        closedAt: row.closedAt ?? null,
        ...(can === undefined ? {} : { can }),
      };
    }),
  };
}

/** The server's side of `acceptSlimLatest`: what a row's line says, and no more. */
export const kinSlimDocRow = (row: KinDocRow): KinDocListRow => ({
  ...row,
  latest: {
    version: row.latest.version,
    at: row.latest.at,
    kind: row.latest.kind,
    summary: row.latest.summary,
    provenance: { by: row.latest.provenance.by },
  },
});

/** Senses a screen puts first, and calls late. */
export const KIN_PULSE_URGENT: ReadonlySet<KinPulseFact["sense"]> = new Set<KinPulseFact["sense"]>([
  "task_late",
  "theirs_late",
  "invoice_overdue",
  "budget_over",
  "worker_failed",
  "goal_behind",
  "milestone_late",
]);

/** The task a fact's row opens, when it opens one. */
export const kinPulseFactRecord = (fact: KinPulseFact): string | null =>
  fact.family === "goals" || fact.subject.kind !== "record" ? null : fact.subject.key;

/**
 * The server's side of a screen's `limit`: the first `limit` open facts in the order Needs you
 * shows them (urgent first, money last, as sensed otherwise), every handled one after them, and
 * the outline of all of them.
 */
export function kinPulsePage<F extends KinPulseFact>(
  facts: ReadonlyArray<F>,
  limit: number,
): { readonly facts: ReadonlyArray<F>; readonly outline: KinPulseOutline } {
  const open = facts.filter((fact) => fact.handled === null);
  const rank = (fact: F) =>
    (fact.family === "money" ? 2 : 0) + (KIN_PULSE_URGENT.has(fact.sense) ? 0 : 1);
  const money = open.filter((fact) => fact.family === "money");
  return {
    facts: [
      ...[...open].sort((a, b) => rank(a) - rank(b)).slice(0, limit),
      ...facts.filter((fact) => fact.handled !== null),
    ],
    outline: {
      open: open.length,
      money: money.length,
      moneyUrgent: money.some((fact) => KIN_PULSE_URGENT.has(fact.sense)),
      records: [...new Set(facts.flatMap((fact) => kinPulseFactRecord(fact) ?? []))],
      invoiceOverdue: facts.some((fact) => fact.key.startsWith("invoice_overdue:")),
    },
  };
}
