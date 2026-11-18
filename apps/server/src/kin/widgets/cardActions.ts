import {
  KinChatError,
  KinChatId,
  KinDeferralCard,
  KinEventId,
  type KinChoiceOutcome,
  type KinMemberId,
  KinMemoryItemId,
  type KinOrgId,
  KinPersonId,
  type KinWidget,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatService } from "../chat/KinChatService.ts";
import { SHARED_REFUSAL, aborted, peopleBehind } from "../lead/Audience.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import * as Memory from "../memory/Memory.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { answerCard, readQuestion } from "../questions/openQuestions.ts";
import {
  KinDeferralStopSwitch,
  deferralLead,
  deferralWidgetId,
  makeDeferralStarter,
} from "../triggers/deferrals.ts";
import type { KinRecords } from "../work/KinRecords.ts";
import { viewOf } from "../work/leadWork.ts";
import { defineProposed, proposalShown } from "../work/registers.ts";
import { teamGuard, viewVisible } from "../work/teamView.ts";
import {
  type CardActionInput,
  type CardDraw,
  type CardPlan,
  type RunPlan,
  plansOf,
} from "./cardPlans.ts";

/*
 * The fixed actions a `kin_ask` option may carry (`CARD_ACTIONS`): each is drawn (`draw`) in the
 * agent's turn and run (`run`) by a person's tap, through Kin's own writers. Add an action as one
 * case of each, its plan in `cardPlans.ts` and its line in `lineOf`.
 */

type DrawTurn = Parameters<typeof viewOf>[0];
const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const notFound = (what: string) =>
  new KinChatError({ reason: "not_found", message: `No ${what}. Name one from this turn.` });
const notAllowed = (message: string) => new KinChatError({ reason: "not_allowed", message });
const PENDING_RUNS = ["heads_up", "asked", "grace"];
const decodeDeferralCard = Schema.decodeOption(Schema.fromJsonString(KinDeferralCard));
const quoted = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`}”`;
};

/** The line a card shows for a plan: the real verb and target, written by the server. */
const lineOf = (plan: CardPlan): string => {
  switch (plan.kind) {
    case "done":
      return `Mark ${plan.key} ${quoted(plan.title)} done`;
    case "drop":
      return `Drop ${plan.key} ${quoted(plan.title)}`;
    case "start":
      return `Start ${quoted(plan.title)} now`;
    case "create_list":
      return plan.listRev === null
        ? `Create the list ${quoted(plan.name, 60)}`
        : `Add the proposed fields to ${quoted(plan.name, 60)}`;
    case "take_default": {
      const went = `Go with ${quoted(plan.label, 40)} on ${quoted(plan.question, 60)}`;
      return plan.final === null ? went : `${went}: ${lineOf(plan.final)}`;
    }
  }
};

/** The people the turn acts for now, and its ceiling: owner-level, or those teammates'. */
const drawOf = Effect.fn("KinCardActions.drawOf")(function* (lead: DrawTurn) {
  if (yield* aborted(lead)) return yield* notAllowed(SHARED_REFUSAL);
  const team = yield* viewOf(lead);
  if (team !== undefined)
    return {
      agentId: lead.agentId,
      wakeupId: lead.wakeupId,
      ceiling: "team",
      people: [...team.people],
      askers: [...team.askers],
    } satisfies CardDraw;
  const behind = yield* peopleBehind(lead);
  return {
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
    ceiling: "owner",
    people: [...new Set([...(behind?.readers ?? []), ...(behind?.askers ?? [])])].toSorted(),
    askers: [...(behind?.askers ?? [])].toSorted(),
  } satisfies CardDraw;
});

