import {
  KIN_WAITED_DONE_FIELD,
  KinAgentId,
  KinChatError,
  type KinChoiceOutcome,
  type KinOrgId,
  KinPersonId,
  type KinWidget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import type {
  DuePlan,
  FactCardPlan,
  NoticePlan,
  StallPlan,
  WaitedPlan,
} from "../widgets/cardPlans.ts";
import type { KinRecords } from "../work/KinRecords.ts";
import { insertComment, requestHashOf } from "../work/recordComments.ts";
import { viewSees } from "../work/teamView.ts";
import { DID_NOTHING, milestoneProposal } from "./factCards.ts";
import { noticeHolder } from "./holderNotice.ts";
import * as KinPulse from "./KinPulse.ts";
import { DAY_MS } from "./thresholds.ts";

/** "Not mine" sets the fact aside this long, for its holder to change who it waits on. */
const NOT_MINE_MS = 2 * DAY_MS;

type FactTap = {
  readonly orgId: KinOrgId;
  readonly widget: KinWidget;
  readonly personId: KinPersonId;
  readonly now: number;
};

const nothingDone = (why: string): KinChoiceOutcome => ({
  title: DID_NOTHING,
  text: `${why.charAt(0).toUpperCase()}${why.slice(1)}, so nothing was done.`,
});

/**
 * Has the fact in hand on the tapper's word: `theirs` hides it from them alone, `company` also
 * quiets the owner (through the card's agent). `gone`: the fact no longer stands; `in_hand`: a
 * teammate's own answer would replace one the owner's read counts, so nothing is written.
 */
const holdFact = Effect.fn("KinFactCards.holdFact")(function* (
  tap: FactTap,
  plan: FactCardPlan,
  input: {
    readonly factKey: string;
    readonly action: "got_it" | "not_a_problem";
    readonly until?: number;
    readonly note: string;
    readonly view: "theirs" | "company";
  },
) {
  const own = yield* ownerLevel(tap.orgId, tap.personId);
  const forCompany = !own && input.view === "company";
  if (!own && input.view === "theirs") {
    const read = yield* KinPulse.read({
      orgId: tap.orgId,
      at: tap.now,
      viewer: { _tag: "owner" },
      includeHandled: true,
      factKeys: new Set([input.factKey]),
    });
    if (read.facts.some((fact) => fact.key === input.factKey && fact.handled !== null))
      return "in_hand" as const;
  }
  return yield* KinPulse.handle({
    orgId: tap.orgId,
    at: tap.now,
    viewer: own || forCompany ? { _tag: "owner" } : { _tag: "people", people: [tap.personId] },
    by: forCompany
      ? { _tag: "agent", agentId: KinAgentId.make(plan.agentId) }
      : { _tag: "person", personId: tap.personId },
    factKey: input.factKey,
    action: input.action,
    ...(input.until === undefined ? {} : { until: input.until }),
    note: input.note,
  }).pipe(
    Effect.as("held" as const),
    Effect.catchIf(
      (error) => error._tag === "KinChatError" && error.reason === "not_found",
      () => Effect.succeed("gone" as const),
    ),
  );
});

/**
 * Tells the task's holder what the person it waited on answered, once per card. False when no
 * chat could carry it (`noticeHolder`).
 */
const tellHolder = (tap: FactTap, plan: WaitedPlan, body: string) =>
  noticeHolder({
    orgId: tap.orgId,
    personId: KinPersonId.make(plan.holder.personId),
    agentId: KinAgentId.make(plan.agentId),
    body,
    key: `fact-card-${tap.widget.widgetId.replace(/[^A-Za-z0-9-]/g, "-")}`,
  }).pipe(Effect.map((noticeId) => noticeId !== undefined));

const runWaited = Effect.fn("KinFactCards.runWaited")(function* (
  tap: FactTap,
  plan: WaitedPlan,
  records: KinRecords["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    state: string;
    rev: number;
    title: string;
    ownerKind: string;
    ownerId: string;
    waitingKind: string | null;
    waitingId: string | null;
  }>`SELECT state, rev, title, owner_kind AS "ownerKind", owner_id AS "ownerId",
      waiting_on_kind AS "waitingKind", waiting_on_id AS "waitingId"
    FROM kin_records WHERE org_id = ${tap.orgId} AND record_id = ${plan.recordId}`;
  const notWaiting = nothingDone(`${plan.key} no longer waits on you`);
  const inHand = nothingDone(`${plan.key} is already in hand`);
  if (
    row === undefined ||
    row.state !== "waiting" ||
    row.waitingKind !== "person" ||
    row.waitingId !== tap.personId
  )
    return notWaiting;
  // Done writes the task: only while it is the one the card names. By and Not mine write none.
  if (
    plan.answer === "done" &&
    (row.ownerKind !== "person" || row.ownerId !== plan.holder.personId || row.title !== plan.title)
  )
    return nothingDone(`${plan.key} changed since this was offered`);
  const named = `${plan.key} ${plan.title}`;
  const holder = plan.holder.name;
  const told = `Told ${holder}`;
  const unreached = {
    title: `Couldn't reach ${holder}`,
    text: `Kin couldn't reach ${holder} to pass this on.`,
  };
  switch (plan.answer) {
    case "done": {
      // The one change the person it waited on may make to someone else's task: waiting to open.
      yield* records.update(
        tap.orgId,
        {
          actor: { _tag: "person", personId: tap.personId },
          via: "owner",
          chatId: tap.widget.chatId,
          answering: [tap.widget.widgetId],
        },
        plan.key,
        { state: "open" },
        row.rev,
        [{ field: KIN_WAITED_DONE_FIELD, from: null, to: tap.widget.widgetId }],
      );
      const reached = yield* tellHolder(
        tap,
        plan,
        `${plan.personName} says what ${named} waited on is done, so it is back with you.`,
      );
      return reached
        ? { title: told, text: `${plan.key} is back with ${holder}.` }
        : {
            title: unreached.title,
            text: `${plan.key} is back with ${holder}, but Kin couldn't reach ${holder} to say so.`,
          };
    }
    case "by": {
      const { until, day } = plan;
      if (until === null || day === null || until <= tap.now)
        return nothingDone(`${day ?? "that day"} has passed`);
      const hold = (view: "theirs" | "company") =>
        holdFact(tap, plan, {
          factKey: plan.factKey,
          action: "got_it",
          until,
          note: `${plan.personName}: by ${day}`,
          view,
        });
      // Theirs first, so a fact gone tells nobody; the owner is quiet only once the holder knows.
      const theirs = yield* hold("theirs");
      if (theirs === "gone") return notWaiting;
      if (theirs === "in_hand") return inHand;
      const reached = yield* tellHolder(
        tap,
        plan,
        `${plan.personName} says ${named} will have what it waits on by ${day}.`,
      );
      if (!reached) return unreached;
      yield* hold("company");
      return { title: told, text: `${plan.key} comes back after ${day} if it still waits on you.` };
    }
    case "not_mine": {
      const held = yield* holdFact(tap, plan, {
        factKey: plan.factKey,
        action: "got_it",
        until: tap.now + NOT_MINE_MS,
        note: `${plan.personName}: not mine`,
        view: "theirs",
      });
      if (held === "gone") return notWaiting;
      if (held === "in_hand") return inHand;
      // The answer outlasts the hold: the owner reading the task sees who said it isn't theirs.
      const body = `${plan.personName} answered Kin's card: ${plan.key} doesn't wait on ${plan.personName}.`;
      yield* insertComment({
        orgId: tap.orgId,
        key: plan.key,
        author: { _tag: "agent", agentId: KinAgentId.make(plan.agentId), askedBy: null },
        requestId: `fact-card:${tap.widget.widgetId}`,
        requestHash: requestHashOf(body, []),
        body,
        files: [],
        now: tap.now,
        sees: () => Effect.succeed(true),
      });
      const reached = yield* tellHolder(
        tap,
        plan,
        `${plan.personName} says ${named} doesn't wait on ${plan.personName}. Change who it waits on, or pick it up.`,
      );
      return reached
        ? { title: told, text: `${holder} will change who ${plan.key} waits on.` }
        : unreached;
    }
  }
});

const runStall = Effect.fn("KinFactCards.runStall")(function* (
  tap: FactTap,
  plan: StallPlan,
  records: KinRecords["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: string; rev: number; ownerKind: string; ownerId: string }>`
    SELECT state, rev, owner_kind AS "ownerKind", owner_id AS "ownerId" FROM kin_records
    WHERE org_id = ${tap.orgId} AND record_id = ${plan.recordId}`;
  if (
    row === undefined ||
    row.state !== "doing" ||
    row.ownerKind !== "person" ||
    row.ownerId !== tap.personId ||
    row.rev !== plan.rev
  )
    return nothingDone(`${plan.key} changed since this was offered`);
  if (plan.answer === "still") {
    if (plan.until <= tap.now) return nothingDone(`${plan.day} has passed`);
    const held = yield* holdFact(tap, plan, {
      factKey: plan.factKey,
      action: "got_it",
      until: plan.until,
      note: `${plan.personName}: still on it`,
      // Only the first quiets the owner, until Kin asks again; after it the stall is told.
      view: plan.round === 0 ? "company" : "theirs",
    });
    if (held === "gone") return nothingDone(`${plan.key} moved on`);
    if (held === "in_hand") return nothingDone(`${plan.key} is already in hand`);
    return { title: "Noted", text: `Kin asks again on ${plan.day} if ${plan.key} hasn't moved.` };
  }
  // As the holder marks it done on their own task, under the same rule as their screens.
  const own = yield* ownerLevel(tap.orgId, tap.personId);
  yield* records.update(
    tap.orgId,
    {
      actor: { _tag: "person", personId: tap.personId },
      via: "owner",
      chatId: tap.widget.chatId,
      answering: [tap.widget.widgetId],
      ...(own ? {} : { teammate: true }),
    },
    plan.key,
    { state: "done" },
    plan.rev,
  );
  return { title: "Marked done", text: `${plan.key} is done.` };
});

const runDue = Effect.fn("KinFactCards.runDue")(function* (
  tap: FactTap,
  plan: DuePlan,
  records: KinRecords["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: string; rev: number; dueAt: number | null }>`SELECT state,
      rev, due_at AS "dueAt" FROM kin_records
    WHERE org_id = ${tap.orgId} AND record_id = ${plan.recordId}`;
  const changed = nothingDone(`${plan.key} or its tasks changed since this was offered`);
  if (row === undefined || row.state !== "open" || row.dueAt !== plan.from) return changed;
  if (plan.kind === "keep_due") {
    const facts = [
      `milestone_late:${plan.key}:due=${plan.from}`,
      `milestone_at_risk:${plan.key}:due=${plan.from}`,
    ];
    for (const factKey of facts) {
      const held = yield* holdFact(tap, plan, {
        factKey,
        action: "not_a_problem",
        note: `${plan.personName}: leave it`,
        view: "theirs",
      });
      if (held === "held")
        return { title: "Left as it is", text: `${plan.key} stays due ${plan.fromDay}.` };
      if (held === "in_hand") return nothingDone(`${plan.key} is already in hand`);
    }
    return nothingDone(`${plan.key} no longer needs a new date`);
  }
  const proposal = yield* milestoneProposal(
    tap.orgId,
    { key: plan.key, dueAt: plan.from },
    tap.now,
  );
  if (row.rev !== plan.rev || proposal?.dueAt !== plan.to) return changed;
  const own = yield* ownerLevel(tap.orgId, tap.personId);
  yield* records.update(
    tap.orgId,
    {
      actor: { _tag: "person", personId: tap.personId },
      via: "owner",
      chatId: tap.widget.chatId,
      answering: [tap.widget.widgetId],
      ...(own ? {} : { teammate: true }),
    },
    plan.key,
    { dueAt: plan.to },
    plan.rev,
  );
  return { title: "Milestone moved", text: `${plan.key} ${plan.title} is due ${plan.toDay}.` };
});

/**
 * Let it renew: the owner level's answer is the company's, so their check-ins stop telling it; a
 * teammate's quiets it for them alone.
 */
const runNotice = Effect.fn("KinFactCards.runNotice")(function* (tap: FactTap, plan: NoticePlan) {
  const held = yield* holdFact(tap, plan, {
    factKey: plan.factKey,
    action: "not_a_problem",
    note: `${plan.personName}: let it renew`,
    view: "theirs",
  });
  if (held === "gone") return nothingDone(`${plan.key}'s notice day is no longer yours to answer`);
  if (held === "in_hand") return nothingDone(`${plan.key}'s notice day is already in hand`);
  return {
    title: "Left to renew",
    text: `${plan.key} renews ${plan.renewsOn} as agreed. Nothing was sent.`,
  };
});

/**
 * A tap on Kin's card about a fact, in the tap's transaction: only the person it asks may answer,
 * and only while what it asked about is as it was; else nothing is done and the card says why.
 */
export const runFactCard = Effect.fn("KinFactCards.run")(function* (
  tap: FactTap,
  plan: FactCardPlan,
  records: KinRecords["Service"],
) {
  if (tap.personId !== plan.personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the person this card asks can answer it.",
    });
  // A teammate answers only what they still see, read again here, before anything is written.
  if (!(yield* ownerLevel(tap.orgId, tap.personId))) {
    const sql = yield* SqlClient.SqlClient;
    const seen = yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${tap.orgId}
      AND r.record_id = ${plan.recordId} AND ${viewSees(sql, [tap.personId])}`;
    if (seen.length === 0) return nothingDone(`you can no longer see ${plan.key}`);
  }
  switch (plan.kind) {
    case "waited_answer":
      return yield* runWaited(tap, plan, records);
    case "stall_answer":
      return yield* runStall(tap, plan, records);
    case "move_due":
    case "keep_due":
      return yield* runDue(tap, plan, records);
    case "notice_renew":
      return yield* runNotice(tap, plan);
  }
});
