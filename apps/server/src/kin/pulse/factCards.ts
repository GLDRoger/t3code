import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KinChatId,
  type KinChoiceOutcome,
  KinPersonId,
  KinWidgetId,
  KinAgentId,
  type KinOrgId,
  type KinPulseFact,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { KinChatService } from "../chat/KinChatService.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevelPeople } from "../people/KinAccess.ts";
import { holdFor } from "../triggers/quietHold.ts";
import { storedWorkHours } from "../triggers/quietHours.ts";
import {
  FACT_CARD_KIND_LIST,
  type FactCardPlan,
  isFactCard,
  plansOf,
  type DuePlan,
  sealPlans,
  type StallPlan,
  type WaitedPlan,
} from "../widgets/cardPlans.ts";
import { dayIn } from "../work/money.ts";
import { daysOverdue, startOfDay } from "../work/recordRows.ts";
import { teamGuard, viewSees } from "../work/teamView.ts";
import { daysText, type SenseContext } from "./senses/shared.ts";
import { markTold } from "./told.ts";
import { DAY_MS, thresholds, toMs } from "./thresholds.ts";

/*
 * Kin's own card about a pulse fact, posted to the one person who can answer it, in their direct
 * chat with an agent: every word is Kin's, each tap runs a sealed plan (`factCardTaps.ts`), and the
 * card closes by itself once its fact stops being true.
 */

/** An unanswered nudge holds off the next for this long, as an agent's nudge does (`nudge.ts`). */
const NUDGE_BACK_OFF_MS = 7 * DAY_MS;
const QUESTION_MAX = 240;
const clamp = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
/** "Thu 26 Nov" in `zone`. */
const dayWord = (ms: number, zone: string) =>
  formatKinWhen(ms, "day", { zone, locale: KIN_TEXT_LOCALE }).replace(/,/g, "");

/** The card's button and the line under it, for each sealed answer. */
export const factCardShown = (plan: FactCardPlan) => {
  switch (plan.kind) {
    case "move_due":
      return {
        label: `Move to ${plan.toDay}`,
        line: `${plan.key}'s due day becomes ${plan.toDay}; its tasks don't change`,
      };
    case "keep_due":
      return {
        label: "Leave it",
        line: `${plan.key} stays due ${plan.fromDay}; Kin doesn't ask again for this day`,
      };
    case "stall_answer":
      return plan.answer === "still"
        ? { label: "Still on it", line: `Kin asks again on ${plan.day} if it hasn't moved` }
        : { label: "Done", line: `Mark ${plan.key} done` };
    case "waited_answer":
      return waitedShown(plan);
  }
};

const waitedShown = (plan: WaitedPlan) => {
  switch (plan.answer) {
    case "done":
      return {
        label: "Done",
        line: `${plan.holder.name} is told it's done and gets ${plan.key} back`,
      };
    case "by":
      return {
        label: `By ${plan.day}`,
        line: `${plan.holder.name} is told; it comes back after ${plan.day} if it still waits on you`,
      };
    case "not_mine":
      return {
        label: "Not mine",
        line: `${plan.holder.name} is told it doesn't wait on you, to change who it does`,
      };
  }
};

/** What an unanswered card says once its fact stopped being true. */
const closedOutcome = (plan: FactCardPlan): KinChoiceOutcome => ({
  title: "No longer needed",
  text:
    plan.kind === "stall_answer"
      ? `${plan.key} moved on.`
      : plan.kind === "waited_answer"
        ? `${plan.key} no longer waits on you.`
        : `${plan.key} no longer needs a new date.`,
});

type CardOption = { readonly label: string; readonly plan?: FactCardPlan };

/** Every fact card's sealed plans in the org, with whether its card is still open. */
const factCardRows = Effect.fn("KinFactCards.rows")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    widgetId: string;
    factKey: string;
    round: number;
    personId: string;
    kind: string;
    answer: string;
    ran: string | null;
    open: number;
  }>`SELECT p.widget_id AS "widgetId", json_extract(p.plan_json, '$.factKey') AS "factKey",
      json_extract(p.plan_json, '$.round') AS round,
      json_extract(p.plan_json, '$.personId') AS "personId",
      json_extract(p.plan_json, '$.kind') AS kind,
      json_extract(p.plan_json, '$.answer') AS answer, p.ran_message_id AS ran,
      w.closed_at IS NULL AS open
    FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
    WHERE p.org_id = ${orgId}
      AND json_extract(p.plan_json, '$.kind') IN ${sql.in(FACT_CARD_KIND_LIST)}
    ORDER BY p.widget_id, p.option_id`;
});
type CardRow = Effect.Success<ReturnType<typeof factCardRows>>[number];

