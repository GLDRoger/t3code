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
 * outside-read turn made). Built like `SHARED_TOOLS`: the gate refuses any tool
 * without a line. Conditions read stored rows; arguments only name the subject.
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
  people_read: "allowed",
  kin_end: "allowed",
  // Workers have a shell and the network: outside text could steer either.
  kin_delegate: "refused",
  kin_follow_up: "refused",
  kin_worker_stop: "allowed",
  // The event each makes carries the turn's stamp, so the turn it starts reads as outside.
  kin_hand_off: "allowed",
  // Carries only the person's stored message, never what the turn read.
  kin_take_private: "allowed",
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
  // Posts on its own only to the company's private repos; anywhere else on the owner's Confirm.
  kin_github_review: "allowed",
  kin_github_link: "allowed",
  // The owner reads and signs the exact payload.
  request_action: "allowed",
  records_query: "allowed",
  record_get: "allowed",
  record_create: "allowed",
  record_update: "allowed",
  // Kin's own facts and the hold on one; nothing leaves the company.
  pulse_read: "allowed",
  pulse_handle: "allowed",
  pulse_nudge: "allowed",
  client_read: "allowed",
  touch_log: "allowed",
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
  money_query: "allowed",
  budget_set: "allowed",
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

/**
 * Where the turn's outside text came from, or `undefined` while it has read none. Sticky: once
 * read, it stays read until the turn ends. Events the turn makes carry it as their stamp.
 */
export const outsideStamp = Effect.fn("KinOutsideContent.stamp")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ source: string }>`SELECT source FROM kin_wakeup_outside_reads
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}`;
  return row?.source;
});

/** Whether the turn has read outside text. */
export const outsideRead = (turn: Pick<Turn, "orgId" | "wakeupId">) =>
  outsideStamp(turn).pipe(Effect.map((source) => source !== undefined));

/**
 * Marks the turn outside-read, before the outside text reaches it. The events it claimed carry
 * the stamp too, so a retry that requeues them, and a reminder asked by one, start marked.
 */
export const markOutside = Effect.fn("KinOutsideContent.mark")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
  source: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_wakeup_outside_reads (org_id, wakeup_id, read_at, source)
    VALUES (${turn.orgId}, ${turn.wakeupId}, ${at}, ${source})
    ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
  yield* sql`INSERT INTO kin_event_outside (org_id, event_id, outside_from)
    SELECT org_id, event_id, ${source} FROM kin_events
    WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}
    ON CONFLICT (org_id, event_id) DO NOTHING`;
});

/** An event an outside-read turn made carries its stamp; a retry or a requeue keeps it. */
export const stampEvent = Effect.fn("KinOutsideContent.stampEvent")(function* (
  orgId: KinOrgId,
  eventId: string,
  source: string | undefined,
) {
  if (source === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_event_outside (org_id, event_id, outside_from)
    VALUES (${orgId}, ${eventId}, ${source}) ON CONFLICT (org_id, event_id) DO NOTHING`;
});

/**
 * A turn starts outside-read when an event it shows, or the event a reminder it shows was asked
 * in, carries a stamp. Run before the prompt is sent; a failure stops the prompt.
 */
export const inheritOutside = Effect.fn("KinOutsideContent.inherit")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly eventIds: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const events =
    input.eventIds.length === 0
      ? []
      : yield* sql<{ source: string }>`SELECT outside_from AS source FROM kin_event_outside
          WHERE org_id = ${input.orgId} AND event_id IN ${sql.in(input.eventIds)}
          ORDER BY event_id LIMIT 1`;
  const source = events[0]?.source;
  if (source !== undefined) yield* markOutside(input, source);
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
