import {
  KinAgentId,
  type KinOrgId,
  KinPersonId,
  type KinPulseActor,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sentMail, type SentMail } from "../connections/Sending.ts";
import { dayIn, timeIn } from "../work/money.ts";
import { ownerZone, recordName } from "../work/recordRows.ts";
import { leadNamer } from "../work/toolNames.ts";
import { clientHistory } from "./clientHistory.ts";
import { headStarts } from "./headStart.ts";
import { covers, endedHolds } from "./holds.ts";
import * as KinPulse from "./KinPulse.ts";
import { teamHoursNow } from "./nudge.ts";

export const PULSE_RULE =
  "What needs attention, as Kin computed it from its own records just now. Nobody asked for these facts, so each one you raise arrives one tap from done: do what you may do alone and say it in a line; draft what leaves the company (mail to its writeTo, its document attached, from an account in mailFrom) so its card waits on him; or put one kin_ask with the real options and a default. When the head start can't be made, say once what is missing, such as no contact with an email; never ask whether to start. Leave a fact that needs nothing or is already in hand. Call pulse_handle once one is in hand or is not a problem. teamHours says, per person, whether they are inside their own working hours now: go by it, never by the team's or your own reckoning.";
export const CHECK_IN_PULSE_RULE =
  "Check-in: below are only facts the owner hasn't been told as they stand now (new, changed or due today). Tell him each in your reply, once, leading with what you did or what waits on his tap. When a fact's setAsideEnded says it had been set aside, first say so in a few words, with whose word it was, then what is open about it. What he was told and hasn't changed is left out: don't recall it.";
/** The morning check-in, which took over the morning brief's sections; the app greets above it. */
export const MORNING_RULE =
  "This is the morning check-in. Besides the pulse: what is due today, overdue promises, what waits on the owner, reviews and red checks, objectives this week and stuck tasks. The owner reads it as a page under a greeting the app writes, so write no greeting and put everything under headings, each on its own line: `## Needs you`, `## Money`, `## Clients`, `## Work`, `## Coming up`. Use only the ones you have something for, Needs you first, a few short lines under each, and tell every pulse fact under the heading it belongs to, as the pulse rule says. It is sent on a quiet morning too: when nothing here needs them, say so in a line under `## Needs you`, then `## Coming up` only if something is.";
/** The evening check-in, which took over the evening summary's sections. */
export const EVENING_RULE =
  "This is the evening summary: the day as these facts have it, what got done, what moved or slipped, and what is still open and carries to tomorrow. Like the morning page it reads under a greeting the app writes, so write no greeting and put it under headings, each on its own line, a few short lines under each. `today` is Kin's own record of what happened in the company today, whatever an earlier message already told him: sum it up, and never call a day quiet or say nothing was done while it has lines. Anything else he was told today, tell again only where it changed.";
const SECTION_CAP = 30;
const MAILED_SENSES = new Set<KinPulseFact["sense"]>(["invoice_overdue", "quote_unanswered"]);
const CHECK_IN_CAP = 200;

/**
 * The owner's open pulse facts for a prompt, grouped by project, the ones that woke this turn first.
 * `undefined` when nothing needs attention and nothing woke it.
 */
