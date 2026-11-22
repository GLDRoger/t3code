import type { KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** One person's message or tap a turn carries out, and when they made it. */
export type KinTurnAsk = {
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly at: number;
  /** Asked in an earlier turn whose work this one carries on (`askedIn`), not in this one. */
  readonly carried: boolean;
};

const decodeAskedIn = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
// A chain is a handful of turns; this only bounds a read over stored rows.
const MAX_TURNS = 32;

/**
 * Whose asks a turn carries out, from stored rows only: the people whose messages or taps woke
 * it, and, through each event's `askedIn`, the people behind the turns whose work it carries on
 * (a helper's result, a deferral it set up, another lead's answer). A chain nobody started (a
 * schedule, a webhook, mail) has none. `startedAt` is the turn's own start.
 */
export const turnAsks = Effect.fn("KinPush.turnAsks")(function* (
  orgId: KinOrgId,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [turn] = yield* sql<{ startedAt: number }>`SELECT started_at AS "startedAt"
    FROM kin_wakeups WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
  const asks: Array<KinTurnAsk> = [];
  const seen = new Set([wakeupId]);
  let next = [wakeupId];
  let carried = false;
  while (next.length > 0) {
    const rows = yield* sql<{
      askedIn: string | null;
      personId: KinPersonId | null;
      chatId: KinChatId | null;
      at: string | null;
    }>`SELECT json_extract(e.json, '$.askedIn') AS "askedIn", q.author_person_id AS "personId",
        q.chat_id AS "chatId", q.created_at AS at
      FROM kin_events e
      LEFT JOIN kin_messages q ON q.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
        AND q.message_id = json_extract(e.json, '$.messageId') AND q.author_kind = 'human'
      WHERE e.org_id = ${orgId} AND e.wakeup_id IN ${sql.in(next)}
      ORDER BY e.event_id`;
    const upstream: Array<string> = [];
    for (const row of rows) {
      if (row.personId !== null && row.chatId !== null && row.at !== null)
        asks.push({ personId: row.personId, chatId: row.chatId, at: Date.parse(row.at), carried });
      for (const id of Option.getOrElse(decodeAskedIn(row.askedIn ?? undefined), () => []))
        if (!seen.has(id) && seen.size < MAX_TURNS) {
          seen.add(id);
          upstream.push(id);
        }
    }
    next = upstream;
    carried = true;
  }
  return { startedAt: turn?.startedAt, asks };
});

/**
 * When `personId` last asked what a post in `chatId` answers: in its own turn there, or in a turn
 * whose work it carries on, wherever that was. Undefined when it answers nothing of theirs.
 */
export const lastAsk = (
  asks: ReadonlyArray<KinTurnAsk>,
  personId: KinPersonId,
  chatId: KinChatId,
) => {
  const times = asks
    .filter((ask) => ask.personId === personId && (ask.carried || ask.chatId === chatId))
    .map((ask) => ask.at);
  return times.length === 0 ? undefined : Math.max(...times);
};