/**
 * A teammate's card counts as their nudge for the day (`kin_pulse_nudges`), so an agent's text
 * nudge and Kin's card never both arrive: none when they were nudged today, or their last nudge
 * in the past week went unanswered. Claims the day in the caller's transaction; false when taken.
 */
const claimNudge = Effect.fn("KinFactCards.claimNudge")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly factKey: string;
  readonly at: number;
  readonly day: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, personId, at } = input;
  const [last] = yield* sql<{ day: string; chatId: string; sentAt: number }>`SELECT day,
      chat_id AS "chatId", sent_at AS "sentAt"
    FROM kin_pulse_nudges WHERE org_id = ${orgId} AND person_id = ${personId}
    ORDER BY sent_at DESC LIMIT 1`;
  if (last?.day === input.day) return false;
  if (last !== undefined && at - last.sentAt < NUDGE_BACK_OFF_MS) {
    const [answered] = yield* sql`SELECT 1 FROM kin_messages
      WHERE org_id = ${orgId} AND chat_id = ${last.chatId} AND author_person_id = ${personId}
        AND origin_json IS NULL
        AND created_at > ${DateTime.formatIso(DateTime.makeUnsafe(last.sentAt))} LIMIT 1`;
    if (answered === undefined) return false;
  }
  const claimed = yield* sql`INSERT INTO kin_pulse_nudges (org_id, person_id, day, agent_id,
      chat_id, fact_key, sent_at)
    VALUES (${orgId}, ${personId}, ${input.day}, ${input.agentId}, ${input.chatId},
      ${input.factKey}, ${at})
    ON CONFLICT (org_id, person_id, day) DO NOTHING RETURNING day`;
  return claimed.length > 0;
});

/**
 * Posts one card about a fact to `personId`, in their direct chat with `agentId` (else the team
 * agent, as holder notices go), opened if needed, its plans sealed in the same transaction. Posts
 * nothing while they are in quiet hours, away or outside their hours (the next pass posts it),
 * nor once a card for this fact and round was posted to them. Returns the card, or undefined.
 */
