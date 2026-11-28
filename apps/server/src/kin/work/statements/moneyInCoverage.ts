import type { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DAY_MS } from "../../durations.ts";
import { dayIn } from "../money.ts";
import { endOfDay, startOfDay } from "../recordRows.ts";
import { confirmedCoverage, shortDay, type BankCoverage } from "./bankKnown.ts";
import { last4 } from "./bankList.ts";
import { companyAlertMailbox, list, liveHeldMail } from "./bankSenderRows.ts";

const epoch = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const checkDay = (day: string, offset: number) =>
  DateTime.formatIsoDate(DateTime.makeUnsafe(epoch(day) + offset * DAY_MS));
export const dayGap = (from: string, to: string) => (epoch(to) - epoch(from)) / DAY_MS;
export const niceRange = (from: string, through: string) =>
  `${shortDay(from)} to ${shortDay(through)}`;

export type CheckDays = {
  readonly from: string;
  readonly through: string;
  readonly account?: string | undefined;
};
type ReadRange = { first: number; last: number };
type Account = {
  label: string;
  digits: string | null;
  statements: Array<BankCoverage>;
  alerts?: ReadRange;
};

const mergeSpans = (spans: ReadonlyArray<BankCoverage>) => {
  const runs: Array<BankCoverage> = [];
  for (const span of spans.toSorted(
    (a, b) => a.from.localeCompare(b.from) || a.through.localeCompare(b.through),
  )) {
    const previous = runs.at(-1);
    if (previous === undefined || dayGap(previous.through, span.from) > 1) runs.push(span);
    else if (span.through > previous.through)
      runs[runs.length - 1] = { ...previous, through: span.through };
  }
  return runs;
};

const when = (first: number, last: number, zone: string) =>
  niceRange(dayIn(first, zone), dayIn(last, zone));
const onRange = (first: number, last: number, zone: string) =>
  dayIn(first, zone) === dayIn(last, zone)
    ? `on ${shortDay(dayIn(first, zone))}`
    : `between ${shortDay(dayIn(first, zone))} and ${shortDay(dayIn(last, zone))}`;

