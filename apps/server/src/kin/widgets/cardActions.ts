import * as KinShell from "../shell/KinShell.ts";
import { listSectionRefused, sectionOfList } from "../shell/sections.ts";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinChoiceCardState,
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
import { routeShown, runRoute } from "../lead/routeCard.ts";
import { recommendShown, runRecommend } from "../recommend/card.ts";
import { leaverShown, runLeaver } from "../people/leaver.ts";
import { factCardShown } from "../pulse/factCards.ts";
import { runFactCard } from "../pulse/factCardTaps.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import * as Memory from "../memory/Memory.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { runTaken, takenFor, undoLine } from "../questions/defaultTaken.ts";
import {
  type QuestionRow,
  UNDO_ANSWER_LINE,
  answerCard,
  readQuestion,
  runAnswered,
} from "../questions/openQuestions.ts";
import {
  KinDeferralStopSwitch,
  deferralLead,
  deferralWidgetId,
  makeDeferralStarter,
} from "../triggers/deferrals.ts";
import { isHelperRefusal, type KinRecords } from "../work/KinRecords.ts";
import { viewOf } from "../work/leadWork.ts";
import { repeatOf } from "../work/recordRows.ts";
import {
  defineProposed,
  listDef,
  listPlace,
  proposalToCreate,
  proposedList,
} from "../work/registers.ts";
import { teamGuard, viewVisible } from "../work/teamView.ts";
import {
  drawPayment,
  paymentLabel,
  paymentLine,
  recordPayment,
} from "../work/statements/creditPayment.ts";
import { drawRepaid, markRepaid, repaidLabel, repaidLine } from "../work/statements/repaidCard.ts";
import {
  type CardActionInput,
  type CardDraw,
  type CardPlan,
  type RunPlan,
  isAnswered,
  isFactCard,
  isTaken,
  plansOf,
  takesAsDefault,
} from "./cardPlans.ts";

/*
 * The fixed actions a `kin_ask` option may carry (`CARD_ACTIONS`): each is drawn (`draw`) in the
 * agent's turn and run (`run`) by a person's tap, through Kin's own writers. Add an action as one
 * case of each, its plan in `cardPlans.ts` and its line in `lineOf`.
 */

type DrawTurn = Parameters<typeof viewOf>[0];
type DrawLead = Pick<DrawTurn, "orgId" | "agentId" | "wakeupId">;
const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });
const notFound = (what: string) =>
  new KinChatError({ reason: "not_found", message: `No ${what}. Name one from this turn.` });