export const buildPulseSection = Effect.fn("KinLeadPrompt.pulse")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly now: number;
  readonly wokeFor: ReadonlyArray<string>;
  /** A check-in: the facts it was given to tell (`kin_pulse_told`). */
  readonly checkIn?: ReadonlySet<string> | undefined;
  /** The check-in events, so a fact first told since its hold ended says it was set aside. */
  readonly checkInEvents?: ReadonlyArray<string> | undefined;
}) {
  const tell = input.checkIn;
  const checkIn = tell !== undefined;
  const read = yield* KinPulse.read({
    orgId: input.orgId,
    at: input.now,
    viewer: { _tag: "owner" },
    limit: 200,
  });
  const all =
    tell === undefined ? read : { ...read, facts: read.facts.filter((fact) => tell.has(fact.key)) };
  const woke = new Set(input.wokeFor);
  const open = new Set(all.facts.map((fact) => fact.key));
  const gone = input.wokeFor.filter((key) => !open.has(key));
  if ((checkIn ? all.facts.length : all.total) === 0 && gone.length === 0) return undefined;
  const shown = all.facts
    .toSorted((a, b) => Number(woke.has(b.key)) - Number(woke.has(a.key)))
    .slice(0, checkIn ? CHECK_IN_CAP : SECTION_CAP);
  // An overdue invoice or unanswered quote comes with the mail it went in, to reply in that thread.
  const mailed = new Map<string, SentMail>();
  for (const fact of shown)
    if (MAILED_SENSES.has(fact.sense) && fact.subject.recordId !== undefined) {
      const [sent] = yield* sentMail({
        orgId: input.orgId,
        recordIds: [fact.subject.recordId],
        limit: 1,
      });
      if (sent !== undefined) mailed.set(fact.key, sent);
    }
  const name = yield* leadNamer(input.orgId, input.agentId);
  // "owner" is the role, not a person: whoever holds owner-level access acts.
  const who = (actor: KinPulseActor | NonNullable<KinPulseFact["handled"]>["by"]) =>
    actor._tag === "owner" ? "the owner" : name(actor);
  // A client gone quiet or cold comes with what we did for them, so a suggestion has substance.
  const histories = new Map<string, Effect.Success<ReturnType<typeof clientHistory>>>();
  for (const fact of shown)
    if (
      (fact.sense === "client_cold" || fact.sense === "client_quiet") &&
      fact.subject.recordId !== undefined &&
      !histories.has(fact.subject.recordId)
    )
      histories.set(
        fact.subject.recordId,
        yield* clientHistory(input.orgId, fact.subject.recordId, input.now),
      );
  const starts = yield* headStarts(input.orgId, shown);
  const zone = yield* ownerZone(input.orgId);
  const ended = checkIn
    ? yield* asideEnded(input.orgId, input.agentId, input.now, shown, input.checkInEvents ?? [])
    : new Map<string, string>();
  const row = (fact: KinPulseFact) => ({
    key: fact.key,
    about:
      fact.subject.key === fact.subject.title
        ? fact.subject.title
        : `${recordName(fact.subject.key, fact.subject.number)} ${fact.subject.title}`,
    consequence: fact.consequence,
    acts: who(fact.actor),
    ...(fact.measure?.from._tag === "playbook"
      ? { playbook: `${fact.measure.from.title} (${fact.measure.from.key})` }
      : {}),
    ...(fact.measure === undefined
      ? {}
      : { rule: `${fact.measure.threshold} ${fact.measure.unit} (now ${fact.measure.value})` }),
    ...(mailed.has(fact.key)
      ? {
          sentIn: (({ at, connection, account, from, to, subject, threadId }) => ({
            at: timeIn(Date.parse(at), zone),
            connection,
            account,
            from,
            to,
            subject,
            threadId,
          }))(mailed.get(fact.key)!),
        }
      : MAILED_SENSES.has(fact.sense)
        ? { sentIn: "no mail with it on record" }
        : {}),
    ...starts.byFact.get(fact.key),
    ...(ended.has(fact.key) ? { setAsideEnded: ended.get(fact.key) } : {}),
    ...(fact.sensitive ? { sensitive: true } : {}),
    ...(woke.has(fact.key) ? { wokeYou: true } : {}),
    ...(fact.subject.recordId !== undefined && histories.has(fact.subject.recordId)
      ? { history: histories.get(fact.subject.recordId) }
      : {}),
  });
  const groups = new Map<string, Array<ReturnType<typeof row>>>();
  for (const fact of shown) {
    const project =
      fact.scope.projectKey === undefined
        ? "No project"
        : `${fact.scope.projectTitle ?? ""} (${fact.scope.projectKey})`.trim();
    groups.set(project, [...(groups.get(project) ?? []), row(fact)]);
  }
  const team = yield* teamHoursNow(input.orgId, input.now);
  return {
    asOf: timeIn(DateTime.toEpochMillis(all.asOf), zone),
    total: checkIn ? all.facts.length : all.total,
    ...(team.length === 0 ? {} : { teamHours: team }),
    ...(starts.mail === undefined ? {} : { mailFrom: starts.mail }),
    ...(!checkIn && all.total > shown.length
      ? { shown: shown.length, more: "pulse_read has the rest" }
      : {}),
    byProject: [...groups].map(([project, facts]) => ({ project, facts })),
    ...(gone.length === 0 ? {} : { wokeForButHandledOrNoLongerTrue: gone }),
  };
});

