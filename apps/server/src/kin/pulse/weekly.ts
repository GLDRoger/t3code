import { formatKinWhen, KIN_TEXT_LOCALE } from "@t3tools/contracts";
import type { KinEvent, KinMoney, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sentMail } from "../connections/Sending.ts";
import { goalLine, goalsNow } from "../work/goals.ts";
import { homeCurrency, readProfile } from "../work/companyProfile.ts";
import { projectHealths } from "../work/crm.ts";
import { weeklyPipelineOf } from "../work/dealStages.ts";
import { mondayCounts } from "../work/deals.ts";
import { aboutTotal, addUp, dayIn, formatMoney, formatMoneyPlain } from "../work/money.ts";
import { playbookThreshold } from "../work/playbooks.ts";
import {
  countedEntry,
  countedPayment,
  moneyDay,
  keptEntry,
  overdueFor,
  owedInvoices,
  ownerZone,
  recordName,
} from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import { DAY_MS } from "./thresholds.ts";

export const WEEKLY_RULE =
  "This is the weekly brief, the owner's one post this morning. Kin writes the week's figures into the page as its own section: goals, money, overdue invoices, open quotes, renewals, cold and quiet clients, projects behind and meetings. Below is the rest of the week, for your judgement: how projects moved, last week's meetings, who is overloaded or free, and what falls due next week. In a few short lines: what matters most this week and why, and each decision as what you did or will do and how to stop it. A meeting that already happened is not coming up; a follow-up you set is not a meeting. An overdue invoice's fact says what mail went and what waits on a Confirm, as recorded now: never call something sent a draft.";
/** The seeded weekly check-in's schedule (`checkin-<slug>`), which arrives as a pulse event. */
const WEEKLY_CHECK_IN = "checkin-weekly";
/** A page the week's figures go on: the weekly brief, or the morning one on its day. */
export const wantsWeekly = (events: ReadonlyArray<KinEvent>) =>
  events.some(
    (event) =>
      (event._tag === "routine" && event.weekly === true) ||
      (event._tag === "pulse" &&
        (event.checkIn?.scheduleId === WEEKLY_CHECK_IN || event.checkIn?.figures === true)),
  );
/** The seeded morning check-in, which carries what the retired morning brief did. */
const MORNING_CHECK_IN = "checkin-morning";
export const isMorningCheckIn = (event: KinEvent) =>
  event._tag === "pulse" && event.checkIn?.scheduleId === MORNING_CHECK_IN;
/** The seeded evening check-in, which carries what the retired evening summary did. */
const EVENING_CHECK_IN = "checkin-evening";
export const isEveningCheckIn = (event: KinEvent) =>
  event._tag === "pulse" && event.checkIn?.scheduleId === EVENING_CHECK_IN;
const WEEK_MS = 7 * DAY_MS;
const FREE_HORIZON_MS = 3 * DAY_MS;
const LATE_OVERLOAD = 3;
const CAP = 20;
const OPEN = ["open", "doing", "waiting"] as const;

const RENEWALS_AHEAD_MS = 30 * DAY_MS;
const NO_OUTCOME = "no outcome noted yet";
const INVOICE_DUE = " (invoice due)";

/**
 * The week for the owner's weekly brief, counted from Kin's rows: goals first, then projects by
 * how they moved, money in and out and what is overdue, who is overloaded or free, and next week.
 */