const notAllowed = (message: string) => new KinChatError({ reason: "not_allowed", message });
const PENDING_RUNS = ["heads_up", "asked", "grace"];
const decodeDeferralCard = Schema.decodeOption(Schema.fromJsonString(KinDeferralCard));
const decodeChoice = Schema.decodeUnknownOption(Schema.fromJsonString(KinChoiceCardState));
const decodeAwaiting = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const quoted = (text: string, max = 80) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return `“${flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`}”`;
};

const LABEL_MAX = 80;
/** The option's button for a plan: the verb and its key, written by the server, never the agent. */
const labelOf = (plan: CardPlan): string => {
  switch (plan.kind) {
    case "done":
      return `Mark ${plan.key} done`;
    case "drop":
      return `Drop ${plan.key}`;
    case "start":
      return "Start it now";
    case "create_list":
      return "Create the list";
    case "record_payment":
      return paymentLabel(plan);
    case "mark_repaid":
      return repaidLabel(plan);
    case "take_default": {
      const label = `Take the default: ${plan.label}`;
      return label.length <= LABEL_MAX ? label : `${label.slice(0, LABEL_MAX - 1)}…`;
    }
    case "let_talk":
      return routeShown(plan).label;
    case "recommend":
      return recommendShown(plan).label;
    case "leaver":
      return leaverShown(plan).label;
    case "waited_answer":
    case "stall_answer":
    case "move_due":
    case "keep_due":
    case "notice_renew":
      return factCardShown(plan).label;
    case "undo_default":
      return "Undo";
    case "keep_default":
    case "keep_answer":
      return "Keep it";
    case "undo_answer":
      return "Undo";
  }
};

/** The line a card shows under it: the real verb and target, with its title. */
const lineOf = (plan: CardPlan): string => {
  switch (plan.kind) {
    case "done":
      return `Mark ${plan.key} ${quoted(plan.title)} done`;
    case "drop":
      return `Drop ${plan.key} ${quoted(plan.title)}`;
    case "start":
      return `Start ${quoted(plan.title)} now`;
    case "create_list":
      return `Create the list ${quoted(plan.name, 60)}`;
    case "record_payment":
      return paymentLine(plan);
    case "mark_repaid":
      return repaidLine(plan);
    case "take_default": {
      const went = `Go with ${quoted(plan.label, 40)} on ${quoted(plan.question, 60)}`;
      return plan.final === null ? went : `${went}: ${lineOf(plan.final)}`;
    }
    case "let_talk":
      return routeShown(plan).line;
    case "recommend":
      return recommendShown(plan).line;
    case "leaver":
      return leaverShown(plan).line;
    case "waited_answer":
    case "stall_answer":
    case "move_due":
    case "keep_due":
    case "notice_renew":
      return factCardShown(plan).line;
    case "undo_default":
      return undoLine(plan);
    case "keep_default":
      return `Keep ${quoted(plan.label, 40)}`;
    case "undo_answer":
      return UNDO_ANSWER_LINE;
    case "keep_answer":
      return plan.answer === null ? "Keep it" : `Keep ${quoted(plan.answer, 40)}`;
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

type DrawnTurn = {
  readonly drawn: CardDraw;
  readonly teammates: ReadonlyArray<KinPersonId>;
};
type RunInput = CardActionInput & { readonly kind: RunPlan["kind"] };

/** One action that runs by itself, drawn as this turn could do it for this card's readers. */
const drawRun = Effect.fn("KinCardActions.drawRun")(function* (
  lead: DrawLead,
  input: RunInput,
  { drawn, teammates }: DrawnTurn,
) {
  const orgId = lead.orgId;
  const ownerTier = Effect.fn("KinCardActions.ownerTier")(function* (tool: string) {
    if (
      drawn.ceiling !== "owner" ||
      teammates.length > 0 ||
      !(yield* toolAdmitted(lead, tool, input))
    )
      return yield* notAllowed(SHARED_REFUSAL);
  });
  const plan: RunPlan = yield* Effect.gen(function* () {
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
        const state = input.kind === "done" ? "done" : "dropped";
        // A task, or an entry of one of the company's own lists, as record_update closes it.
        if (row.registerId !== "work") {
          const def = yield* listDef(orgId, row.registerId);
          if (
            def === undefined ||
            def.builtIn !== null ||
            listSectionRefused({ ...def, payments: def.payments === true ? 1 : null })
          )
            return yield* refuse(
              `${row.key} is not a task or an entry of the company's own lists.`,
            );
          if (!def.states.includes(state))
            return yield* refuse(`${def.name} has no ${state} state for ${row.key}.`);
        }
        if (row.state === "done" || row.state === "dropped")
          return yield* refuse(`${row.key} is ${row.state} already.`);
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
        // The tap checks this again; a card never offers a start Kin can't make now.
        if (yield* (yield* KinDeferralStopSwitch).isStopped(orgId))
          return yield* refuse("Kin's deferred work is stopped, so a card can't start it now.");
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
        const proposal = yield* proposalToCreate(orgId, row.json);
        if (typeof proposal === "string")
          return yield* refuse(`Not offered: ${proposal}. A card only creates a new list.`);
        return {
          kind: "create_list",
          proposalId: input.target,
          definition: row.json,
          name: proposal.name,
          draw: drawn,
        } as const;
      }
      case "record_payment": {
        yield* ownerTier("payment_record");
        return yield* drawPayment(orgId, input.target, drawn);
      }
      case "mark_repaid": {
        yield* ownerTier("record_update");
        return yield* drawRepaid(orgId, input.target, drawn);
      }
    }
  });
  return plan;
});