/** How far back a hold's end still explains a fact told now. */
const ENDED_WITHIN_MS = 60 * 24 * 60 * 60_000;

/**
 * For facts a check-in tells for the first time since a hold on them ended: "set aside by Finance
 * on Rhea's word on 2026-11-20 until 2026-12-17; that day came" (or "lifted by Rhea on …").
 */
const asideEnded = Effect.fn("KinLeadPrompt.asideEnded")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  now: number,
  facts: ReadonlyArray<KinPulseFact>,
  events: ReadonlyArray<string>,
) {
  const lines = new Map<string, string>();
  if (facts.length === 0) return lines;
  const holds = yield* endedHolds(orgId, now - ENDED_WITHIN_MS, now);
  if (holds.length === 0) return lines;
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  const named = yield* leadNamer(orgId, agentId);
  const zone = yield* ownerZone(orgId);
  const name = (kind: "person" | "agent", id: string) =>
    named(
      kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id) }
        : { _tag: "person", personId: KinPersonId.make(id) },
    );
  for (const fact of facts) {
    const hold = holds.find((one) => covers(one, fact));
    if (hold === undefined || hold.endedAt === null || agent === undefined) continue;
    const since = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_pulse_told
      WHERE org_id = ${orgId} AND person_id = ${agent.owner} AND fact_key = ${fact.key}
        AND told_at >= ${hold.endedAt}
        ${events.length === 0 ? sql`` : sql`AND event_id NOT IN ${sql.in(events)}`}
      LIMIT 1`;
    if (since.length > 0) continue;
    const word = hold.onWordOf === null ? "" : ` on ${name("person", hold.onWordOf)}'s word`;
    const end =
      hold.liftedById === null || hold.liftedByKind === null
        ? "that day came"
        : `lifted by ${name(hold.liftedByKind, hold.liftedById)} on ${dayIn(hold.endedAt, zone)}`;
    lines.set(
      fact.key,
      `set aside by ${name(hold.byKind, hold.byId)}${word} on ${dayIn(hold.setAt, zone)}${hold.until === null ? "" : ` until ${dayIn(hold.until, zone)}`}; ${end}`,
    );
  }
  return lines;
});

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** This agent's check-ins, one line each, so the owner can move or drop one in plain words. */
export const checkInIndex = Effect.fn("KinLeadPrompt.checkIns")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    scheduleId: string;
    title: string;
    looseAt: string | null;
    timeOfDay: string | null;
    weekdays: string | null;
    enabled: number;
  }>`SELECT s.schedule_id AS "scheduleId", t.title, s.loose_at AS "looseAt",
      json_extract(t.schedule_json, '$.timeOfDay') AS "timeOfDay",
      json_extract(t.schedule_json, '$.weekdays') AS weekdays, t.enabled
    FROM kin_schedules s JOIN scheduled_tasks t ON t.task_id = s.task_id
    WHERE s.org_id = ${orgId} AND s.agent_id = ${agentId} AND s.check_in = 1
      AND s.deleted_at IS NULL
    ORDER BY json_extract(t.schedule_json, '$.timeOfDay'), s.schedule_id`;
  return rows.map((row) => {
    const days: unknown = row.weekdays === null ? null : JSON.parse(row.weekdays);
    const named =
      Array.isArray(days) && days.length > 0 && days.length < 7
        ? ` ${days.map((day) => DAY_NAMES[Number(day)] ?? "?").join(", ")}`
        : " every day";
    const time = row.looseAt === null ? `at ${row.timeOfDay ?? "?"}` : `around ${row.looseAt}`;
    return `${row.scheduleId} ${row.title}: ${time}${named}${row.enabled === 1 ? "" : " (paused)"}`;
  });
});
