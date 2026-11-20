import { type KinDealTotals, type KinPersonId } from "@t3tools/contracts";
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
import { PIPELINE_MINE_NOBODY, pipelineLine } from "./text.ts";
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
  /** More open deals than the list shows. */
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

/**
 * The pipeline as the turn's people see it (shared policy `"view"`): in a turn others read, only
 * deals every one of them sees, and a member without Clients gets none. Kin counts every figure.
 */
const runPipeline = Effect.fnUntraced(function* (lead: Lead, input: typeof PipelineInput.Type) {
  const team = yield* viewOf(lead);
  if (team !== undefined) yield* Deals.switchedOn(lead.orgId, team.people).pipe(workFailure);
  const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people);
  const totals = yield* Deals.pipelineTotals(lead.orgId, viewer).pipe(workFailure);
  const concerns = yield* Deals.pipelineConcerns(lead.orgId, viewer).pipe(workFailure);
  const who = team === undefined ? [] : yield* namesOf(lead, team.people);
  const base = {
    asOf: iso(yield* Clock.currentTimeMillis),
    view: input.view,
    answer: pipelineLine(
      who,
      totals.open.count,
      totals.stages.filter((stage) => stage.count > 0).length,
      concerns.length,
    ),
  };
  switch (input.view) {
    case "totals":
      return {
        ...base,
        stages: totals.stages.map(({ name, ...rest }) => ({ stage: name, ...shownTotals(rest) })),
        open: shownTotals(totals.open),
        won: shownTotals(totals.won),
        lost: shownTotals(totals.lost),
      };
    case "concerns":
      return { ...base, concerns };
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
      };
    }
  }
});

export const pipelineRead = leadTool("KinSalesTools.pipelineRead", runPipeline);
