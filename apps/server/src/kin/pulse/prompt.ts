import type { KinAgentId, KinOrgId, KinPulseActor, KinPulseFact } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sentMail, type SentMail } from "../connections/Sending.ts";
import { clientHistory } from "./clientHistory.ts";
import * as KinPulse from "./KinPulse.ts";
import { teamHoursNow } from "./nudge.ts";

export const PULSE_RULE =
  "What needs attention, as Kin computed it from its own records just now. Act on a fact when that moves something forward; otherwise leave it. Call pulse_handle once one is in hand or is not a problem. teamHours says, per person, whether they are inside their own working hours now: go by it, never by the team's or your own reckoning.";
export const CHECK_IN_PULSE_RULE =
  "Check-in: below are only facts the owner hasn't been told as they stand now (new, changed or due today). Tell him each in your reply, once, leading with what you did or will do; one in hand (inHand) with who and until when. What he was told and hasn't changed is left out: don't recall it.";
const SECTION_CAP = 30;
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
  /** A check-in: the facts it was given to tell (`kin_pulse_told`), held ones too. */
  readonly checkIn?: ReadonlySet<string> | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const tell = input.checkIn;
  const checkIn = tell !== undefined;
  const read = yield* KinPulse.read({
    orgId: input.orgId,
    at: input.now,
    viewer: { _tag: "owner" },
    limit: 200,
    includeHandled: checkIn,
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
  // An overdue invoice comes with the mail it went in, so a reminder replies in that thread.
  const mailed = new Map<string, SentMail>();
  for (const fact of shown)
    if (fact.sense === "invoice_overdue" && fact.subject.recordId !== undefined) {
      const [sent] = yield* sentMail({
        orgId: input.orgId,
        recordIds: [fact.subject.recordId],
        limit: 1,
      });
      if (sent !== undefined) mailed.set(fact.key, sent);
    }
  const names = new Map(
    (yield* sql<{ id: string; name: string }>`SELECT agent_id AS id, display_name AS name
      FROM kin_agents WHERE org_id = ${input.orgId}
      UNION ALL SELECT person_id AS id, display_name AS name
      FROM kin_people WHERE org_id = ${input.orgId}
      ORDER BY id`).map((row) => [row.id, row.name]),
  );
  const who = (actor: KinPulseActor | NonNullable<KinPulseFact["handled"]>["by"]) =>
    actor._tag === "owner"
      ? "the owner"
      : actor._tag === "agent"
        ? actor.agentId === input.agentId
          ? "you"
          : (names.get(actor.agentId) ?? "another agent")
        : (names.get(actor.personId) ?? "a teammate");
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
  const row = (fact: KinPulseFact) => ({
    key: fact.key,
    about: `${fact.subject.key === fact.subject.title ? fact.subject.title : `${fact.subject.key} ${fact.subject.title}`}`,
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
            at,
            connection,
            account,
            from,
            to,
            subject,
            threadId,
          }))(mailed.get(fact.key)!),
        }
      : fact.sense === "invoice_overdue"
        ? { sentIn: "no mail with it on record" }
        : {}),
    ...(fact.handled === null
      ? {}
      : {
          inHand: `${who(fact.handled.by)}${fact.handled.until === null ? ", not a problem" : ` until ${DateTime.formatIso(fact.handled.until)}`}${fact.handled.note === null ? "" : `: ${fact.handled.note}`}`,
        }),
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
    asOf: all.asOf,
    total: checkIn ? all.facts.length : all.total,
    ...(team.length === 0 ? {} : { teamHours: team }),
    ...(!checkIn && all.total > shown.length
      ? { shown: shown.length, more: "pulse_read has the rest" }
      : {}),
    byProject: [...groups].map(([project, facts]) => ({ project, facts })),
    ...(gone.length === 0 ? {} : { wokeForButHandledOrNoLongerTrue: gone }),
  };
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
