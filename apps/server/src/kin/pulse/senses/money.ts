import { KinMoney } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { budgetsAnswer, budgetsView } from "../../work/budgets.ts";
import { formatMoneyPlain } from "../../work/money.ts";
import { countedEntry, daysOverdue, endOfDay, invoiceDue } from "../../work/recordRows.ts";
import { DAY_MS, type Threshold, threshold, toMs } from "../thresholds.ts";
import { statementSenses } from "./bank.ts";
import {
  agentOrOwner,
  dayOf,
  daysText,
  elapsed,
  entryColumns,
  entryJoins,
  entryScope,
  entrySubject,
  iso,
  measure,
  type EntryRow,
  type SenseContext,
  type SensedFact,
} from "./shared.ts";
import { SENSE_CAP } from "./work.ts";

type ClientKey =
  | "chase_invoice_after_days"
  | "quote_follow_up_days"
  | "renewal_heads_up_days"
  | "renewal_draft_days";
// The longest heads-up a playbook may set (`playbooks.ts` bounds).
const RENEWAL_WIDEST_MS = 120 * DAY_MS;

const decodeMoney = Schema.decodeUnknownOption(Schema.fromJsonString(KinMoney));
/** A project's value as stored in its fields, when it is an amount. */
const projectValue = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeMoney(json));

const amountText = (row: Pick<EntryRow, "amountMinor" | "currency">) =>
  row.amountMinor === null || row.currency === null
    ? undefined
    : formatMoneyPlain({ minor: row.amountMinor, currency: row.currency });

/** Money facts are the owner's alone and go to the Finance agent, else the Chief of staff. */
const moneyFact = (
  ctx: SenseContext,
  row: EntryRow,
  fact: Pick<SensedFact, "sense" | "key" | "since" | "consequence" | "wake"> &
    Partial<Pick<SensedFact, "measure">>,
): SensedFact => ({
  family: "money",
  subject: entrySubject(row),
  scope: entryScope(row),
  actor: agentOrOwner(ctx.finance),
  sensitive: true,
  ...fact,
});