const postFactCard = Effect.fn("KinFactCards.post")(function* (input: {
  readonly ctx: SenseContext;
  readonly personId: KinPersonId;
  readonly agentId: KinAgentId;
  readonly factKey: string;
  readonly round: number;
  readonly question: string;
  readonly detail?: string;
  readonly options: ReadonlyArray<CardOption>;
  /** A teammate's card spends their one nudge of the day (`claimNudge`). */
  readonly nudge: boolean;
  readonly posted: ReadonlyArray<CardRow>;
}) {
  const { ctx, personId } = input;
  const { orgId, at } = ctx;
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats)) return undefined;
  if (
    input.posted.some(
      (row) =>
        row.factKey === input.factKey && row.round === input.round && row.personId === personId,
    )
  )
    return undefined;
  if ((yield* holdFor({ orgId, personId, chatId: undefined })) !== undefined) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const via = yield* Reach.carrierFor(orgId, personId, input.agentId);
  if (via === null) return undefined;
  const [lead] = yield* sql<{ threadId: string; ownerPersonId: string }>`SELECT
      l.thread_id AS "threadId", a.owner_person_id AS "ownerPersonId"
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} AND l.agent_id = ${via} AND l.thread_id IS NOT NULL`;
  if (lead === undefined) return undefined;
  const [person] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
  if (person === undefined) return undefined;
  const chat = chats.value;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const [open] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
          JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
            AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
          WHERE c.org_id = ${orgId} AND c.kind = 'direct'
            AND c.direct_key = ${LeadAccess.directKey(personId, via)}
          ORDER BY c.chat_id LIMIT 1`;
        const chatId =
          open !== undefined
            ? KinChatId.make(open.chatId)
            : (yield* chat.createDirect(
                { _tag: "person", orgId, personId },
                { orgId, agentId: via },
              )).chatId;
        if (
          input.nudge &&
          !(yield* claimNudge({
            orgId,
            personId,
            agentId: via,
            chatId,
            factKey: input.factKey,
            at,
            day: dayIn(at, person.zone ?? ctx.zone),
          }))
        )
          return undefined;
        const shown = input.options.map((one) =>
          one.plan === undefined ? undefined : factCardShown(one.plan),
        );
        const card = yield* chat.ask(
          {
            _tag: "agent",
            hostPosted: true,
            orgId,
            agentId: via,
            ownerPersonId: KinPersonId.make(lead.ownerPersonId),
            threadId: ThreadId.make(lead.threadId),
          },
          {
            chatId,
            clientMessageId: `kin-fact-card:${input.factKey}:${input.round}:${personId}`,
            question: clamp(input.question, QUESTION_MAX),
            ...(input.detail === undefined ? {} : { detail: input.detail }),
            options: input.options.map((one) => ({ label: one.label })),
            actions: shown,
            untilAnswered: true,
            forChat: true,
            silent: true,
          },
        );
        yield* sealPlans({
          orgId,
          chatId,
          widgetId: card.widgetId,
          plans: input.options.flatMap((one, index) =>
            one.plan === undefined ? [] : [{ optionId: `option-${index + 1}`, plan: one.plan }],
          ),
          now: at,
        });
        return card;
      }),
    )
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't post its card about a fact", { orgId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
});

/**
 * Every open fact card whose fact stopped being true closes, saying so: its way out when the
 * thing it asked about moved on without a tap.
 */
const settleFactCards = Effect.fn("KinFactCards.settle")(function* (
  orgId: KinOrgId,
  posted: ReadonlyArray<CardRow>,
  standing: ReadonlySet<string>,
) {
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats)) return;
  const gone = [
    ...new Set(
      posted
        .filter((row) => row.open === 1 && !standing.has(row.factKey))
        .map((row) => row.widgetId),
    ),
  ];
  for (const widgetId of gone) {
    const plan = [...(yield* plansOf(orgId, widgetId)).values()].find(isFactCard);
    if (plan === undefined) continue;
    yield* chats.value
      .closeReplaced({ orgId, widgetId: KinWidgetId.make(widgetId), outcome: closedOutcome(plan) })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't close a card whose fact cleared", { orgId, cause }),
        ),
      );
  }
});

/** The first of their working days after today, and the day a week on, as "By" answers offer. */
const answerDays = (at: number, zone: string, workHours: string | null) => {
  const days = storedWorkHours(workHours)?.days ?? [1, 2, 3, 4, 5];
  const today = Date.parse(dayIn(at, zone));
  const dayAfter = (n: number) => DateTime.makeUnsafe(today + n * DAY_MS);
  const next =
    [1, 2, 3, 4, 5, 6, 7]
      .map(dayAfter)
      .find((day) => days.includes(DateTime.getPartUtc(day, "weekDay"))) ?? dayAfter(1);
  return [next, dayAfter(7)].map((day) => {
    const start = startOfDay(DateTime.formatIsoDate(day), zone);
    // The day's end is the next day's start, which a clock change may move off 24 hours.
    const end = startOfDay(DateTime.formatIsoDate(DateTime.add(day, { days: 1 })), zone);
    return { until: end, word: dayWord(start, zone) };
  });
};

/**
 * A person's task that has waited on a teammate too long: one card to them, through the Chief of
 * staff, once per wait. Not for owner-level people (their check-ins tell it), a wait on an agent, a
 * task they can't see, or an agent's task (its own question to them is the ask).
 */
const waitedCards = Effect.fn("KinFactCards.waited")(function* (input: {
  readonly ctx: SenseContext;
  readonly open: ReadonlyArray<KinPulseFact>;
  readonly sees: (
    personId: KinPersonId,
    facts: ReadonlyArray<KinPulseFact>,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string }>, SqlError, SqlClient.SqlClient>;
  readonly level: ReadonlySet<string>;
  readonly posted: ReadonlyArray<CardRow>;
}) {
  const { ctx } = input;
  const { orgId, chief } = ctx;
  if (chief === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  for (const fact of input.open) {
    if (fact.sense !== "waiting_long" || fact.subject.recordId === undefined) continue;
    if (fact.actor._tag !== "person" || input.level.has(fact.actor.personId)) continue;
    const personId = fact.actor.personId;
    if (input.posted.some((row) => row.factKey === fact.key && row.personId === personId)) continue;
    const [row] = yield* sql<{
      key: string;
      title: string;
      rev: number;
      ownerId: string;
      holder: string | null;
      name: string;
      zone: string | null;
      workHours: string | null;
    }>`SELECT r.key, r.title, r.rev, r.owner_id AS "ownerId", h.display_name AS holder,
        p.display_name AS name,
        p.time_zone AS zone, p.work_hours_json AS "workHours"
      FROM kin_records r
      JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = ${personId}
        AND p.removed_at IS NULL
      LEFT JOIN kin_people h ON h.org_id = r.org_id AND h.person_id = r.owner_id
        AND h.removed_at IS NULL
      WHERE r.org_id = ${orgId} AND r.record_id = ${fact.subject.recordId}
        AND r.owner_kind = 'person' AND r.state = 'waiting' AND r.waiting_on_kind = 'person'
        AND r.waiting_on_id = ${personId}`;
    if (row === undefined || row.holder === null || row.ownerId === personId) continue;
    if ((yield* input.sees(personId, [fact])).length === 0) continue;
    const days = Math.max(1, fact.measure?.value ?? 1);
    const base = {
      factKey: fact.key,
      round: 0,
      personId,
      personName: row.name,
      agentId: chief,
      recordId: fact.subject.recordId,
      key: row.key,
      title: row.title,
      rev: row.rev,
      holder: { personId: row.ownerId, name: row.holder },
    };
    const plan = (answer: WaitedPlan["answer"], day?: { until: number; word: string }) =>
      ({
        kind: "waited_answer",
        answer,
        ...base,
        until: day?.until ?? null,
        day: day?.word ?? null,
      }) satisfies WaitedPlan;
    const [next, week] = answerDays(ctx.at, row.zone ?? ctx.zone, row.workHours);
    const options = [plan("done"), plan("by", next), plan("by", week), plan("not_mine")].map(
      (one) => ({ label: factCardShown(one).label, plan: one }),
    );
    yield* postFactCard({
      ctx,
      personId,
      agentId: chief,
      factKey: fact.key,
      round: 0,
      question: `${row.holder}'s ${row.key} ${row.title} has waited on you for ${daysText(days)}. Where is it?`,
      options,
      nudge: true,
      posted: input.posted,
    });
  }
});

