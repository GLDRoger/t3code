import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { SILENT_REPLY } from "../reply/classify.ts";
import { iso } from "./recordRows.ts";

/**
 * The Work section of a lead's prompt, built by SQL at turn time. Status has one home: counts of
 * what the lead owns, and only what changed since it last spoke in this chat, by anyone but
 * itself. Its cursor moves once a reply of its posts there, so an unchanged item it already
 * reported is not in view to repeat, and a finished one shows once.
 */

const decodeFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ field: Schema.String, to: Schema.NullOr(Schema.String) })),
  ),
);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const CHANGED_CAP = 15;

export type WorkSection = {
  readonly asOf: string;
  readonly open: number;
  readonly doing: number;
  readonly waiting: number;
  readonly late: number;
  readonly dueThisWeek: number;
  readonly changed: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly state: string;
    readonly due: string | null;
    readonly changes: ReadonlyArray<string>;
  }>;
  readonly moreChanged: number;
};

/** Promotes the pending cursor once the lead's reply posted after it was set. */
const settledCursor = Effect.fn("KinWorkPrompt.cursor")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    seq: number;
    pendingSeq: number | null;
    pendingMsgSeq: number | null;
  }>`
    SELECT seq, pending_seq AS "pendingSeq", pending_msg_seq AS "pendingMsgSeq"
    FROM kin_record_cursors WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}
      AND chat_id = ${input.chatId}`;
  if (row === undefined) return 0;
  if (row.pendingSeq === null || row.pendingMsgSeq === null) return row.seq;
  // A silent or failed turn told nobody anything, so it moves nothing.
  const replied = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${input.orgId}
    AND chat_id = ${input.chatId} AND seq > ${row.pendingMsgSeq} AND author_kind = 'agent'
    AND author_agent_id = ${input.agentId} AND status = 'posted' AND silent = 0 LIMIT 1`;
  if (replied.length === 0) return row.seq;
  const seq = Math.max(row.seq, row.pendingSeq);
  yield* sql`UPDATE kin_record_cursors SET seq = ${seq}, pending_seq = NULL, pending_msg_seq = NULL
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND chat_id = ${input.chatId}`;
  return seq;
});

export const buildWorkSection = Effect.fn("KinWorkPrompt.build")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, chatId, now } = input;
  const since = yield* settledCursor(input);
  const [counts] = yield* sql<{
    open: number;
    doing: number | null;
    waiting: number | null;
    late: number | null;
    dueThisWeek: number | null;
  }>`SELECT COUNT(*) AS open, SUM(state = 'doing') AS doing, SUM(state = 'waiting') AS waiting,
      SUM(due_at IS NOT NULL AND due_at < ${now}) AS late,
      SUM(due_at IS NOT NULL AND due_at >= ${now} AND due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work' AND owner_kind = 'agent'
      AND owner_id = ${agentId} AND state NOT IN ('done', 'dropped')`;
  const changes = yield* sql<{
    seq: number;
    key: string;
    title: string;
    state: string;
    dueAt: number | null;
    dueAllDay: number;
    kind: string;
    actorKind: string;
    fieldsJson: string;
  }>`SELECT c.seq, r.key, r.title, r.state, r.due_at AS "dueAt", r.due_all_day AS "dueAllDay",
      c.kind, c.actor_kind AS "actorKind", c.fields_json AS "fieldsJson"
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.seq > ${since} AND r.register_id = 'work'
      AND r.owner_kind = 'agent' AND r.owner_id = ${agentId}
      AND NOT (c.actor_kind = 'agent' AND c.actor_id IS ${agentId})
    ORDER BY c.seq`;
  const [latest] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId}`;
  const [chat] = yield* sql<{ lastSeq: number }>`SELECT last_seq AS "lastSeq" FROM kin_chats
    WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
  if (chat !== undefined)
    yield* sql`INSERT INTO kin_record_cursors (org_id, agent_id, chat_id, seq, pending_seq,
        pending_msg_seq)
      VALUES (${orgId}, ${agentId}, ${chatId}, ${since}, ${latest?.seq ?? 0}, ${chat.lastSeq})
      ON CONFLICT (org_id, agent_id, chat_id) DO UPDATE SET pending_seq = excluded.pending_seq,
        pending_msg_seq = excluded.pending_msg_seq`;
  const byKey = new Map<string, { row: (typeof changes)[number]; lines: Array<string> }>();
  for (const change of changes) {
    const entry = byKey.get(change.key) ?? { row: change, lines: [] };
    entry.row = change;
    const who =
      change.actorKind === "system"
        ? "Kin"
        : change.actorKind === "person"
          ? "a person"
          : "another lead";
    const fields = Option.getOrElse(decodeFields(change.fieldsJson), () => []);
    entry.lines.push(
      change.kind === "created"
        ? `created by ${who}`
        : `${fields
            .map((field) =>
              field.field === "owner" && field.to === `agent:${agentId}`
                ? "given to you"
                : `${field.field} → ${field.to ?? "cleared"}`,
            )
            .join(", ")} (${who})`,
    );
    byKey.set(change.key, entry);
  }
  const all = [...byKey.values()];
  return {
    asOf: iso(now),
    open: counts?.open ?? 0,
    doing: counts?.doing ?? 0,
    waiting: counts?.waiting ?? 0,
    late: counts?.late ?? 0,
    dueThisWeek: counts?.dueThisWeek ?? 0,
    changed: all.slice(-CHANGED_CAP).map(({ row, lines }) => ({
      key: row.key,
      title: row.title,
      state: row.state,
      due:
        row.dueAt === null
          ? null
          : row.dueAllDay === 1
            ? iso(row.dueAt).slice(0, 10)
            : iso(row.dueAt),
      changes: lines.slice(-4),
    })),
    moreChanged: Math.max(0, all.length - CHANGED_CAP),
  } satisfies WorkSection;
});

export const WORK_RULE =
  "Where work stands comes only from this section and the records tools, never from memory or earlier messages. `changed` lists only what others changed since you last spoke in this chat. Anything not in it you have already reported or nothing happened to it: don't bring it up again unless asked.";

/** The event line for an open entry the owner closed or took back while this lead held it. */
export const WITHDRAWN_WORK = `The owner closed this Work entry or took it back from you, and Kin has already stopped any worker of yours that was running on it, so there is nothing to stop or restart. Leave the entry as it is. Reply only if the owner needs to know something about it, in one line; otherwise write exactly ${SILENT_REPLY}.`;