/** The card's readers who are not owner-level: every one of them must see what its line names. */
const teammatesIn = Effect.fn("KinCardActions.teammatesIn")(function* (
  orgId: KinOrgId,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId}
      AND principal_kind = 'person' AND left_at IS NULL AND person_id IS NOT NULL
    ORDER BY person_id`;
  const out: Array<KinPersonId> = [];
  for (const row of rows) {
    const person = KinPersonId.make(row.personId);
    if (!(yield* ownerLevel(orgId, person))) out.push(person);
  }
  return out;
});

const recordRow = Effect.fn("KinCardActions.recordRow")(function* (
  orgId: KinOrgId,
  where: { readonly key: string } | { readonly recordId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    recordId: string;
    registerId: string;
    key: string;
    title: string;
    state: string;
    rev: number;
  }>`SELECT record_id AS "recordId", register_id AS "registerId", key, title, state, rev
    FROM kin_records WHERE org_id = ${orgId} AND ${
      "key" in where ? sql`key = ${where.key.toUpperCase()}` : sql`record_id = ${where.recordId}`
    }`;
  return row;
});

/** Whether the turn's own people could make this change themselves, as their screens would. */
const teamMay = Effect.fn("KinCardActions.teamMay")(function* (
  orgId: KinOrgId,
  draw: CardDraw,
  row: { readonly recordId: string; readonly key: string },
  state: "done" | "dropped",
) {
  if (draw.ceiling === "owner") return true;
  if (draw.people.length === 0) return false;
  for (const person of draw.people) {
    const refused = yield* teamGuard(orgId, KinPersonId.make(person), {
      row,
      changes: draw.askers.includes(person),
      input: { state },
    }).pipe(Effect.as(false), Effect.catchTags({ KinChatError: () => Effect.succeed(true) }));
    if (refused) return false;
  }
  return true;
});

/**
 * Resolves an option's action in the agent's turn, as that turn could do it: refused here when
 * it couldn't. The plan names exactly what a tap runs; `line` is what the card shows for it.
 */
export const draw = Effect.fn("KinCardActions.draw")(function* (
  lead: DrawTurn,
  chatId: KinChatId,
  input: CardActionInput,
) {
  const orgId = lead.orgId;
  const drawn = yield* drawOf(lead);
  const teammates = yield* teammatesIn(orgId, chatId);
  const ownerTier = Effect.fn("KinCardActions.ownerTier")(function* (tool: string) {
    if (
      drawn.ceiling !== "owner" ||
      teammates.length > 0 ||
      !(yield* toolAdmitted(lead, tool, input))
    )
      return yield* notAllowed(SHARED_REFUSAL);
  });
  const plan: CardPlan = yield* Effect.gen(function* () {
    switch (input.kind) {
      case "done":
      case "drop": {
        if (!(yield* toolAdmitted(lead, "record_update", input)))
          return yield* notAllowed(SHARED_REFUSAL);
        const row = yield* recordRow(orgId, { key: input.target });
        if (
          row === undefined ||
          (teammates.length > 0 && !(yield* viewVisible(orgId, teammates, row.recordId)))
        )
          return yield* notFound(`entry ${input.target.slice(0, 40)}`);
        if (row.registerId !== "work") return yield* refuse(`${row.key} is not a task.`);
        if (row.state === "done" || row.state === "dropped")
          return yield* refuse(`${row.key} is ${row.state} already.`);
        const state = input.kind === "done" ? "done" : "dropped";
        if (!(yield* teamMay(orgId, drawn, row, state)))
          return yield* notAllowed(`The people you are acting for can't change ${row.key}.`);
        return {
          kind: input.kind,
          recordId: row.recordId,
          key: row.key,
          title: row.title,
          rev: row.rev,
          draw: drawn,
        } as const;
      }
      case "start": {
        yield* ownerTier("kin_defer");
        const sql = yield* SqlClient.SqlClient;
        const [run] = yield* sql<{ state: string; dueAt: number | null }>`SELECT state,
            due_at AS "dueAt" FROM kin_deferral_runs
          WHERE org_id = ${orgId} AND item_id = ${input.target}`;
        if (run === undefined) return yield* notFound(`deferral ${input.target.slice(0, 40)}`);
        if (!PENDING_RUNS.includes(run.state) || run.dueAt === null)
          return yield* refuse("That deferral isn't due, so it can't start now.");
        const memory = yield* Effect.serviceOption(Memory.Memory);
        const item = Option.isNone(memory)
          ? Option.none()
          : yield* memory.value
              .readItemQuietly(orgId, KinMemoryItemId.make(input.target), "triggers")
              .pipe(Effect.option);
        if (Option.isNone(item) || item.value.head.kind !== "deferral")
          return yield* notFound(`deferral ${input.target.slice(0, 40)}`);
        return {
          kind: "start",
          itemId: input.target,
          dueAt: run.dueAt,
          title: (yield* deferralCard(orgId, input.target))?.title ?? input.target,
          chat: item.value.head.chat ?? null,
          sourceEvent: item.value.head.source_event ?? null,
          draw: drawn,
        } as const;
      }
      case "create_list": {
        yield* ownerTier("list_define");
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ json: string; definedAt: number | null }>`SELECT
            definition_json AS json, defined_at AS "definedAt" FROM kin_list_proposals
          WHERE org_id = ${orgId} AND proposal_id = ${input.target}
            AND agent_id = ${lead.agentId}`;
        if (row === undefined) return yield* notFound(`proposal ${input.target.slice(0, 40)}`);
        if (row.definedAt !== null) return yield* refuse("That list was made already.");
        const shown = yield* proposalShown(orgId, row.json);
        if (shown === undefined) return yield* refuse("That proposal can no longer be read.");
        return {
          kind: "create_list",
          proposalId: input.target,
          definition: row.json,
          ...shown,
          draw: drawn,
        } as const;
      }
      case "take_default": {
        const row = yield* readQuestion(orgId, input.target);
        if (row === undefined || row.agentId !== lead.agentId || row.state !== "open")
          return yield* notFound(`open question ${input.target.slice(0, 40)} of yours`);
        const widgetId = row.raiseWidgetId ?? row.widgetId;
        const option = row.options.find((one) => one.label === row.defaultLabel);
        if (widgetId === null || option === undefined || row.defaultLabel === null)
          return yield* refuse("That question has no default to take.");
        if (teammates.some((person) => person !== row.personId))
          return yield* notAllowed(SHARED_REFUSAL);
        const final =
          row.widgetId === null
            ? undefined
            : (yield* plansOf(orgId, row.widgetId)).get(option.optionId);
        return {
          kind: "take_default",
          questionId: row.questionId,
          question: row.question,
          widgetId,
          optionId: option.optionId,
          label: row.defaultLabel,
          final: final === undefined || final.kind === "take_default" ? null : final,
          draw: drawn,
        } as const;
      }
    }
  });
  return { plan, line: lineOf(plan) };
});

