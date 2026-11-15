import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { resolveConnection } from "../connections/ConnectionRows.ts";

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};
type Condition = (
  turn: Turn,
  args: unknown,
) => Effect.Effect<boolean, SqlError, SqlClient.SqlClient>;

/**
 * What a tool may do once its turn has read outside text (a connection's result, or an event an
 * outside-read turn made). Built like `SHARED_TOOLS`: the gate refuses any tool without a line.
 * Conditions read stored rows; arguments only name the subject.
 */
export type OutsideToolPolicy = "allowed" | "refused" | Condition;

/** The one line a tool refused after outside text answers with. */
export const OUTSIDE_REFUSAL =
  "This turn read text from a connected service, so it can't do this now. Offer it to the owner with kin_ask instead; their tap starts it in a fresh turn.";

const field = (args: unknown, name: string) =>
  Predicate.hasProperty(args, name) ? args[name] : undefined;

/** Only a closed connection's tool that doesn't say it reaches the open world. */
const closedRead: Condition = Effect.fnUntraced(function* (turn, args) {
  const connection = field(args, "connection");
  const tool = field(args, "tool");
  if (typeof connection !== "string" || typeof tool !== "string") return false;
  const found = yield* resolveConnection(turn.orgId, connection);
  if (found._tag !== "found" || found.row.reach !== "closed") return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ openWorld: number }>`SELECT open_world AS "openWorld"
    FROM kin_connection_tools WHERE org_id = ${turn.orgId}
      AND connection_id = ${found.row.connectionId} AND tool_name = ${tool} AND removed_at IS NULL
    ORDER BY tool_name`;
  return rows.length === 1 && rows[0]!.openWorld === 0;
});

/** A recipe's file is made by Kin in the call; without one, or to write a recipe, a worker is. */
const recipeOnly: Condition = (_turn, args) =>
  Effect.succeed(
    typeof field(args, "recipe") === "string" && field(args, "writeRecipe") === undefined,
  );

export const OUTSIDE_TOOLS = {
  kin_chat_post: "allowed",
  kin_widget_upsert: "allowed",
  kin_ask: "allowed",
  kin_react: "allowed",
  kin_chart: "allowed",
  kin_visual: "allowed",
  kin_chat_read: "allowed",
  kin_leads: "allowed",
  kin_end: "allowed",
  // Workers have a shell and the network: outside text could steer either.
  kin_delegate: "refused",
  kin_follow_up: "refused",
  kin_worker_stop: "allowed",
  // The turn each starts reads as outside too (`carryOutside`).
  kin_hand_off: "allowed",
  kin_defer: "allowed",
  kin_schedule: "allowed",
  kin_cancel: "allowed",
  memory_search: "allowed",
  memory_read: "allowed",
  // What it writes is the owner's alone: the outside read marks the turn sensitive.
  memory_write: "allowed",
  kin_journal: "allowed",
  memory_label: "allowed",
  kin_github_repos: "allowed",
  kin_github_prs: "allowed",
  kin_github_pr: "allowed",
  kin_github_runs: "allowed",
  // The owner reads and signs the exact payload.
  request_action: "allowed",
  records_query: "allowed",
  record_get: "allowed",
  record_create: "allowed",
  record_update: "allowed",
  doc_create: "allowed",
  doc_read: "allowed",
  doc_edit: "allowed",
  doc_rewrite: "allowed",
  doc_move: "allowed",
  doc_link: "allowed",
  docs_search: "allowed",
  doc_history: "allowed",
  doc_restore: "allowed",
  list_define: "allowed",
  payment_record: "allowed",
  money_summary: "allowed",
  dates_query: "allowed",
  company_profile: "allowed",
  statement_read: "allowed",
  statement_rows: "allowed",
  kin_document: recipeOnly,
  kin_recipes: "allowed",
  kin_issue: "allowed",
  kin_recipe_undo: "allowed",
  kin_receipt: "allowed",
  kin_connection_tools: "allowed",
  // A pasted server may reach anywhere, and so may a tool that says so: arguments to either
  // could carry what the outside text asked for.
  kin_connection_call: closedRead,
  kin_connection_offer: "allowed",
} satisfies Record<string, OutsideToolPolicy>;

/** Whether the turn has read outside text. Sticky: once read, it stays read until the turn ends. */
export const outsideRead = Effect.fn("KinOutsideContent.read")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_wakeup_outside_reads
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId} LIMIT 1`;
  return rows.length > 0;
});

/** Run in the transaction that records the call whose result the agent now reads. */
export const markOutside = Effect.fn("KinOutsideContent.mark")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at)
    VALUES (${turn.orgId}, ${turn.wakeupId}, ${at}) ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
});

/**
 * A turn starts outside-read when what it is shown was written by an outside-read turn: a
 * reminder or schedule asked for there (`eventIds`, its source events), or a hand-off passed on
 * from there. Errs towards outside: the source turn may have read after it wrote.
 */
export const carryOutside = Effect.fn("KinOutsideContent.carry")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly eventIds: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sources =
    input.eventIds.length === 0
      ? sql`0`
      : sql`EXISTS (SELECT 1 FROM kin_events e
          JOIN kin_wakeup_outside_reads o ON o.org_id = e.org_id AND o.wakeup_id = e.wakeup_id
          WHERE e.org_id = ${input.orgId} AND e.event_id IN ${sql.in(input.eventIds)})`;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at)
    SELECT ${input.orgId}, ${input.wakeupId}, ${at}
    WHERE ${sources} OR EXISTS (SELECT 1 FROM kin_events mine
      JOIN kin_handoffs h ON h.org_id = mine.org_id AND h.event_id = mine.event_id
      JOIN kin_events src ON src.org_id = h.org_id AND src.agent_id = h.from_agent_id
        AND src.tag = 'chat.message' AND json_extract(src.json, '$.messageId') = h.message_id
      JOIN kin_wakeup_outside_reads o ON o.org_id = src.org_id AND o.wakeup_id = src.wakeup_id
      WHERE mine.org_id = ${input.orgId} AND mine.wakeup_id = ${input.wakeupId})
    ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
});

/** Whether `name` may run with these arguments once the turn has read outside text. */
export const outsideToolAllowed = Effect.fn("KinOutsideContent.allowed")(
  function* (turn: Turn, name: string, args: unknown) {
    if (!(yield* outsideRead(turn))) return true;
    const policy: OutsideToolPolicy | undefined = Object.hasOwn(OUTSIDE_TOOLS, name)
      ? OUTSIDE_TOOLS[name as keyof typeof OUTSIDE_TOOLS]
      : undefined;
    if (policy === undefined || policy === "refused") return false;
    if (policy === "allowed") return true;
    return yield* policy(turn, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin outside-content check failed; refusing", { cause }).pipe(
      Effect.as(false),
    ),
  ),
);
