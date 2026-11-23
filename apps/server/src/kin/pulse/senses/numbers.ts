import { KinAgentId, KinRecordId, type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelNumbers } from "../../numbers/KinNumbers.ts";
import { sectionOnFor } from "../../shell/KinShell.ts";
import { liveFeeds } from "../../numbers/numberRows.ts";
import { figure, offTurnText } from "../../numbers/words.ts";
import { agentOrOwner, dayOf, iso, type SenseContext, type SensedFact } from "./shared.ts";

const plain = (decimal: string, unit: string | undefined) =>
  unit === undefined || unit === "%"
    ? figure(decimal, unit)
    : `${figure(decimal, undefined)} ${unit}`;

/** The key `number_off` gives a number outside a limit: one fact per time it goes outside. */
const numberOffPrefix = (key: string, side: "above" | "below", limit: string) =>
  `number_off:${key}:${side}=${limit}:since=`;

/**
 * number_off: a number's latest value outside a limit; it wakes the agent that keeps it.
 * number_stale: a fed number with no value for two of its periods; the owner hears it once.
 */
export const numberSenses = Effect.fn("KinPulse.numberSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const numbers = yield* ownerLevelNumbers(ctx.orgId, ctx.at);
  // "No new value" only while someone is meant to fetch it: its source's feed runs.
  const fetched = new Set(
    numbers.some((number) => number.stale)
      ? (yield* liveFeeds(ctx.orgId)).map((one) => one.feed.source)
      : [],
  );
  const today = dayOf(ctx, ctx.at);
  const facts: Array<SensedFact> = [];
  for (const number of numbers) {
    const subject = {
      kind: "record" as const,
      key: number.key,
      title: number.name,
      recordId: KinRecordId.make(number.recordId),
    };
    const section = number.section === null ? {} : { section: number.section };
    const off = number.off;
    if (off !== undefined) {
      const prefix = numberOffPrefix(number.key, off.side, off.limit);
      // The episode it is in: the one still open, else from the day its value was first off.
      const [open] = yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
        WHERE org_id = ${ctx.orgId} AND cleared_at IS NULL
          AND substr(fact_key, 1, ${prefix.length}) = ${prefix}
        ORDER BY first_seen_at, fact_key LIMIT 1`;
      // A new episode is told apart from an earlier one on the same day: by the value that
      // started it, or for a computed number by how many episodes came before.
      const [{ earlier }] = (
        open === undefined && number.seq === undefined
          ? yield* sql<{ earlier: number }>`SELECT COUNT(*) AS earlier FROM kin_pulse_facts
            WHERE org_id = ${ctx.orgId} AND substr(fact_key, 1, ${prefix.length}) = ${prefix}`
          : [{ earlier: 0 }]
      ) as [{ earlier: number }];
      const since =
        open?.key.slice(prefix.length) ??
        (number.seq === undefined
          ? `${today}#g${earlier}`
          : `${number.asOf ?? today}#${number.seq}`);
      facts.push({
        sense: "number_off",
        family: "goals",
        key: `${prefix}${since}`,
        subject,
        scope: {},
        since: iso(DateTime.toEpochMillis(DateTime.makeUnsafe(since.split("#")[0]!))),
        consequence: `${plain(off.value, number.unit)} as of ${number.asOf ?? today}, ${off.side} its limit of ${plain(off.limit, number.unit)}.`,
        actor:
          number.keeper !== undefined && ctx.liveAgents.has(number.keeper)
            ? { _tag: "agent", agentId: KinAgentId.make(number.keeper) }
            : agentOrOwner(ctx.chief),
        sensitive: true,
        wake: "now",
        ...section,
      });
    }
    if (
      number.stale &&
      number.every !== undefined &&
      number.definedSource !== undefined &&
      fetched.has(number.definedSource)
    ) {
      const source = number.definedSource ?? number.source;
      facts.push({
        sense: "number_stale",
        family: "goals",
        key: `number_stale:${number.key}:asOf=${number.asOf ?? "none"}`,
        subject,
        scope: {},
        since: iso(ctx.at),
        consequence: `${number.asOf === null ? "No value yet" : `No new value since ${number.asOf}`}${source === undefined ? "." : `; it comes from ${source}.`}`,
        actor: { _tag: "owner" },
        sensitive: true,
        wake: "sweep",
        ...section,
      });
    }
  }
  return facts;
});

/** Of `factKeys`, those still standing at `now`: sensed at the last tick and not handled. */
const standingFacts = Effect.fn("KinPulse.standingFacts")(function* (
  orgId: KinOrgId,
  factKeys: ReadonlyArray<string>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
    WHERE org_id = ${orgId} AND fact_key IN ${sql.in(factKeys)} AND cleared_at IS NULL
      AND (handled_at IS NULL OR (handled_until IS NOT NULL AND handled_until <= ${now}))
    ORDER BY fact_key`;
  return open.map((row) => row.key);
});

/**
 * What the keeper woken by `number_off` facts is told, checked as its turn starts: only for an
 * episode still open, not handled, with its number still outside that limit and its section on.
 */
export const offTurnTexts = Effect.fn("KinPulse.numberOffTexts")(function* (
  orgId: KinOrgId,
  factKeys: ReadonlyArray<string>,
  now: number,
) {
  const asked = factKeys.filter((key) => key.startsWith("number_off:"));
  if (asked.length === 0) return [];
  const wanted = yield* standingFacts(orgId, asked, now);
  if (wanted.length === 0) return [];
  const numbers = yield* ownerLevelNumbers(orgId, now);
  const shown = [];
  for (const number of numbers)
    if (number.section === null || (yield* sectionOnFor(orgId, number.section))) shown.push(number);
  return shown.flatMap((number) => {
    const off = number.off;
    if (off === undefined || number.asOf === null) return [];
    const prefix = numberOffPrefix(number.key, off.side, off.limit);
    return wanted.some((key) => key.startsWith(prefix))
      ? [
          offTurnText({
            key: number.key,
            name: number.name,
            unit: number.unit,
            value: off.value,
            asOf: number.asOf,
            side: off.side,
            limit: off.limit,
          }),
        ]
      : [];
  });
});