const deferralCard = Effect.fn("KinCardActions.deferralCard")(function* (
  orgId: KinOrgId,
  itemId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: string }>`SELECT state_json AS state FROM kin_widgets
    WHERE org_id = ${orgId} AND widget_id = ${deferralWidgetId(orgId, itemId)}`;
  return row === undefined ? undefined : Option.getOrUndefined(decodeDeferralCard(row.state));
});

const NOTHING_DONE = "Nothing was done";
/** What a tap left undone, and why: the card closes with it. */
const nothingDone = (why: string): KinChoiceOutcome => ({
  title: NOTHING_DONE,
  text: `${why.charAt(0).toUpperCase()}${why.slice(1)}, so nothing was done.`,
});

/** Whether whoever drew the plan could still do it: the lead is live, its people still may. */
const drawHolds = Effect.fn("KinCardActions.drawHolds")(function* (orgId: KinOrgId, d: CardDraw) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ name: string }>`SELECT COALESCE(l.name, a.display_name) AS name
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${d.agentId} AND a.retired_at IS NULL`;
  if (lead === undefined) return "the agent that offered it is retired";
  if (d.ceiling === "owner")
    for (const person of d.people)
      if (!(yield* ownerLevel(orgId, KinPersonId.make(person))))
        return "someone it was offered for is no longer an owner";
  return undefined;
});

export type ActionTap = {
  readonly orgId: KinOrgId;
  readonly widget: KinWidget;
  readonly personId: KinPersonId;
  readonly memberId: KinMemberId;
  readonly now: number;
};

/**
 * Runs a sealed plan for a person's tap, inside the tap's transaction. The tapper's own right to
 * do it now is required, and refuses the tap (the card stays open for someone who may); a change
 * since the draw, or a drawer who no longer could, closes the card with what was not done.
 */
export const run = Effect.fn("KinCardActions.run")(function* (
  tap: ActionTap,
  plan: CardPlan,
  deps: {
    readonly records: KinRecords["Service"];
    readonly chat: Pick<KinChatService["Service"], "closeReplaced">;
  },
) {
  if (plan.kind !== "take_default") return yield* runOne(tap, plan, deps.records);
  const row = yield* readQuestion(tap.orgId, plan.questionId);
  if (row !== undefined && row.personId !== tap.personId)
    return yield* notAllowed("Only the person it was asked of can answer this question.");
  if (
    row === undefined ||
    row.state !== "open" ||
    row.agentId !== plan.draw.agentId ||
    row.defaultLabel !== plan.label ||
    (row.raiseWidgetId ?? row.widgetId) !== plan.widgetId
  )
    return nothingDone(`${quoted(plan.question)} isn't open as it was`);
  const why = yield* drawHolds(tap.orgId, plan.draw);
  if (why !== undefined) return nothingDone(why);
  const done = plan.final === null ? undefined : yield* runOne(tap, plan.final, deps.records);
  if (done?.title === NOTHING_DONE) return done;
  yield* answerCard({
    orgId: tap.orgId,
    widgetId: plan.widgetId,
    personId: tap.personId,
    label: plan.label,
    now: tap.now,
  });
  const went = { title: `Went with ${quoted(plan.label, 40)}`, text: "Answered on a later card." };
  for (const widgetId of new Set([row.widgetId, row.raiseWidgetId]))
    if (widgetId !== null && widgetId !== tap.widget.widgetId)
      yield* deps.chat.closeReplaced({
        orgId: tap.orgId,
        widgetId: KinWidgetId.make(widgetId),
        outcome: went,
      });
  return done ?? { title: went.title, text: `Answered ${quoted(plan.question)} with its default.` };
});