export const coverageOf = Effect.fn("KinMoneyInCheck.coverage")(function* (
  orgId: KinOrgId,
  input: CheckDays,
  zone: string,
  now: number,
  bankList: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const today = dayIn(now, zone);
  const from = startOfDay(input.from, zone);
  const through = Math.min(now, endOfDay(input.through, zone));
  const selected = (digits: string | null) =>
    input.account === undefined || digits === input.account;
  const accounts = new Map<string, Account>();
  const seen = new Set<string>();
  const accept = (bank: string, digits: string | null) => {
    const label = digits === null ? bank : bank === "" ? `••${digits}` : `${bank} ••${digits}`;
    const key = label.toLowerCase();
    const prior = accounts.get(key);
    if (prior !== undefined) return prior;
    const account: Account = { label, digits, statements: [] };
    accounts.set(key, account);
    return account;
  };
  const statements = (yield* confirmedCoverage(orgId)).filter((one) => selected(last4(one.label)));
  for (const span of statements) {
    const digits = last4(span.label);
    if (digits !== null) seen.add(digits);
    const bank = span.label.replace(/(?:^| )Account(?: ••\d{4})?$/, "").trim();
    accept(bank || (digits === null ? "Bank account" : ""), digits).statements.push(span);
  }
  const allSenders = yield* list(orgId);
  const senders = allSenders.filter((one) => one.state === "approved");
  for (const sender of senders)
    for (const digits of sender.accounts) if (selected(digits)) accept(sender.bankName, digits);

  const alertRows = yield* sql<{
    bank: string;
    digits: string | null;
    first: number;
    last: number;
    count: number;
    read: number;
  }>`SELECT s.bank_name AS bank, a.account AS digits, MIN(a.sent_at) AS first,
      MAX(a.sent_at) AS last, COUNT(*) AS count, (a.outcome IN ('recorded', 'duplicate')) AS read
    FROM kin_bank_alerts a
    JOIN kin_bank_senders s ON s.org_id = a.org_id AND s.address = a.sender_address
      AND s.state = 'approved'
    JOIN kin_connections c ON c.org_id = a.org_id AND c.connection_id = a.connection_id
    WHERE a.org_id = ${orgId} AND c.person_id IS NULL
      AND a.sent_at BETWEEN ${from} AND ${through}
      AND a.outcome IN ('recorded', 'duplicate', 'unparsed', 'unverified')
      AND (${input.account ?? null} IS NULL OR a.account = ${input.account ?? null}
        OR (a.account IS NULL AND ${input.account ?? null} IN (SELECT value FROM json_each(s.accounts_json))))
    GROUP BY s.bank_name, a.account, read ORDER BY s.bank_name, a.account, read`;
  const unread = new Map<string, ReadRange & { count: number }>();
  for (const row of alertRows) {
    if (row.read) {
      if (row.digits !== null) seen.add(row.digits);
      accept(row.bank, row.digits).alerts = row;
    } else {
      const prior = unread.get(row.bank);
      unread.set(row.bank, {
        count: row.count + (prior?.count ?? 0),
        first: Math.min(row.first, prior?.first ?? row.first),
        last: Math.max(row.last, prior?.last ?? row.last),
      });
    }
  }

  if (bankList !== undefined) {
    const known = yield* sql<{
      digits: string;
    }>`SELECT DISTINCT substr(json_extract(fields_json, '$.account'), -4) AS digits
      FROM kin_records WHERE org_id = ${orgId} AND register_id = ${bankList}
        AND substr(json_extract(fields_json, '$.account'), -4) GLOB '[0-9][0-9][0-9][0-9]'`;
    for (const { digits } of known)
      if (selected(digits)) {
        seen.add(digits);
        if (![...accounts.values()].some((account) => account.digits === digits))
          accept("", digits);
      }
  }

  const relevantStatements: Array<BankCoverage> = [];
  const covered = [...accounts.values()].map((account) => {
    const spans = account.statements
      .map((s) => ({ ...s, through: s.through < today ? s.through : today }))
      .filter((s) => s.from <= s.through && s.from <= input.through && s.through >= input.from);
    const runs = [
      ...Map.groupBy(spans, (one) => `${one.account}:${one.currency}`).values(),
    ].flatMap(mergeSpans);
    relevantStatements.push(...runs);
    const descriptions = [...new Set(runs.map((s) => niceRange(s.from, s.through)))].map(
      (range) => `statement confirmed for ${range}, so every credit on those days is checked.`,
    );
    const alerts =
      account.alerts === undefined
        ? undefined
        : `Alert mails from ${when(account.alerts.first, account.alerts.last, zone)} are checked, and they show only what the bank mailed about.`;
    if (descriptions.length > 0) {
      const fullyCovered = runs.some((s) => s.from <= input.from && s.through >= input.through);
      return `${account.label}: ${[...descriptions, ...(alerts === undefined || fullyCovered ? [] : [alerts])].join(" ")}`;
    }
    if (alerts !== undefined)
      return `${account.label}: no statement for ${niceRange(input.from, input.through)}. ${alerts}`;
    return `${account.digits === null ? account.label : `••${account.digits}`}: nothing from the bank for these days, so payments into it are not checked.`;
  });

  const approved = new Map<string, number>();
  for (const sender of senders) {
    if (sender.decidedAt === null || !sender.accounts.some(selected)) continue;
    const prior = approved.get(sender.bankName);
    approved.set(sender.bankName, Math.min(sender.decidedAt, prior ?? sender.decidedAt));
  }
  for (const [bank, at] of approved) {
    const approvedOn = dayIn(at, zone);
    const replayedEarlier = alertRows.some(
      (row) => row.read === 1 && row.bank === bank && dayIn(row.first, zone) < approvedOn,
    );
    if (approvedOn > input.from && !replayedEarlier)
      covered.push(
        `Kin reads ${bank}'s alerts only from ${shortDay(approvedOn)}, when they were approved; earlier days are not checked.`,
      );
  }
  for (const [bank, one] of unread)
    covered.push(
      `${one.count} alert mail${one.count === 1 ? "" : "s"} from ${bank} sent ${onRange(one.first, one.last, zone)} could not be read; any money in them is not checked.`,
    );

  const gaps = yield* sql<{
    first: number;
    last: number;
  }>`SELECT DISTINCT a.received_at AS first, a.noticed_at AS last
    FROM kin_arrivals a JOIN kin_connections c ON c.org_id = a.org_id AND c.connection_id = a.connection_id
    WHERE a.org_id = ${orgId} AND ${companyAlertMailbox(sql)} AND a.class = 'gap' AND a.settled_at IS NOT NULL
      AND a.received_at <= ${through} AND a.noticed_at >= ${from} AND a.noticed_at <= ${now}
    ORDER BY first, last`;
  for (const gap of gaps)
    covered.push(
      `Kin couldn't read the company mailbox ${onRange(gap.first, gap.last, zone)}; alerts sent then haven't been looked at.`,
    );

  const candidates = new Map(
    allSenders.filter((one) => one.state === "candidate").map((one) => [one.address, one.bankName]),
  );
  const held = Map.groupBy(
    yield* liveHeldMail(orgId, now, { from, through }),
    (one) => one.address,
  );
  for (const [address, rows] of held) {
    const bank = candidates.get(address);
    if (bank === undefined) continue;
    const count = rows.reduce((acc, row) => acc + row.count, 0);
    covered.push(
      `Kin is holding ${count} mail${count === 1 ? "" : "s"} from ${address} until you say whether it is ${bank}'s alert address.`,
    );
  }
  return { seen, covered, statements: relevantStatements };
});