export const moneySenses = Effect.fn("KinPulse.moneySenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];
  const retainer = yield* threshold(orgId, "retainer_heads_up_days");
  // A client's own playbook may set these, so SQL takes the widest window and each row is checked.
  const cached = new Map<string, Threshold>();
  const forClient = Effect.fnUntraced(function* (key: ClientKey, clientId: string | null) {
    const id = `${key}:${clientId ?? ""}`;
    const known = cached.get(id);
    if (known !== undefined) return known;
    const found = yield* threshold(orgId, key, clientId ?? undefined);
    cached.set(id, found);
    return found;
  });

  // invoice_overdue: issued, still owed, and past its due date (else its client's terms) plus the grace.
  const invoices = yield* sql<EntryRow & { base: number; paid: number }>`SELECT * FROM (
    SELECT ${entryColumns(sql)}, ${invoiceDue(sql)} AS base,
      (SELECT COALESCE(SUM(pay.amount_minor), 0) FROM kin_record_payments pay
        WHERE pay.org_id = r.org_id AND pay.record_id = r.record_id AND pay.voided_at IS NULL) AS paid
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND ${countedEntry(sql)}
      AND r.state = 'waiting' AND r.amount_minor IS NOT NULL)
    WHERE base IS NOT NULL AND base <= ${at - DAY_MS} AND "amountMinor" > paid
    ORDER BY base, key LIMIT ${SENSE_CAP}`;
  for (const row of invoices) {
    const chase = yield* forClient("chase_invoice_after_days", row.clientId);
    if (row.base > at - toMs(chase)) continue;
    const days = daysOverdue(row.base, at, ctx.zone);
    const owed = formatMoneyPlain({ minor: row.amountMinor! - row.paid, currency: row.currency! });
    facts.push(
      moneyFact(ctx, row, {
        sense: "invoice_overdue",
        key: `invoice_overdue:${row.key}:base=${row.base}`,
        since: iso(row.base + toMs(chase)),
        measure: measure(days, chase),
        consequence: `${owed} owed, ${daysText(days)} past due (${dayOf(ctx, row.base)}).`,
        wake: "now",
      }),
    );
  }

  // quote_unanswered: sent, and nothing recorded on it since for the threshold.
  const quotes = yield* sql<EntryRow & { lastAt: number }>`SELECT * FROM (
    SELECT ${entryColumns(sql)}, COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND ${countedEntry(sql)}
      AND r.state = 'waiting')
    WHERE "lastAt" <= ${at - DAY_MS}
    ORDER BY "lastAt", key LIMIT ${SENSE_CAP}`;
  for (const row of quotes) {
    const followUp = yield* forClient("quote_follow_up_days", row.clientId);
    if (row.lastAt > at - toMs(followUp)) continue;
    const days = elapsed(row.lastAt, at, "days");
    const amount = amountText(row);
    facts.push(
      moneyFact(ctx, row, {
        sense: "quote_unanswered",
        key: `quote_unanswered:${row.key}:last=${row.lastAt}`,
        since: iso(row.lastAt + toMs(followUp)),
        measure: measure(days, followUp),
        consequence: `Quote${amount === undefined ? "" : ` for ${amount}`} sent, with no answer recorded for ${daysText(days)}.`,
        wake: "sweep",
      }),
    );
  }

  // retainer_due: a repeating invoice's next one is still a draft as its day comes up.
  const drafts = yield* sql<EntryRow & { goesOut: number; kept: number }>`SELECT * FROM (
    SELECT ${entryColumns(sql)}, COALESCE(r.date_at, r.due_at) AS "goesOut", r.confirmed AS kept
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND r.state = 'open'
      AND r.repeat_json IS NOT NULL)
    WHERE "goesOut" IS NOT NULL AND "goesOut" <= ${at + toMs(retainer)}
    ORDER BY "goesOut", key LIMIT ${SENSE_CAP}`;
  for (const row of drafts) {
    const amount = row.kept === 1 ? amountText(row) : undefined;
    const days = elapsed(at, row.goesOut, "days");
    facts.push(
      moneyFact(ctx, row, {
        sense: "retainer_due",
        key: `retainer_due:${row.key}:on=${row.goesOut}`,
        since: iso(row.goesOut - toMs(retainer)),
        measure: measure(days, retainer),
        consequence: `Repeating invoice${amount === undefined ? "" : ` for ${amount}`} goes out ${dayOf(ctx, row.goesOut)}${row.goesOut < at ? ", already passed" : ""}; it is still a draft${row.kept === 1 ? "" : " that waits on Keep"}.`,
        wake: "sweep",
      }),
    );
  }

  // renewal_due: a renewal in Dates or Subscriptions, or an open project's renews-on day, coming
  // up within the heads-up or passed and still open. One renewal is one fact.
  const listed = yield* sql<EntryRow & { kept: number }>`SELECT ${entryColumns(sql)},
      r.confirmed AS kept
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId}
      AND ((r.register_id = 'dates' AND r.category = 'renewal') OR r.register_id = 'subscriptions')
      AND r.state IN ('open', 'doing', 'waiting') AND r.due_at IS NOT NULL
      AND r.due_at <= ${at + RENEWAL_WIDEST_MS}
    ORDER BY r.due_at, r.key LIMIT ${SENSE_CAP}`;
  const projects = yield* sql<
    EntryRow & { renewsOn: string; value: string | null; kept: number }
  >`SELECT
      ${entryColumns(sql)}, json_extract(r.fields_json, '$.renewsOn') AS "renewsOn",
      json_extract(r.fields_json, '$.value') AS value, r.confirmed AS kept
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'projects' AND r.state = 'open'
      AND json_extract(r.fields_json, '$.renewsOn') IS NOT NULL
    ORDER BY "renewsOn", r.key LIMIT ${SENSE_CAP}`;
  // A suggested renewal is still a day to know, but its fee is nobody's yet.
  const renewals: Array<EntryRow> = listed.map((row) =>
    row.kept === 1 ? row : { ...row, amountMinor: null, currency: null },
  );
  for (const project of projects) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(project.renewsOn)) continue;
    const dueAt = endOfDay(project.renewsOn, ctx.zone);
    if (dueAt > at + RENEWAL_WIDEST_MS) continue;
    const day = project.renewsOn;
    // The same renewal tracked in Dates too, for this project or its client, is that one.
    if (
      listed.some(
        (row) =>
          row.kept === 1 &&
          dayOf(ctx, row.dueAt!) === day &&
          (row.projectKey === project.key ||
            (row.projectKey === null &&
              row.clientId !== null &&
              row.clientId === project.clientId)),
      )
    )
      continue;
    const value = project.kept === 1 ? projectValue(project.value) : undefined;
    renewals.push({
      ...project,
      dueAt,
      projectKey: project.key,
      projectTitle: project.title,
      amountMinor: value?.minor ?? null,
      currency: value?.currency ?? null,
    });
  }
  for (const row of renewals.toSorted((a, b) => a.dueAt! - b.dueAt! || (a.key < b.key ? -1 : 1))) {
    const renewal = yield* forClient("renewal_heads_up_days", row.clientId);
    if (row.dueAt! > at + toMs(renewal)) continue;
    // Mentioned from the heads-up; handed over to be drafted only from the draft day.
    const draftFrom = row.dueAt! - toMs(yield* forClient("renewal_draft_days", row.clientId));
    const stage = at < draftFrom ? "heads_up" : "draft";
    const amount = amountText(row);
    const days = elapsed(at, row.dueAt!, "days");
    facts.push({
      ...moneyFact(ctx, row, {
        sense: "renewal_due",
        key: `renewal_due:${row.key}:due=${row.dueAt}`,
        since: iso(row.dueAt! - toMs(renewal)),
        measure: measure(days, renewal),
        consequence: `Renewal due ${dayOf(ctx, row.dueAt!)}${row.dueAt! < at ? ", already passed" : `, in ${daysText(days)}`}${amount === undefined ? "" : ` (${amount})`}${stage === "heads_up" ? `; drafting starts ${dayOf(ctx, draftFrom)}, not before` : ""}.`,
        wake: "sweep",
      }),
      stage,
    });
  }

  // budget_over and budget_near: this month's spending against each limit.
  const view = yield* budgetsView(orgId, at);
  const answer = budgetsAnswer(view);
  view.budgets.forEach((budget, index) => {
    if (budget.status === "ok") return;
    const shown = answer.budgets[index]!;
    const percent =
      budget.limitMinor === 0 ? 100 : Number((budget.spent * 100n) / BigInt(budget.limitMinor));
    const sense = budget.status === "over" ? "budget_over" : "budget_near";
    facts.push({
      sense,
      family: "money",
      key: `${sense}:${budget.budgetId}:${view.month}`,
      subject: {
        kind: "budget",
        key: budget.budgetId,
        title: shown.for === "" ? "All spending" : shown.for,
      },
      scope: {
        ...(budget.projectKey === null ? {} : { projectKey: budget.projectKey }),
        ...(budget.projectTitle === null ? {} : { projectTitle: budget.projectTitle }),
      },
      since: iso(at),
      measure: { value: percent, unit: "percent", threshold: 100, from: { _tag: "default" } },
      consequence: `${shown.spent} spent of a ${shown.limit} limit in ${view.month}${"over" in shown ? `, ${shown.over} over` : ""}.`,
      actor: agentOrOwner(ctx.finance),
      sensitive: true,
      wake: sense === "budget_over" ? "now" : "brief",
    });
  });
  facts.push(...(yield* statementSenses(ctx)));
  return facts;
});
