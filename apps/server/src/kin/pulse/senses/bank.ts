import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { dayIn, monthOf, shiftMonth } from "../../work/money.ts";
import { endOfDay, owedInvoices, startOfDay } from "../../work/recordRows.ts";
import { bankKnown } from "../../work/statements/bankKnown.ts";
import { DAY_MS, threshold } from "../thresholds.ts";
import { agentOrOwner, iso, type SenseContext, type SensedFact } from "./shared.ts";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const shiftDay = (day: string, days: number) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
const lastDayOf = (month: string) => shiftDay(`${shiftMonth(month, 1)}-01`, -1);

/**
 * statement_missing: the month after the day Kin sees the bank to ended more than the playbook's
 * days ago, and no confirmed statement covers it. Only once a company has confirmed one: before
 * that Money says Kin can't see the bank. One fact per month, so it is told once.
 */
export const statementSenses = Effect.fn("KinPulse.statementSenses")(function* (ctx: SenseContext) {
  const { through, accounts } = yield* bankKnown(ctx.orgId, ctx.at);
  if (through === null) return [];
  // With several accounts, the line names the one whose statement is waited on.
  const behind = accounts.filter((one) => one.keptUp && one.through === through);
  const whose = accounts.length > 1 && behind.length === 1 ? ` for ${behind[0]!.label}` : "";
  const month = monthOf(shiftDay(through, 1));
  const last = lastDayOf(month);
  const due = yield* threshold(ctx.orgId, "statement_due_days");
  const shownFrom = shiftDay(last, due.value + 1);
  if (dayIn(ctx.at, ctx.zone) < shownFrom) return [];
  const monthEnd = endOfDay(last, ctx.zone);
  const waiting = (yield* owedInvoices({ orgId: ctx.orgId, now: ctx.at })).filter(
    (one) => one.dueAt !== null && one.dueAt <= monthEnd,
  ).length;
  const name = `${MONTHS[Number(month.slice(5, 7)) - 1]}${
    month.slice(0, 4) === dayIn(ctx.at, ctx.zone).slice(0, 4) ? "" : ` ${month.slice(0, 4)}`
  }`;
  const fact: SensedFact = {
    sense: "statement_missing",
    family: "money",
    key: `statement_missing:${month}`,
    subject: { kind: "bank", key: `statement:${month}`, title: "Bank statement" },
    scope: {},
    since: iso(startOfDay(shownFrom, ctx.zone)),
    consequence: `${name}'s statement${whose} isn't in yet${
      waiting === 0
        ? "."
        : `: ${waiting === 1 ? "1 invoice" : `${waiting} invoices`} can't be confirmed until it is.`
    }`,
    actor: agentOrOwner(ctx.finance),
    sensitive: true,
    wake: "brief",
  };
  return [fact];
});