/** "Take the default" of an open question of this agent's, with that default's own action. */
const drawDefault = Effect.fn("KinCardActions.drawDefault")(function* (
  lead: DrawLead,
  target: string,
  turn: DrawnTurn,
) {
  const orgId = lead.orgId;
  const row = yield* readQuestion(orgId, target);
  if (row === undefined || row.agentId !== lead.agentId || row.state !== "open")
    return yield* notFound(`open question ${target.slice(0, 40)} of yours`);
  const option = row.options.find((one) => one.label === row.defaultLabel);
  if (option === undefined || row.defaultLabel === null)
    return yield* refuse("That question has no default to take.");
  if (turn.teammates.some((person) => person !== row.personId))
    return yield* notAllowed(SHARED_REFUSAL);
  const source = yield* defaultSource(orgId, row, option.optionId);
  if (source === undefined)
    return yield* refuse("That question's card is gone or answered, so there's no default.");
  const sealed = source.final;
  if (
    sealed?.kind === "let_talk" ||
    sealed?.kind === "recommend" ||
    sealed?.kind === "leaver" ||
    (sealed !== undefined && isFactCard(sealed))
  )
    return yield* refuse("That question has no default to take.");
  if (sealed?.kind === "take_default")
    return yield* refuse(
      `That question's default only takes another question's default. Offer what it runs directly${
        sealed.final === null ? "" : `: ${sealed.final.kind} ${actionOf(sealed.final).target}`
      }.`,
    );
  // Its action is drawn again for this turn and this card's readers; it may not differ.
  const final = sealed ?? null;
  if (final !== null && !sameAction(final, yield* drawRun(lead, actionOf(final), turn)))
    return yield* refuse(`${lineOf(final)}: that changed since it was offered.`);
  return {
    kind: "take_default",
    questionId: row.questionId,
    question: row.question,
    widgetId: source.widgetId,
    optionId: option.optionId,
    label: row.defaultLabel,
    final,
    draw: turn.drawn,
  } as const;
});

/**
 * Resolves an option's action in the agent's turn, as that turn could do it: refused here when
 * it couldn't. The plan names exactly what a tap runs; `label` and `line` are what the card shows.
 */
export const draw = Effect.fn("KinCardActions.draw")(function* (
  lead: DrawTurn,
  chatId: KinChatId,
  input: CardActionInput,
) {
  const turn = { drawn: yield* drawOf(lead), teammates: yield* teammatesIn(lead.orgId, chatId) };
  const plan: CardPlan =
    input.kind === "take_default"
      ? yield* drawDefault(lead, input.target, turn)
      : yield* drawRun(lead, { kind: input.kind, target: input.target }, turn);
  return { plan, label: labelOf(plan), line: lineOf(plan) };
});

/** The action a sealed plan runs, as an agent names it. */
const actionOf = (plan: RunPlan): RunInput => ({
  kind: plan.kind,
  target:
    plan.kind === "start"
      ? plan.itemId
      : plan.kind === "create_list"
        ? plan.proposalId
        : plan.kind === "record_payment"
          ? `${plan.bankKey} ${plan.key}`
          : plan.key,
});
/** The same action on the same thing at the same revision, whoever drew it. */
const sameAction = (a: CardPlan, b: CardPlan) =>
  JSON.stringify({ ...a, draw: null }) === JSON.stringify({ ...b, draw: null });

/**
 * A question's card while it still offers its person the default option, by its sealed id, and
 * that option's own plan from the card it was asked on. Undefined once either card is gone.
 */
const defaultSource = Effect.fn("KinCardActions.defaultSource")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  optionId: string,
) {
  const asked = row.widgetId;
  const shown = row.raiseWidgetId ?? row.widgetId;
  if (asked === null || shown === null || row.defaultLabel === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const cards = yield* sql<{
    widgetId: string;
    state: string;
    awaiting: string;
    closedAt: string | null;
  }>`SELECT widget_id AS "widgetId", state_json AS state, awaiting_json AS awaiting,
      closed_at AS "closedAt"
    FROM kin_widgets WHERE org_id = ${orgId} AND chat_id = ${row.chatId}
      AND type = 'choice' AND widget_id IN ${sql.in([...new Set([asked, shown])])}
    ORDER BY widget_id`;
  const live = cards.find((one) => one.widgetId === shown);
  if (live === undefined || live.closedAt !== null || !cards.some((one) => one.widgetId === asked))
    return undefined;
  const state = Option.getOrUndefined(decodeChoice(live.state));
  const awaiting = Option.getOrElse(decodeAwaiting(live.awaiting), (): ReadonlyArray<string> => []);
  if (
    state === undefined ||
    state.answer !== null ||
    !awaiting.includes(row.personId) ||
    !state.options.some((one) => one.optionId === optionId && one.label === row.defaultLabel)
  )
    return undefined;
  const final = (yield* plansOf(orgId, shown)).get(optionId);
  return {
    widgetId: shown,
    final: final === undefined || isTaken(final) || isAnswered(final) ? undefined : final,
  };
});

/**
 * A raised question's action option, drawn again as a new card's would be: for the people its
 * card was drawn for, the chat's readers now and the record as it is now. Undefined when that
 * draw no longer holds, so the raised card leaves the option off.
 */