const weekRows = Effect.fn("KinWeekly.rows")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, now } = input;
  const zone = yield* ownerZone(orgId);
  const home = yield* homeCurrency(orgId);
  const totals = (amounts: ReadonlyArray<KinMoney>) => addUp(amounts, home).map(formatMoney);
  const weekAgo = now - WEEK_MS;
  const when = (ms: number) => formatKinWhen(ms, "dayTime", { zone, locale: KIN_TEXT_LOCALE });
  const goals = (yield* goalsNow(orgId, now, { money: true })).goals.filter(
    (goal) => goal.state === "open",
  );

  const projects = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    state: string;
    dueAt: number | null;
    client: string | null;
    open: number;
    late: number;
    done: number;
    changes: number;
  }>`SELECT p.record_id AS "recordId", p.key, p.title, p.state, p.due_at AS "dueAt", c.title AS client,
      (SELECT COUNT(*) FROM kin_records t WHERE t.org_id = p.org_id
        AND t.project_id = p.record_id AND t.register_id = 'work'
        AND t.state IN ${sql.in(OPEN)}) AS open,
      (SELECT COUNT(*) FROM kin_records t WHERE t.org_id = p.org_id
        AND t.project_id = p.record_id AND t.register_id = 'work'
        AND t.state IN ${sql.in(OPEN)} AND t.due_at < ${now}) AS late,
      (SELECT COUNT(*) FROM kin_records t WHERE t.org_id = p.org_id
        AND t.project_id = p.record_id AND t.register_id IN ('work', 'milestones')
        AND t.state = 'done' AND t.closed_at >= ${weekAgo}) AS done,
      (SELECT COUNT(*) FROM kin_record_changes ch
        JOIN kin_records t ON t.org_id = ch.org_id AND t.record_id = ch.record_id
        WHERE ch.org_id = p.org_id AND ch.at >= ${weekAgo}
          AND (t.record_id = p.record_id OR t.project_id = p.record_id)) AS changes
    FROM kin_records p
    LEFT JOIN kin_records c ON c.org_id = p.org_id AND c.record_id = p.party_id
    WHERE p.org_id = ${orgId} AND p.register_id = 'projects'
      AND (p.state = 'open' OR (p.state = 'done' AND p.closed_at >= ${weekAgo}))
    ORDER BY p.due_at IS NULL, p.due_at, p.key
    LIMIT ${CAP}`;
  const health = yield* projectHealths(
    orgId,
    now,
    projects.map((project) => project.recordId),
  );
  const byStatus: Record<"behind" | "moving" | "quiet" | "done", Array<string>> = {
    behind: [],
    moving: [],
    quiet: [],
    done: [],
  };
  for (const project of projects) {
    // Off track, less an overdue invoice or a quiet client: Overdue and Quiet clients list those.
    const because = health.get(project.recordId)?.because;
    const waiting = because?.waitingOverAWeek ?? 0;
    const status =
      project.state === "done"
        ? "done"
        : because !== undefined && (because.targetPassed || because.late > 0 || waiting > 0)
          ? "behind"
          : project.changes === 0
            ? "quiet"
            : "moving";
    byStatus[status].push(
      [
        `${project.key} ${project.title}${project.client === null ? "" : ` (${project.client})`}`,
        project.done > 0 ? `${project.done} done this week` : null,
        project.state === "done" ? null : `${project.open} open`,
        project.late > 0 ? `${project.late} late` : null,
        waiting > 0 ? `${waiting} waiting over a week` : null,
        project.dueAt === null ? null : `target ${dayIn(project.dueAt, zone)}`,
      ]
        .filter((part) => part !== null)
        .join(", "),
    );
  }

  const received = yield* sql<KinMoney>`SELECT p.amount_minor AS minor, p.currency
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND ${countedPayment(sql)} AND p.withheld = 0
      AND r.register_id IN ('invoices', 'receipts') AND p.paid_on >= ${dayIn(weekAgo, zone)}
    ORDER BY p.paid_on, p.payment_id`;
  const spent = yield* sql<KinMoney>`SELECT r.amount_minor AS minor, r.currency
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND ${countedEntry(sql)}
      AND r.state = 'done' AND r.amount_minor IS NOT NULL AND ${moneyDay(sql)} >= ${weekAgo}
    ORDER BY r.key`;
  const owed = (yield* owedInvoices({ orgId, now })).slice(0, CAP);
  const isOverdue = (one: (typeof owed)[number]) => one.overdue;
  // What went out about an overdue invoice, and what waits on a Confirm, as recorded now.
  const recent = owed.some(isOverdue) ? yield* sentMail({ orgId, limit: 50 }) : [];
  const mailState = Effect.fnUntraced(function* (one: (typeof owed)[number]) {
    const [first] = yield* sentMail({ orgId, recordIds: [one.recordId], limit: 1 });
    if (first === undefined) return "no mail with it on record";
    const thread = first.threadId;
    const later = recent.find((mail) => mail.threadId === thread && mail.at > first.at);
    const waiting =
      thread === null
        ? []
        : yield* sql`SELECT 1 FROM kin_connection_asks WHERE org_id = ${orgId}
            AND state = 'open' AND json_extract(payload_json, '$.threadId') = ${thread} LIMIT 1`;
    return [
      `sent ${dayIn(Date.parse(first.at), zone)} from ${first.from}`,
      later === undefined
        ? "no reminder since"
        : `reminder sent ${dayIn(Date.parse(later.at), zone)}`,
      ...(waiting.length > 0 ? ["a reply waits on the owner's Confirm"] : []),
    ].join(", ");
  });
  const overdueMail = new Map<string, string>();
  for (const one of owed.filter(isOverdue)) overdueMail.set(one.recordId, yield* mailState(one));

  const quotes = yield* sql<{
    key: string;
    client: string | null;
    minor: number | null;
    currency: string | null;
    state: string;
    number: unknown;
  }>`SELECT r.key, c.title AS client, r.amount_minor AS minor, r.currency, r.state,
      json_extract(r.fields_json, '$.number') AS number
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND r.state IN ('open', 'waiting')
      AND ${countedEntry(sql)}
    ORDER BY r.created_at, r.key
    LIMIT ${CAP}`;

  // Renewals within the month: Dates and Subscriptions entries, and open projects' renews-on day.
  const renewals = yield* sql<{ key: string; title: string; on: string }>`SELECT r.key, r.title,
      json_extract(r.fields_json, '$.renewsOn') AS "on"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'projects' AND r.state = 'open'
      AND json_extract(r.fields_json, '$.renewsOn') BETWEEN ${dayIn(now, zone)}
        AND ${dayIn(now + RENEWALS_AHEAD_MS, zone)}
    ORDER BY "on", r.key LIMIT ${CAP}`;
  const listedRenewals = yield* sql<{ key: string; title: string; dueAt: number }>`SELECT r.key,
      r.title, r.due_at AS "dueAt"
    FROM kin_records r
    WHERE r.org_id = ${orgId}
      AND ((r.register_id = 'dates' AND r.category = 'renewal') OR r.register_id = 'subscriptions')
      AND r.state IN ${sql.in(OPEN)} AND r.due_at >= ${now} AND r.due_at < ${now + RENEWALS_AHEAD_MS}
    ORDER BY r.due_at, r.key LIMIT ${CAP}`;

  // Meetings: last week's, and whether their outcome was noted; and the week ahead's.
  const meetings = yield* sql<{ key: string; title: string; at: number; state: string }>`SELECT
      r.key, r.title, r.date_at AS at, r.state
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.category = 'meeting'
      AND r.state <> 'dropped' AND r.date_at >= ${weekAgo} AND r.date_at < ${now + WEEK_MS}
    ORDER BY r.date_at, r.key LIMIT ${CAP}`;

  const load = yield* sql<{
    kind: string;
    id: string;
    name: string | null;
    open: number;
    late: number;
    soon: number;
  }>`SELECT r.owner_kind AS kind, r.owner_id AS id,
      COALESCE(pe.display_name, a.display_name) AS name, COUNT(*) AS open,
      SUM(r.due_at < ${now}) AS late,
      SUM(r.due_at >= ${now} AND r.due_at < ${now + FREE_HORIZON_MS}) AS soon
    FROM kin_records r
    LEFT JOIN kin_people pe ON r.owner_kind = 'person' AND pe.org_id = r.org_id
      AND pe.person_id = r.owner_id
    LEFT JOIN kin_agents a ON r.owner_kind = 'agent' AND a.org_id = r.org_id
      AND a.agent_id = r.owner_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
    GROUP BY r.owner_kind, r.owner_id
    ORDER BY open DESC, r.owner_id`;
  const people = yield* sql<{ id: string; name: string }>`SELECT person_id AS id,
      display_name AS name FROM kin_people WHERE org_id = ${orgId} ORDER BY display_name`;
  const overloadAt = (yield* playbookThreshold(orgId, "overloaded_load")).value;
  const overloaded = load
    .filter((one) => one.open >= overloadAt || one.late >= LATE_OVERLOAD)
    .map((one) => `${one.name ?? "someone"}: ${one.open} open, ${one.late} late`);
  const busy = new Set(
    load.filter((one) => one.kind === "person" && one.soon > 0).map((one) => one.id),
  );
  const free = people.filter((person) => !busy.has(person.id)).map((person) => person.name);

  const next = yield* sql<{ key: string; title: string; dueAt: number; list: string }>`SELECT
      r.key, r.title, r.due_at AS "dueAt", r.register_id AS list
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id IN ('work', 'milestones', 'invoices', 'projects')
      AND r.state IN ${sql.in(OPEN)} AND r.due_at >= ${now} AND r.due_at < ${now + WEEK_MS}
      AND (r.register_id <> 'invoices' OR ${keptEntry(sql)})
    ORDER BY r.due_at, r.key
    LIMIT ${CAP}`;

  // Cold and quiet clients as the pulse has them, held ones included: the week is the owner's.
  const clientFacts = (yield* KinPulse.read({
    orgId,
    at: now,
    viewer: { _tag: "owner" },
    scope: { family: "work" },
    includeHandled: true,
    limit: CAP,
  })).facts.filter((fact) => fact.sense === "client_cold" || fact.sense === "client_quiet");

  const unpaidLine = (one: (typeof owed)[number]) =>
    `${recordName(one.key, one.number)}${one.partyTitle === null ? "" : ` ${one.partyTitle}`}: ${formatMoney(one.balance)} ${
      one.dueAt === null
        ? "unpaid, no due date"
        : isOverdue(one)
          ? `unpaid, overdue ${overdueFor(one.dueAt, one.daysOverdue, now, zone)}; ${overdueMail.get(one.recordId)}`
          : `due ${dayIn(one.dueAt, zone)}`
    }`;
  const section = {
    week: `${dayIn(weekAgo, zone)} to ${dayIn(now, zone)}`,
    goals: goals.map(goalLine),
    projects: Object.fromEntries(Object.entries(byStatus).filter(([, rows]) => rows.length > 0)),
    money: {
      inThisWeek: totals(received),
      outThisWeek: totals(spent),
      unpaidTotal: totals(owed.map((one) => one.balance)),
      unpaid: owed.map(unpaidLine),
      openQuotes: quotes.map(
        (one) =>
          `${recordName(one.key, one.number)}${one.client === null ? "" : ` ${one.client}`}${one.minor === null || one.currency === null ? "" : `: ${formatMoney({ minor: one.minor, currency: one.currency })}`}, ${one.state === "open" ? "draft, not sent" : "sent, no answer yet"}`,
      ),
      renewalsThisMonth: [
        ...renewals.map((one) => `${one.on} ${one.key} ${one.title} renews`),
        ...listedRenewals.map((one) => `${dayIn(one.dueAt, zone)} ${one.key} ${one.title}`),
      ],
    },
    meetings: {
      lastWeek: meetings
        .filter((one) => one.at < now)
        .map(
          (one) =>
            `${when(one.at)} ${one.key} ${one.title}: ${one.state === "done" ? "outcome noted" : `happened, ${NO_OUTCOME}`}`,
        ),
      comingUp: meetings
        .filter((one) => one.at >= now)
        .map((one) => `${when(one.at)} ${one.key} ${one.title}`),
    },
    clients: {
      cold: clientFacts
        .filter((fact) => fact.sense === "client_cold")
        .map((fact) => `${fact.subject.title}: ${fact.consequence}`),
      quiet: clientFacts
        .filter((fact) => fact.sense === "client_quiet")
        .map((fact) => `${fact.subject.title}: ${fact.consequence}`),
    },
    people: { overloaded, free },
    nextWeek: next.map(
      (one) =>
        `${dayIn(one.dueAt, zone)} ${one.key} ${one.title}${one.list === "milestones" ? " (milestone)" : one.list === "invoices" ? INVOICE_DUE : one.list === "projects" ? " (project target)" : ""}`,
    ),
  };
  return {
    section,
    overdue: owed.filter(isOverdue).map(unpaidLine),
    notYetDue: owed.filter((one) => !isOverdue(one)).map(unpaidLine),
  };
});

