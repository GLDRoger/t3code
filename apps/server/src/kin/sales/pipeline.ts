import {
  type KinDealNumbers,
  type KinDealTotals,
  type KinPersonId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnAsker } from "../lead/Audience.ts";
import * as Deals from "../work/deals.ts";
import { leadTool, type Lead, viewOf } from "../work/leadWork.ts";
import { dayIn, formatMoney, timeIn } from "../work/money.ts";
import { iso, ownerZone, workFailure } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { concernsLine, mineLine, PIPELINE_MINE_NOBODY, totalsLine } from "./text.ts";
import { KinChatError } from "@t3tools/contracts";

export const PipelineInput = Schema.Struct({
  view: Schema.Literals(["totals", "mine", "concerns"]),
});
const Totals = Schema.Struct({ count: Schema.Number, values: Schema.Array(Schema.String) });
export const PipelineResult = Schema.Struct({
  asOf: Schema.String,
  view: PipelineInput.fields.view,
  stages: Schema.optional(Schema.Array(Schema.Struct({ stage: Schema.String, ...Totals.fields }))),
  open: Schema.optional(Totals),
  won: Schema.optional(Totals),
  lost: Schema.optional(Totals),
  /** The Deals tab's figures, as far as every reader of the turn may see them. */
  numbers: Schema.optional(
    Schema.Struct({
      month: Schema.String,
      lastMonth: Schema.String,
      weekStart: Schema.String,
      wonThisMonth: Totals,
      wonLastMonth: Schema.optional(Totals),
      lostThisMonth: Schema.optional(Totals),
      lostLastMonth: Schema.optional(Totals),
      winRate90Days: Schema.optional(Schema.Struct({ won: Schema.Number, decided: Schema.Number })),
      newProspectsBySource: Schema.optional(
        Schema.Array(Schema.Struct({ source: Schema.String, count: Schema.Number })),
      ),
      followUpsLate: Schema.optional(Schema.Number),
      thisWeek: Schema.optional(
        Schema.Struct({
          won: Schema.Number,
          lost: Schema.Number,
          new: Schema.Number,
          moved: Schema.Number,
        }),
      ),
      byPerson: Schema.Array(
        Schema.Struct({
          person: Schema.String,
          open: Totals,
          wonThisMonth: Totals,
          followUpsLate: Schema.Number,
        }),
      ),
    }),
  ),
  deals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        client: Schema.String,
        stage: Schema.String,
        value: Schema.optional(Schema.String),
        expected: Schema.optional(Schema.String),
        next: Schema.NullOr(
          Schema.Struct({
            key: Schema.String,
            title: Schema.String,
            due: Schema.optional(Schema.String),
            late: Schema.optional(Schema.Literal(true)),
          }),
        ),
        concerns: Schema.optional(Schema.Array(Schema.String)),
        sensitive: Schema.optional(Schema.Literal(true)),
      }),
    ),
  ),
  /** More open deals, or concerns, than the list shows. */
  more: Schema.optional(Schema.Literal(true)),
  concerns: Schema.optional(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        deals: Schema.Number,
        open: Schema.Number,
        won: Schema.Number,
        lost: Schema.Number,
      }),
    ),
  ),
  answer: Schema.String,
});

const shownTotals = (totals: KinDealTotals) => ({
  count: totals.count,
  values: totals.values.map(formatMoney),
});
const dayOrTime = (at: string, allDay: boolean, zone: string) =>
  allDay ? dayIn(Date.parse(at), zone) : timeIn(Date.parse(at), zone);

/** The people the turn reads for, by name, in the order `viewOf` gives them. */
const namesOf = Effect.fnUntraced(function* (lead: Lead, people: ReadonlyArray<KinPersonId>) {
  if (people.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; name: string }>`SELECT person_id AS id,
      display_name AS name FROM kin_people
    WHERE org_id = ${lead.orgId} AND person_id IN ${sql.in([...people])} ORDER BY person_id`;
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return people.map((person) => names.get(person) ?? "a teammate");
});

/** Whoever looks after deals, by name. */
const principalNames = Effect.fnUntraced(function* (lead: Lead) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ kind: string; id: string; name: string }>`SELECT 'person' AS kind,
      person_id AS id, display_name AS name FROM kin_people WHERE org_id = ${lead.orgId}
    UNION ALL SELECT 'agent' AS kind, agent_id AS id, display_name AS name FROM kin_agents
      WHERE org_id = ${lead.orgId}
    ORDER BY kind, id`;
  return (owner: KinWorkPrincipal) =>
    rows.find(
      (row) =>
        row.kind === owner._tag &&
        row.id === (owner._tag === "person" ? owner.personId : owner.agentId),
    )?.name ?? "someone";
});