const revOf = (plan: CardPlan) => {
  const record = plan.kind === "take_default" ? plan.final : plan;
  return record !== null && "rev" in record ? record.rev : undefined;
};

export const redraw = Effect.fn("KinCardActions.redraw")(function* (
  orgId: KinOrgId,
  chatId: KinChatId,
  sealed: CardPlan,
) {
  if (
    sealed.kind === "let_talk" ||
    sealed.kind === "recommend" ||
    sealed.kind === "leaver" ||
    isFactCard(sealed) ||
    isTaken(sealed) ||
    isAnswered(sealed)
  )
    return undefined;
  const lead = {
    orgId,
    agentId: KinAgentId.make(sealed.draw.agentId),
    wakeupId: sealed.draw.wakeupId,
  };
  const turn = { drawn: sealed.draw, teammates: yield* teammatesIn(orgId, chatId) };
  const plan = yield* Effect.gen(function* () {
    const one: CardPlan =
      sealed.kind === "take_default"
        ? yield* drawDefault(lead, sealed.questionId, turn)
        : yield* drawRun(lead, actionOf(sealed), turn);
    return Option.some(one);
  }).pipe(Effect.catchTags({ KinChatError: () => Effect.succeed(Option.none<CardPlan>()) }));
  if (Option.isNone(plan)) return undefined;
  const one = plan.value;
  if ("recordId" in one && "recordId" in sealed && one.recordId !== sealed.recordId)
    return undefined;
  // The question's own words were written about the record as it was: changed since, it is left off.
  if (revOf(one) !== revOf(sealed)) return undefined;
  return { plan: one, label: labelOf(one), line: lineOf(one) };
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

/** The first of these draws that no longer holds, and why. */
const drawsHold = Effect.fn("KinCardActions.drawsHold")(function* (
  orgId: KinOrgId,
  draws: ReadonlyArray<CardDraw>,
) {
  for (const one of draws) {
    const why = yield* drawHolds(orgId, one);
    if (why !== undefined) return why;
  }
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
 * since the draw, or a drawer who no longer could, closes the card with what was not done. A
 * failure after a write fails the tap, so its transaction leaves nothing behind.
 */
export const run = Effect.fn("KinCardActions.run")(function* (
  tap: ActionTap,
  plan: CardPlan,
  deps: {
    readonly records: KinRecords["Service"];
    readonly chat: Pick<
      KinChatService["Service"],
      "closeReplaced" | "reopenClosed" | "notice" | "setDocCardChangesFirst" | "setDocCardChanged"
    >;
  },
) {
  if (plan.kind === "let_talk") return yield* runRoute(tap, plan);
  if (plan.kind === "recommend") return yield* runRecommend(tap, plan);
  if (plan.kind === "leaver") return yield* runLeaver(tap, plan, deps.chat);
  if (isFactCard(plan)) return yield* runFactCard(tap, plan, deps.records);
  if (isAnswered(plan)) return yield* runAnswered(tap, plan, deps.chat);
  if (isTaken(plan))
    return yield* runTaken(
      {
        orgId: tap.orgId,
        personId: tap.personId,
        chatId: tap.widget.chatId,
        widgetId: tap.widget.widgetId,
      },
      plan,
      deps.records,
    );
  if (plan.kind !== "take_default") return yield* runOne(tap, plan, deps.records, []);
  const row = yield* readQuestion(tap.orgId, plan.questionId);
  if (row !== undefined && row.personId !== tap.personId)
    return yield* notAllowed("Only the person it was asked of can answer this question.");
  if (
    row === undefined ||
    row.state !== "open" ||
    row.agentId !== plan.draw.agentId ||
    row.defaultLabel !== plan.label
  )
    return nothingDone(`${quoted(plan.question)} isn't open as it was`);
  if ((yield* defaultSource(tap.orgId, row, plan.optionId))?.widgetId !== plan.widgetId)
    return nothingDone(`the card that asked ${quoted(plan.question)} is gone or changed`);
  const why = yield* drawHolds(tap.orgId, plan.draw);
  if (why !== undefined) return nothingDone(why);
  // Both draws must still hold: the card that asked, and this one that takes its default.
  const done =
    plan.final === null
      ? undefined
      : yield* runOne(tap, plan.final, deps.records, [plan.draw], [plan.widgetId]);
  if (done?.title === NOTHING_DONE) return done;
  yield* answerCard(
    {
      orgId: tap.orgId,
      widgetId: plan.widgetId,
      personId: tap.personId,
      label: plan.label,
      now: tap.now,
    },
    deps.chat,
  );
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

/** Why closing this task does more than Undo puts back: its next comes, or its hand-back clears. */
const outgrowsUndo = (row: {
  readonly repeat: string | null;
  readonly handedBack: number | null;
}) =>
  repeatOf(row.repeat) !== undefined
    ? ("repeats" as const)
    : row.handedBack !== null
      ? ("handed_back" as const)
      : undefined;

/** Why Kin won't take a done or drop as a question's default at its day, known when it is asked. */
export const untakenAtDay = Effect.fn("KinCardActions.untakenAtDay")(function* (
  orgId: KinOrgId,
  plan: CardPlan,
) {
  if (!takesAsDefault(plan)) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ repeat: string | null; handedBack: number | null }>`SELECT
      repeat_json AS repeat,
      CASE WHEN state IN ('done', 'dropped') THEN NULL ELSE handed_back_at END AS "handedBack"
    FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${plan.recordId}`;
  return row === undefined ? undefined : outgrowsUndo(row);
});

/**
 * A question's sealed done or drop, taken at its day as the asker, marked as its default
 * (`takenFor`), while the task is as offered and its drawer still could. False otherwise, or when
 * closing does more than Undo puts back: a repeating task's next (`KinRecords.spawnNext`), a
 * handed-back one's mark; or when putting it back would be refused.
 */
export const takeAtDay = Effect.fn("KinCardActions.takeAtDay")(function* (
  orgId: KinOrgId,
  plan: CardPlan,
  question: Pick<
    QuestionRow,
    "questionId" | "agentId" | "chatId" | "widgetId" | "raiseWidgetId" | "askedAt"
  >,
  records: KinRecords["Service"],
) {
  if (!takesAsDefault(plan) || plan.draw.agentId !== question.agentId) return false;
  const state = plan.kind === "done" ? "done" : "dropped";
  const row = yield* recordRow(orgId, { recordId: plan.recordId });
  if (row === undefined || row.rev !== plan.rev) return false;
  const sql = yield* SqlClient.SqlClient;
  const [more] = yield* sql<{
    repeat: string | null;
    handedBack: number | null;
    waitingKind: string | null;
    waitingId: string | null;
  }>`SELECT repeat_json AS repeat,
      CASE WHEN state IN ('done', 'dropped') THEN NULL ELSE handed_back_at END AS "handedBack",
      waiting_on_kind AS "waitingKind", waiting_on_id AS "waitingId" FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
  if (more === undefined || outgrowsUndo(more) !== undefined) return false;
  // Undo writes back who it waited on, which `update` checks is still here to wait on.
  if (more.waitingKind !== null && more.waitingId !== null) {
    const waits =
      more.waitingKind === "agent"
        ? { _tag: "agent" as const, agentId: KinAgentId.make(more.waitingId) }
        : { _tag: "person" as const, personId: KinPersonId.make(more.waitingId) };
    const back = yield* records
      .principalExists(orgId, waits, "to wait on")
      .pipe(Effect.as(true), Effect.catchTags({ KinChatError: () => Effect.succeed(false) }));
    if (!back) return false;
  }
  if ((yield* drawHolds(orgId, plan.draw)) !== undefined) return false;
  if (!(yield* teamMay(orgId, plan.draw, row, state))) return false;
  // A person's change since it was asked, or since it was offered, waits for its person.
  return yield* records
    .update(
      orgId,
      {
        actor: { _tag: "agent", agentId: question.agentId },
        via: "lead",
        chatId: question.chatId,
        // Its own cards say what Kin went with, not that the task closed under them.
        answering: [question.widgetId, question.raiseWidgetId].filter((id) => id !== null),
        since: { at: question.askedAt, woke: [] },
      },
      row.key,
      { state },
      plan.rev,
      takenFor(question.questionId),
    )
    .pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason === "conflict" || isHelperRefusal(error),
        () => Effect.succeed(false),
      ),
    );
});

/** A start the queue refused after its run moved: the whole tap rolls back, and says so. */
const notStarted = (title: string) =>
  new KinChatError({
    reason: "conflict",
    message: `${quoted(title)} couldn't start just now, so nothing changed. Try again.`,
  });

const runOne = Effect.fn("KinCardActions.runOne")(function* (
  tap: ActionTap,
  plan: RunPlan,
  records: KinRecords["Service"],
  also: ReadonlyArray<CardDraw>,
  alsoAnswering: ReadonlyArray<string> = [],
) {
  const { orgId, personId } = tap;
  const draws = [plan.draw, ...also];
  const owner = yield* ownerLevel(orgId, personId);
  const refuseOff = Effect.fnUntraced(function* (list: string) {
    const section = sectionOfList(list);
    if (section === null) return;
    const shell = yield* KinShell.get(orgId);
    if (!KinShell.sectionOn(shell, section))
      return yield* refuse(
        `${KinShell.sectionName(shell, section)} is turned off for this company, so nothing changed. Turn it on in Settings › Sections and confirm again.`,
      );
  });
  switch (plan.kind) {
    case "done":
    case "drop": {
      const state = plan.kind === "done" ? "done" : "dropped";
      const row = yield* recordRow(orgId, { recordId: plan.recordId });
      if (row === undefined) return nothingDone(`${plan.key} is gone`);
      if (!owner) yield* teamGuard(orgId, personId, { row, changes: true, input: { state } });
      yield* refuseOff(row.registerId);
      if (row.rev !== plan.rev) return nothingDone(`${plan.key} changed since this was offered`);
      const why = yield* drawsHold(orgId, draws);
      if (why !== undefined) return nothingDone(why);
      for (const one of draws)
        if (!(yield* teamMay(orgId, one, row, state)))
          return nothingDone(`whoever it was offered for can no longer change ${plan.key}`);
      yield* records.update(
        orgId,
        {
          actor: { _tag: "person", personId },
          via: "owner",
          askedBy: personId,
          chatId: tap.widget.chatId,
          answering: [tap.widget.widgetId, ...alsoAnswering],
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
      const why = yield* drawsHold(orgId, draws);
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
      // It returns false only before it writes; a refusal after the run moved fails the tap.
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
          KinEventQueueConflict: () => Effect.fail(notStarted(plan.title)),
          KinEventQueueRetiredAgent: () => Effect.fail(notStarted(plan.title)),
          KinEventQueueUnknownAgent: () => Effect.fail(notStarted(plan.title)),
          KinEventQueueUnknownEvent: () => Effect.fail(notStarted(plan.title)),
        }),
      );
      if (!started) return nothingDone(`${quoted(plan.title)} couldn't start`);
      return { title: "Started", text: `Started ${quoted(plan.title)}.` };
    }
    case "create_list": {
      if (!owner) return yield* notAllowed("Only an owner can create a list.");
      const made = proposedList(plan.definition);
      if (made !== undefined) yield* refuseOff(made);
      const why =
        (yield* drawsHold(orgId, draws)) ??
        (yield* defineProposed({
          orgId,
          agentId: plan.draw.agentId,
          proposalId: plan.proposalId,
          definition: plan.definition,
          now: tap.now,
          by: personId,
        }));
      if (why !== undefined) return nothingDone(why);
      if (made === undefined) return { title: "List created", text: "Created." };
      const { words, ...open } = yield* listPlace(orgId, made);
      return { title: "List created", text: `Created. It's in ${words}.`, open };
    }
    case "record_payment": {
      if (!owner) return yield* notAllowed("Only the owner or a co-owner confirms money received.");
      yield* refuseOff("invoices");
      yield* refuseOff("bank_transactions");
      const why = yield* drawsHold(orgId, draws);
      if (why !== undefined) return nothingDone(why);
      const done = yield* recordPayment(
        orgId,
        plan,
        {
          actor: { _tag: "person", personId },
          via: "owner",
          askedBy: personId,
          chatId: tap.widget.chatId,
          answering: [tap.widget.widgetId, ...alsoAnswering],
        },
        tap.widget.widgetId,
        records,
      );
      return done ?? nothingDone(`${plan.bankKey} or ${plan.key} changed since this was offered`);
    }
    case "mark_repaid": {
      if (!owner)
        return yield* notAllowed(
          "Only the owner or a co-owner marks what a partner is owed as repaid.",
        );
      yield* refuseOff("expenses");
      yield* refuseOff("bank_transactions");
      const why = yield* drawsHold(orgId, draws);
      if (why !== undefined) return nothingDone(why);
      const done = yield* markRepaid(
        orgId,
        plan,
        {
          actor: { _tag: "person", personId },
          via: "owner",
          askedBy: personId,
          chatId: tap.widget.chatId,
          answering: [tap.widget.widgetId, ...alsoAnswering],
        },
        records,
      );
      return (
        done ?? nothingDone(`${plan.key} or an expense it repays changed since this was offered`)
      );
    }
  }
});