/**
 * A task a teammate holds that has been in progress with no change: one card to them, through the
 * Chief of staff, as their nudge of the day. Still on it holds it until then, after which Kin asks
 * once more; Stuck is a plain answer, so its tap wakes the agent to ask what is in the way. Not for
 * owner-level holders (their check-ins tell it).
 */
const stallCards = Effect.fn("KinFactCards.stalled")(function* (input: {
  readonly ctx: SenseContext;
  readonly open: ReadonlyArray<KinPulseFact>;
  readonly sees: (
    personId: KinPersonId,
    facts: ReadonlyArray<KinPulseFact>,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string }>, SqlError, SqlClient.SqlClient>;
  readonly level: ReadonlySet<string>;
  readonly posted: ReadonlyArray<CardRow>;
}) {
  const { ctx } = input;
  const { orgId, chief } = ctx;
  if (chief === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  const after = toMs((yield* thresholds(orgId))("stalled_after_days"));
  for (const fact of input.open) {
    if (fact.sense !== "task_stalled" || fact.subject.recordId === undefined) continue;
    if (fact.actor._tag !== "person" || input.level.has(fact.actor.personId)) continue;
    const personId = fact.actor.personId;
    // Each Still on it that ran asks once more after it, as its line says.
    const round = input.posted.filter(
      (row) =>
        row.factKey === fact.key &&
        row.personId === personId &&
        row.answer === "still" &&
        row.ran !== null,
    ).length;
    if (
      input.posted.some(
        (row) => row.factKey === fact.key && row.personId === personId && row.round === round,
      )
    )
      continue;
    const [row] = yield* sql<{
      key: string;
      title: string;
      rev: number;
      name: string;
      zone: string | null;
    }>`SELECT r.key, r.title, r.rev, p.display_name AS name, p.time_zone AS zone
      FROM kin_records r
      JOIN kin_people p ON p.org_id = r.org_id AND p.person_id = r.owner_id
        AND p.removed_at IS NULL
      WHERE r.org_id = ${orgId} AND r.record_id = ${fact.subject.recordId}
        AND r.state = 'doing' AND r.owner_kind = 'person' AND r.owner_id = ${personId}`;
    if (row === undefined) continue;
    if ((yield* input.sees(personId, [fact])).length === 0) continue;
    const until = ctx.at + after;
    const base = {
      factKey: fact.key,
      round,
      personId,
      personName: row.name,
      agentId: chief,
      recordId: fact.subject.recordId,
      key: row.key,
      title: row.title,
      rev: row.rev,
      until,
      day: dayWord(until, row.zone ?? ctx.zone),
    };
    const plans = (["still", "done"] as const).map(
      (answer) => ({ kind: "stall_answer", answer, ...base }) satisfies StallPlan,
    );
    yield* postFactCard({
      ctx,
      personId,
      agentId: chief,
      factKey: fact.key,
      round,
      question: `${row.key} ${row.title} has been in progress with no change for ${daysText(Math.max(1, fact.measure?.value ?? 1))}. Where is it?`,
      options: [
        ...plans.map((plan) => ({ label: factCardShown(plan).label, plan })),
        { label: "Stuck" },
      ],
      nudge: true,
      posted: input.posted,
    });
  }
});

const MILESTONE_SENSES: ReadonlySet<string> = new Set(["milestone_late", "milestone_at_risk"]);
/** One card per milestone and due day, whether it is at risk or late by the time it is asked. */
const milestoneCardKey = (recordId: string, dueAt: number) =>
  `milestone_due:${recordId}:due=${dueAt}`;
/** What a card stands on: a fact's key, and a milestone's day for its card. */
const standKeys = (fact: {
  readonly key: string;
  readonly sense: string;
  readonly subject: { readonly recordId?: string | undefined };
}) => {
  const due = Number(fact.key.split(":due=")[1]);
  return MILESTONE_SENSES.has(fact.sense) && fact.subject.recordId !== undefined && due > 0
    ? [fact.key, milestoneCardKey(fact.subject.recordId, due)]
    : [fact.key];
};

/**
 * The day a milestone's open tasks give it: the latest one's due, when every open task has a due
 * still ahead and it is after the milestone's own; else undefined, and a person plans it.
 */
export const milestoneProposal = Effect.fn("KinFactCards.milestoneProposal")(function* (
  orgId: KinOrgId,
  milestone: { readonly key: string; readonly dueAt: number },
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    dueAt: number | null;
  }>`SELECT record_id AS "recordId", key, title, due_at AS "dueAt" FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work'
      AND json_extract(fields_json, '$.milestone') = ${milestone.key}
      AND state IN ('open', 'doing', 'waiting')
    ORDER BY due_at, key`;
  const last = tasks.at(-1);
  if (last?.dueAt == null || tasks.some((task) => task.dueAt === null || task.dueAt <= at))
    return undefined;
  return last.dueAt > milestone.dueAt ? { ...last, dueAt: last.dueAt } : undefined;
});