const runOne = Effect.fn("KinCardActions.runOne")(function* (
  tap: ActionTap,
  plan: RunPlan,
  records: KinRecords["Service"],
) {
  const { orgId, personId } = tap;
  const owner = yield* ownerLevel(orgId, personId);
  switch (plan.kind) {
    case "done":
    case "drop": {
      const state = plan.kind === "done" ? "done" : "dropped";
      const row = yield* recordRow(orgId, { recordId: plan.recordId });
      if (row === undefined) return nothingDone(`${plan.key} is gone`);
      if (!owner) yield* teamGuard(orgId, personId, { row, changes: true, input: { state } });
      if (row.rev !== plan.rev) return nothingDone(`${plan.key} changed since this was offered`);
      const why = yield* drawHolds(orgId, plan.draw);
      if (why !== undefined) return nothingDone(why);
      if (!(yield* teamMay(orgId, plan.draw, row, state)))
        return nothingDone(`whoever it was offered for can no longer change ${plan.key}`);
      yield* records.update(
        orgId,
        {
          actor: { _tag: "person", personId },
          via: "owner",
          askedBy: personId,
          chatId: tap.widget.chatId,
          ...(owner ? {} : { teammate: true }),
        },
        row.key,
        { state },
        plan.rev,
      );
      return plan.kind === "done"
        ? { title: "Done", text: `Marked ${row.key} ${quoted(row.title)} done.` }
        : { title: "Dropped", text: `Dropped ${row.key} ${quoted(row.title)}.` };
    }
    case "start": {
      if (!owner) return yield* notAllowed("Only an owner can start this.");
      const sql = yield* SqlClient.SqlClient;
      const [runRow] = yield* sql<{ state: string; dueAt: number | null }>`SELECT state,
          due_at AS "dueAt" FROM kin_deferral_runs
        WHERE org_id = ${orgId} AND item_id = ${plan.itemId}`;
      if (
        runRow === undefined ||
        !PENDING_RUNS.includes(runRow.state) ||
        runRow.dueAt !== plan.dueAt
      )
        return nothingDone(`${quoted(plan.title)} isn't waiting to start any more`);
      const why = yield* drawHolds(orgId, plan.draw);
      if (why !== undefined) return nothingDone(why);
      if (yield* (yield* KinDeferralStopSwitch).isStopped(orgId))
        return nothingDone("Kin's deferred work is stopped");
      const card = yield* deferralCard(orgId, plan.itemId);
      if (card === undefined) return nothingDone(`${quoted(plan.title)} is no longer open`);
      const item = {
        ...(plan.chat === null ? {} : { chat: KinChatId.make(plan.chat) }),
        ...(plan.sourceEvent === null ? {} : { source_event: KinEventId.make(plan.sourceEvent) }),
      };
      if ((yield* deferralLead(sql, orgId, item)) === undefined)
        return nothingDone("no agent can take it now");
      // The same start a fire or a [Start now] makes: one `deferral.due`, keyed by the due fire.
      const started = yield* (yield* makeDeferralStarter)({
        orgId,
        itemId: KinMemoryItemId.make(plan.itemId),
        dueAt: plan.dueAt,
        card,
        provenance: { _tag: "human", personId, memberId: tap.memberId },
        at: tap.now,
        now: tap.now,
        from: runRow.state,
        item,
      }).pipe(
        Effect.catchTags({
          KinEventQueueConflict: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueUnknownEvent: () => Effect.succeed(false),
        }),
      );
      if (!started) return nothingDone(`${quoted(plan.title)} couldn't start`);
      return { title: "Started", text: `Started ${quoted(plan.title)}.` };
    }
    case "create_list": {
      if (!owner) return yield* notAllowed("Only an owner can create a list.");
      const why =
        (yield* drawHolds(orgId, plan.draw)) ??
        (yield* defineProposed({
          orgId,
          agentId: plan.draw.agentId,
          proposalId: plan.proposalId,
          definition: plan.definition,
          listRev: plan.listRev,
          now: tap.now,
        }));
      if (why !== undefined) return nothingDone(why);
      return plan.listRev === null
        ? { title: "List created", text: `Created the list ${quoted(plan.name, 60)}.` }
        : { title: "List changed", text: `Added the proposed fields to ${quoted(plan.name, 60)}.` };
    }
  }
});
