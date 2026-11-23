import { KinAgentId, KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { goalFields } from "../work/goals.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { ownerWriter } from "../work/ownerWork.ts";
import { decodeNumbersChange, NUMBERS_CHANGE } from "./numberRows.ts";
import { baseOf } from "./watch.ts";

/**
 * The answer on a numbers card: an owner-level Confirm makes or changes exactly the numbers it
 * lists, kept by the agent that asked, once, while nothing it names has changed. Its feed's one
 * schedule is made by the scheduled-tasks pass (`makeFeeds`). Undefined for any other card.
 */
export const answerNumbersChange = Effect.fn("KinNumbersWatch.answer")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: KinPersonId;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ changeId: string; agentId: string; patch: string; done: number }>`
    SELECT change_id AS "changeId", agent_id AS "agentId", patch_json AS patch,
      (applied_at IS NOT NULL OR declined_at IS NOT NULL) AS done
    FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND substr(change_id, 1, 3) = ${NUMBERS_CHANGE}`;
  if (row === undefined) return undefined;
  if (!(yield* ownerLevel(input.orgId, input.personId).pipe(Effect.orDie)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner decides which numbers Kin watches.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Confirm or Cancel on the card to answer this.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This card was already answered or replaced by a newer one.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return { title: "Not watched", text: "You said no, so nothing is watched." };
  }
  const change = yield* decodeNumbersChange(row.patch).pipe(Effect.orDie);
  const { matched, base } = yield* baseOf(
    input.orgId,
    change.numbers.map((number) => number.name),
    change.feed?.source,
    input.now,
  );
  if (
    base !== change.base ||
    change.numbers.some((number, index) => number.key !== matched[index]?.key)
  )
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "A number or feed on this card changed since it was made, so nothing was changed. Ask for it again.",
    });
  const records = yield* KinRecords;
  const writer = ownerWriter({ _tag: "person", orgId: input.orgId, personId: input.personId });
  const owner = { _tag: "agent" as const, agentId: KinAgentId.make(row.agentId) };
  for (const [index, number] of change.numbers.entries()) {
    const fed = number.compute === undefined && change.feed !== undefined;
    const fields = yield* goalFields(input.orgId, {
      ...(number.key === undefined ? { measure: "manual" } : {}),
      ...(number.unit === undefined ? {} : { unit: number.unit }),
      ...(number.direction === undefined ? {} : { direction: number.direction }),
      ...(number.above === undefined ? {} : { above: number.above }),
      ...(number.below === undefined ? {} : { below: number.below }),
      ...(number.compute === undefined ? {} : { spec: number.compute }),
      ...(fed ? { source: change.feed!.source, every: change.feed!.every } : {}),
    });
    if (number.key === undefined)
      yield* records.create(input.orgId, writer, {
        list: "goals",
        originKey: `numbers:${row.changeId}:${index}`,
        title: number.name,
        owner,
        fields,
      });
    else
      yield* records.update(input.orgId, writer, number.key, {
        fields,
        ...(fed ? { owner } : {}),
      });
  }
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now},
      patch_json = json_set(patch_json, '$.by', ${input.personId})
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  return {
    title: "Watching",
    text:
      change.feed === undefined
        ? "Saved. To stop watching a number, archive it."
        : "Saved. To stop watching a number, archive it; to stop its feed, pause or delete the schedule's card in this chat.",
  };
});