/** The week for the agent to judge: only what the figures section (`weeklyFigures`) doesn't show. */
export const buildWeeklySection = Effect.fn("KinLeadPrompt.weekly")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
}) {
  const { section: week } = yield* weekRows(input);
  return {
    week: week.week,
    projects: Object.fromEntries(
      Object.entries(week.projects).filter(([status]) => status !== "behind"),
    ),
    meetingsLastWeek: week.meetings.lastWeek.filter((line) => !line.endsWith(NO_OUTCOME)),
    people: week.people,
    nextWeek: week.nextWeek.filter((line) => !line.endsWith(INVOICE_DUE)),
  };
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "a, b and c", or "a, and b" for two parts led by a clause of their own. */
const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/**
 * The pipeline's three lines on Monday's page (Settings → Check-ins, the weekly brief's switch),
 * at the owner level, over [from, now): each amount in its own currency; beside a foreign one,
 * only when the line has a second currency, its estimate at the owner's rate and that rate's day.
 */
export const pipelineLines = Effect.fn("KinWeekly.pipeline")(function* (
  orgId: KinOrgId,
  from: number,
  now: number,
) {
  const counts = yield* mondayCounts(orgId, from, now);
  const home = yield* homeCurrency(orgId);
  const { rates } = yield* readProfile(orgId);
  const valued = (rows: typeof counts.open) =>
    rows
      .flatMap((row) =>
        row.currency === null || row.minor === null
          ? []
          : [{ money: { minor: row.minor, currency: row.currency }, count: row.count }],
      )
      .toSorted((a, b) =>
        a.money.currency === b.money.currency
          ? 0
          : a.money.currency === home
            ? -1
            : b.money.currency === home
              ? 1
              : a.money.currency.localeCompare(b.money.currency),
      );
  /** " (about €20,300 at your rate of 17 Nov)" beside a foreign amount that has a rate. */
  const about = (money: KinMoney, several: boolean) => {
    const rate = rates.find((one) => one.currency === money.currency);
    const estimate =
      !several || money.currency === home || rate === undefined
        ? undefined
        : aboutTotal([{ minor: 0, currency: home }, money], home, rates);
    return estimate === undefined || estimate.missing.length > 0
      ? ""
      : ` (about ${formatMoneyPlain(estimate.total)} at your rate of ${formatKinWhen(
          Date.parse(`${rate!.asOf}T12:00:00Z`),
          "date",
          { zone: "UTC", locale: KIN_TEXT_LOCALE },
        )})`;
  };
  const total = (rows: typeof counts.open) => rows.reduce((sum, row) => sum + row.count, 0);

  const open = valued(counts.open);
  const unvalued = total(counts.open) - open.reduce((sum, one) => sum + one.count, 0);
  const several = open.length > 1;
  const openParts = open.map((one, index) =>
    index === 0
      ? `${formatMoneyPlain(one.money)} open in ${plural(one.count, "deal", "deals")}${about(one.money, several)}`
      : `${formatMoneyPlain(one.money)} in ${one.count}${about(one.money, several)}`,
  );
  const pipeline =
    total(counts.open) === 0
      ? "no open deals"
      : open.length === 0
        ? `${plural(unvalued, "open deal", "open deals")}, none with a value yet`
        : `${openParts.length < 2 ? openParts.join("") : `${openParts.slice(0, -1).join(", ")}, and ${openParts.at(-1)}`}${
            unvalued === 0 ? "" : `; ${unvalued} more with no value yet`
          }`;
  const closed = (verb: string, rows: typeof counts.open) => {
    const values = valued(rows);
    return `${verb} ${total(rows)}${
      values.length === 0
        ? ""
        : ` for ${listed(values.map((one) => `${formatMoneyPlain(one.money)}${about(one.money, values.length > 1)}`))}`
    }`;
  };
  const lateCount = counts.late.reduce((sum, one) => sum + one.count, 0);
  return [
    `Pipeline: ${pipeline}.`,
    `Last week: ${closed("won", counts.won)}, ${closed("lost", counts.lost)}; ${plural(counts.added, "new deal", "new deals")}.`,
    `Follow-ups late: ${
      lateCount === 0
        ? "none"
        : `${lateCount} (${counts.late.map((one) => `${one.name} ${one.count}`).join(", ")})`
    }.`,
  ];
});

export const WEEK_FIGURES_TITLE = "The week, from Kin's records";

/**
 * The week's figures as Kin writes them into the weekly brief's page, one titled section the
 * agent's words sit around: every figure from the rows, none chosen or retyped by a model.
 */
export const weeklyFigures = Effect.fn("KinWeekly.figures")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
}) {
  const { section: week, overdue, notYetDue } = yield* weekRows(input);
  const block = (title: string, lines: ReadonlyArray<string>, empty?: string) =>
    lines.length === 0
      ? empty === undefined
        ? []
        : [`${title}: ${empty}`]
      : [`${title}:`, ...lines.map((line) => `- ${line}`)];
  const money = [
    week.money.inThisWeek.length === 0 ? null : `In this week: ${week.money.inThisWeek.join(", ")}`,
    week.money.outThisWeek.length === 0
      ? null
      : `Out this week: ${week.money.outThisWeek.join(", ")}`,
    week.money.unpaidTotal.length === 0
      ? null
      : `Still to come in: ${week.money.unpaidTotal.join(", ")}`,
  ].filter((line) => line !== null);
  const blocks = [
    block("Goals", week.goals, "none set"),
    block("Money", money),
    block("Overdue", overdue, "nothing"),
    block("Invoices not yet due", notYetDue),
    block("Open quotes", week.money.openQuotes, "none"),
    block("Renewals this month", week.money.renewalsThisMonth, "none"),
    (yield* weeklyPipelineOf(input.orgId))
      ? yield* pipelineLines(input.orgId, input.now - WEEK_MS, input.now)
      : [],
    block("Cold clients", week.clients.cold),
    block("Quiet clients", week.clients.quiet),
    block("Behind", week.projects.behind ?? []),
    block(
      "Meetings with no outcome noted",
      week.meetings.lastWeek.filter((line) => line.endsWith(NO_OUTCOME)),
    ),
    block("Coming up", week.meetings.comingUp),
  ].filter((lines) => lines.length > 0);
  return [`## ${WEEK_FIGURES_TITLE}`, week.week, ...blocks.map((lines) => lines.join("\n"))].join(
    "\n\n",
  );
});
