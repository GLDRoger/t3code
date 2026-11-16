import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { parseChanges } from "../work/recordRows.ts";

/** "Undo it", "put it back", "revert that": the owner taking back something an agent did. */
const UNDO =
  /\b(undo|revert|roll ?back|reverse (it|that|this)|put (it|that|them|those) back|take (it|that|them) back)\b/i;

/** Read on the turn's quoted events, which carry the messages' own words. */
export const asksUndo = (quotedEvents: ReadonlyArray<string>) =>
  quotedEvents.some((text) => UNDO.test(text));

const WINDOW_MS = 48 * 60 * 60 * 1000;
const TURNS = 3;
const CHANGES = 24;
const VALUE = 60;

const shown = (value: string | null) =>
  value === null
    ? "empty"
    : JSON.stringify(value.length > VALUE ? `${value.slice(0, VALUE - 1)}…` : value);

/**
 * What this agent changed in this chat in its last few turns, newest turn first, each with the
 * values it replaced: the acting line's turn is the link, so "undo it" can put them back.
 */
export const recentChanges = Effect.fn("KinLeadPrompt.recentChanges")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    wakeupId: string | null;
    at: number;
    key: string;
    title: string;
    kind: string;
    fieldsJson: string;
  }>`SELECT c.wakeup_id AS "wakeupId", c.at, r.key, r.title, c.kind, c.fields_json AS "fieldsJson"
    FROM kin_record_changes c
    JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${input.orgId} AND c.actor_kind = 'agent' AND c.actor_id = ${input.agentId}
      AND c.at >= ${input.now - WINDOW_MS}
      AND (c.chat_id = ${input.chatId} OR c.chat_id IS NULL)
    ORDER BY c.seq DESC LIMIT ${CHANGES}`;
  const turns: Array<string | null> = [];
  for (const row of rows)
    if (!turns.includes(row.wakeupId) && turns.length < TURNS) turns.push(row.wakeupId);
  return rows
    .filter((row) => turns.includes(row.wakeupId))
    .map((row) => {
      const fields = parseChanges(row.fieldsJson)
        .map((change) => `${change.field} ${shown(change.from)} → ${shown(change.to)}`)
        .join("; ");
      return {
        turn: turns.indexOf(row.wakeupId) + 1,
        at: row.at,
        line: `${row.key} ${JSON.stringify(row.title)} ${row.kind}${fields === "" ? "" : `: ${fields}`}`,
      };
    });
});

export const UNDO_RULE =
  "What you changed in this chat lately, newest turn first, with the values each change replaced (turn 1 is your latest acting line). To undo, put those values back with the same tools (record_update, doc_restore to the version before) and say in one line what you put back and what can't be (a message already sent stays sent).";