/**
 * A milestone late or at risk whose open tasks give it a day: one card proposing it, to the
 * project's holder when a person who may change the milestone, else the owner, in their chat with
 * the project's lead agent (else the Chief of staff). It is told to them by the card: the check-in
 * skips it.
 */
const milestoneCards = Effect.fn("KinFactCards.milestones")(function* (input: {
  readonly ctx: SenseContext;
  readonly open: ReadonlyArray<KinPulseFact>;
  readonly sees: (
    personId: KinPersonId,
    facts: ReadonlyArray<KinPulseFact>,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string }>, SqlError, SqlClient.SqlClient>;
  readonly level: ReadonlySet<string>;
  readonly posted: ReadonlyArray<CardRow>;
}) {
  const { ctx } = input;
  const { orgId, chief, at } = ctx;
  if (chief === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ personId: string }>`SELECT owner_person_id AS "personId"
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${chief}`;
  if (owner === undefined) return;
  for (const fact of input.open) {
    if (!MILESTONE_SENSES.has(fact.sense) || fact.subject.recordId === undefined) continue;
    const [, cardKey] = standKeys(fact);
    if (cardKey === undefined || input.posted.some((row) => row.factKey === cardKey)) continue;
    const [row] = yield* sql<{
      key: string;
      title: string;
      rev: number;
      dueAt: number;
      holderKind: string | null;
      holderId: string | null;
    }>`SELECT r.key, r.title, r.rev, r.due_at AS "dueAt", p.owner_kind AS "holderKind",
        p.owner_id AS "holderId"
      FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      WHERE r.org_id = ${orgId} AND r.record_id = ${fact.subject.recordId}
        AND r.register_id = 'milestones' AND r.state = 'open' AND r.due_at IS NOT NULL`;
    if (row === undefined || cardKey !== milestoneCardKey(fact.subject.recordId, row.dueAt))
      continue;
    const proposal = yield* milestoneProposal(orgId, row, at);
    if (proposal === undefined) continue;
    const lead =
      row.holderKind === "person" && row.holderId !== null
        ? KinPersonId.make(row.holderId)
        : undefined;
    const mayMove =
      lead !== undefined &&
      (input.level.has(lead) ||
        ((yield* input.sees(lead, [fact])).length > 0 &&
          (yield* mayChange(orgId, lead, { recordId: fact.subject.recordId, key: row.key }))));
    const personId = mayMove ? lead : KinPersonId.make(owner.personId);
    const agentId =
      row.holderKind === "agent" && row.holderId !== null && ctx.liveAgents.has(row.holderId)
        ? KinAgentId.make(row.holderId)
        : chief;
    const [person] = yield* sql<{ name: string; zone: string | null }>`SELECT
        display_name AS name, time_zone AS zone FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${personId} AND removed_at IS NULL`;
    if (person === undefined) continue;
    const zone = person.zone ?? ctx.zone;
    const base = {
      factKey: cardKey,
      round: 0,
      personId,
      personName: person.name,
      agentId,
      recordId: fact.subject.recordId,
      key: row.key,
      title: row.title,
      rev: row.rev,
      from: row.dueAt,
      to: proposal.dueAt,
      fromDay: dayWord(row.dueAt, zone),
      toDay: dayWord(proposal.dueAt, zone),
    };
    const plans = (["move_due", "keep_due"] as const).map(
      (kind) => ({ kind, ...base }) satisfies DuePlan,
    );
    // A teammate reads the task it names only when they may open it.
    const named =
      input.level.has(personId) ||
      (yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${orgId}
          AND r.record_id = ${proposal.recordId} AND ${viewSees(sql, [personId])}`).length > 0;
    const move = `Move ${row.key} to ${base.toDay}?`;
    const question =
      fact.sense === "milestone_late"
        ? `${row.key} ${row.title} was due ${base.fromDay}, ${daysText(Math.max(1, daysOverdue(row.dueAt, at, zone)))} ago; its open tasks are due by ${base.toDay}. ${move}`
        : named
          ? `${row.key} ${row.title} is due ${base.fromDay}, but its last open task, ${proposal.key} ${proposal.title}, is due ${base.toDay}. ${move}`
          : `${row.key} ${row.title} is due ${base.fromDay}, but its open tasks are due by ${base.toDay}. ${move}`;
    const card = yield* postFactCard({
      ctx,
      personId,
      agentId,
      factKey: cardKey,
      round: 0,
      question,
      options: plans.map((plan) => ({ label: factCardShown(plan).label, plan })),
      nudge: false,
      posted: input.posted,
    });
    if (card !== undefined)
      yield* markTold({
        orgId,
        personId,
        eventId: card.messageId,
        facts: [fact],
        at,
        zone: ctx.zone,
      });
  }
});

/** Whether a teammate may make this change to a record, as their own screens would. */
const mayChange = (
  orgId: KinOrgId,
  personId: KinPersonId,
  row: { readonly recordId: string; readonly key: string },
) =>
  // A due day is no owner's field: whoever may change the record may change it.
  teamGuard(orgId, personId, { row, changes: true, input: {} }).pipe(
    Effect.as(true),
    Effect.catchTags({ KinChatError: () => Effect.succeed(false) }),
  );

/**
 * In the pulse's tick, after holders are told: Kin's cards about facts that stand open, and the
 * way out of each whose fact cleared. A card that can't be posted is logged and never fails it.
 */
export const factCards = Effect.fn("KinFactCards.pass")(function* (input: {
  readonly ctx: SenseContext;
  /** Every fact sensed now, handled or not: what a card stands on. */
  readonly sensed: ReadonlyArray<Parameters<typeof standKeys>[0]>;
  /** Those open: not handled, not set aside, not quiet. */
  readonly open: ReadonlyArray<KinPulseFact>;
  readonly sees: (
    personId: KinPersonId,
    facts: ReadonlyArray<KinPulseFact>,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string }>, SqlError, SqlClient.SqlClient>;
}) {
  const { orgId } = input.ctx;
  const posted = yield* factCardRows(orgId);
  yield* settleFactCards(orgId, posted, new Set(input.sensed.flatMap(standKeys)));
  const level = yield* ownerLevelPeople(orgId);
  yield* waitedCards({ ...input, level, posted });
  yield* stallCards({ ...input, level, posted });
  yield* milestoneCards({ ...input, level, posted });
});