const shownNumbers = (numbers: KinDealNumbers, nameOf: (owner: KinWorkPrincipal) => string) => ({
  month: numbers.month,
  lastMonth: numbers.lastMonth,
  weekStart: numbers.weekStart,
  wonThisMonth: shownTotals(numbers.wonThisMonth),
  ...(numbers.wonLastMonth === undefined
    ? {}
    : { wonLastMonth: shownTotals(numbers.wonLastMonth) }),
  ...(numbers.lostThisMonth === undefined
    ? {}
    : { lostThisMonth: shownTotals(numbers.lostThisMonth) }),
  ...(numbers.lostLastMonth === undefined
    ? {}
    : { lostLastMonth: shownTotals(numbers.lostLastMonth) }),
  ...(numbers.winRate === undefined ? {} : { winRate90Days: numbers.winRate }),
  ...(numbers.sources === undefined
    ? {}
    : {
        newProspectsBySource: numbers.sources.map((one) => ({
          source: one.source ?? "not said",
          count: one.count,
        })),
      }),
  ...(numbers.late === undefined ? {} : { followUpsLate: numbers.late }),
  ...(numbers.week === undefined ? {} : { thisWeek: numbers.week.counts }),
  byPerson: numbers.people.map((one) => ({
    person: nameOf(one.owner),
    open: shownTotals(one.open),
    wonThisMonth: shownTotals(one.wonThisMonth),
    followUpsLate: one.late,
  })),
});

/**
 * The pipeline as the turn's people see it (shared policy `"view"`): in a turn others read, only
 * deals every one of them sees, and a member without Clients gets none. Kin counts every figure.
 */
const runPipeline = Effect.fnUntraced(function* (lead: Lead, input: typeof PipelineInput.Type) {
  const team = yield* viewOf(lead);
  if (team !== undefined) yield* Deals.switchedOn(lead.orgId, team.people).pipe(workFailure);
  const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people);
  const who = team === undefined ? [] : yield* namesOf(lead, team.people);
  const base = { asOf: iso(yield* Clock.currentTimeMillis), view: input.view };
  // Each view counts only its own figures, and its line says only those.
  switch (input.view) {
    case "totals": {
      const totals = yield* Deals.pipelineTotals(lead.orgId, viewer).pipe(workFailure);
      const numbers = yield* Deals.summary(lead.orgId, viewer).pipe(workFailure);
      return {
        ...base,
        ...(numbers === undefined
          ? {}
          : { numbers: shownNumbers(numbers, yield* principalNames(lead)) }),
        stages: totals.stages.map(({ name, ...rest }) => ({ stage: name, ...shownTotals(rest) })),
        open: shownTotals(totals.open),
        won: shownTotals(totals.won),
        lost: shownTotals(totals.lost),
        answer: totalsLine(who, {
          open: totals.open.count,
          stages: totals.stages.filter((stage) => stage.count > 0).length,
          won: totals.won.count,
          lost: totals.lost.count,
        }),
      };
    }
    case "concerns": {
      const heard = yield* Deals.pipelineConcerns(lead.orgId, viewer).pipe(workFailure);
      return {
        ...base,
        concerns: heard.concerns,
        ...(heard.more ? { more: true as const } : {}),
        answer: concernsLine(who, heard.concerns.length, heard.more),
      };
    }
    case "mine": {
      const person =
        team === undefined
          ? ((yield* turnAsker(lead)) ?? (yield* KinIdentity).owner.personId)
          : team.askers.length === 1
            ? team.askers[0]
            : team.people.length === 1
              ? team.people[0]
              : undefined;
      if (person === undefined)
        return yield* new KinChatError({ reason: "invalid_state", message: PIPELINE_MINE_NOBODY });
      const zone = yield* ownerZone(lead.orgId);
      const mine = yield* Deals.pipelineMine(lead.orgId, viewer, person as KinPersonId).pipe(
        workFailure,
      );
      return {
        ...base,
        deals: mine.deals.map((deal) => ({
          key: deal.key,
          title: deal.title,
          client: `${deal.party.title} (${deal.party.key})`,
          stage: deal.stageName,
          ...(deal.value === undefined ? {} : { value: formatMoney(deal.value) }),
          ...(deal.expectedAt === null
            ? {}
            : { expected: dayOrTime(deal.expectedAt, deal.expectedAllDay, zone) }),
          next:
            deal.next === null
              ? null
              : {
                  key: deal.next.key,
                  title: deal.next.title,
                  ...(deal.next.dueAt === null
                    ? {}
                    : { due: dayOrTime(deal.next.dueAt, deal.next.dueAllDay, zone) }),
                  ...(deal.next.late ? { late: true as const } : {}),
                },
          ...(deal.concerns === undefined
            ? {}
            : { concerns: deal.concerns.map((concern) => concern.label) }),
          ...(deal.sensitive ? { sensitive: true as const } : {}),
        })),
        ...(mine.more ? { more: true as const } : {}),
        answer: mineLine(
          who,
          (yield* namesOf(lead, [person as KinPersonId]))[0] ?? "a teammate",
          mine.deals.length,
          mine.more,
        ),
      };
    }
  }
});

export const pipelineRead = leadTool("KinSalesTools.pipelineRead", runPipeline);
