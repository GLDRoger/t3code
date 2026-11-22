import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { parseChanges } from "../work/recordRows.ts";
import { leadNamer, toolNameOfText } from "../work/toolNames.ts";

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

const WHO_FIELDS = new Set(["owner", "waitingOn", "assignedBy"]);

const shown = (value: string | null) =>
  value === null
    ? "empty"
    : JSON.stringify(value.length > VALUE ? `${value.slice(0, VALUE - 1)}…` : value);

/** Changes made in Team-room turns: the wake-ups a discussion woke, by its event keys. */
const inDiscussion = (sql: SqlClient.SqlClient, orgId: KinOrgId, discussionId: string) =>
  sql`c.wakeup_id IN (SELECT e.wakeup_id FROM kin_events e WHERE e.org_id = ${orgId}
    AND e.wakeup_id IS NOT NULL AND e.dedupe_key LIKE 'team:' || ${discussionId} || ':%')`;

/**
 * What changed for this chat lately, each with the values it replaced, newest first: this
 * agent's last few turns here, and what each Team-room discussion told in this chat changed.
 * One list serves every "undo it", whoever made the change.
 */
export const recentChanges = Effect.fn("KinLeadPrompt.recentChanges")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const since = input.now - WINDOW_MS;
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
      AND c.at >= ${since}
      AND (c.chat_id = ${input.chatId} OR c.chat_id IS NULL)
    ORDER BY c.seq DESC LIMIT ${CHANGES}`;
  const discussions = yield* sql<{ discussionId: string; topic: string }>`SELECT DISTINCT
      d.discussion_id AS "discussionId", d.topic FROM kin_discussions d
    JOIN kin_messages m ON m.org_id = d.org_id AND m.discussion_id = d.discussion_id
    WHERE d.org_id = ${input.orgId} AND m.chat_id = ${input.chatId} AND d.ended_at >= ${since}
    ORDER BY d.discussion_id`;
  const turns: Array<string | null> = [];
  for (const row of rows)
    if (!turns.includes(row.wakeupId) && turns.length < TURNS) turns.push(row.wakeupId);
  const own = rows.filter((row) => turns.includes(row.wakeupId));
  const team: Array<{ readonly from: string; readonly row: (typeof rows)[number] }> = [];
  for (const discussion of discussions)
    for (const row of yield* changesIn(input.orgId, discussion.discussionId))
      team.push({ from: `Team room, "${discussion.topic.replaceAll('"', "'")}"`, row });
  const name = yield* leadNamer(input.orgId, input.agentId);
  const named = (field: string, value: string | null) =>
    value !== null && WHO_FIELDS.has(field) ? toolNameOfText(value, name) : value;
  const line = (row: (typeof rows)[number]) => {
    const fields = parseChanges(row.fieldsJson)
      .map(
        (change) =>
          `${change.field} ${shown(named(change.field, change.from))} → ${shown(named(change.field, change.to))}`,
      )
      .join("; ");
    return `${row.key} ${JSON.stringify(row.title)} ${row.kind}${fields === "" ? "" : `: ${fields}`}`;
  };
  const seen = new Set(own.map((row) => `${row.key}:${row.at}:${row.kind}`));
  return [
    ...own.map((row) => ({
      from: `turn ${turns.indexOf(row.wakeupId) + 1}`,
      at: row.at,
      line: line(row),
    })),
    ...team
      .filter((one) => !seen.has(`${one.row.key}:${one.row.at}:${one.row.kind}`))
      .map((one) => ({ from: one.from, at: one.row.at, line: line(one.row) })),
  ].toSorted((a, b) => b.at - a.at);
});

/** What the agents' turns in one discussion changed, newest first. */
export const changesIn = Effect.fn("KinTeam.changesIn")(function* (
  orgId: KinOrgId,
  discussionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    wakeupId: string | null;
    at: number;
    key: string;
    title: string;
    kind: string;
    fieldsJson: string;
  }>`SELECT c.wakeup_id AS "wakeupId", c.at, r.key, r.title, c.kind, c.fields_json AS "fieldsJson"
    FROM kin_record_changes c
    JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.actor_kind = 'agent' AND ${inDiscussion(sql, orgId, discussionId)}
    ORDER BY c.seq DESC LIMIT ${CHANGES}`;
});

export const UNDO_RULE =
  "What changed here lately, newest first, with the values each replaced: your turns (turn 1 is your latest) and what a Team-room discussion told here changed. To undo, put those values back with the same tools (record_update, record_assign, doc_restore to the version before) and say in one line what you put back and what can't be, such as a sent message.";
