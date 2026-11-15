import { KIN_COMPANY_CHAT_TEAM_ID, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { aborted, askedIn, effectiveAudience, turnChat } from "./Audience.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";

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
 * What a tool may do in a turn someone besides the owner can read; the gate refuses any tool
 * without a line. Conditions read stored rows. `team_memory`: `LeadMemory` limits it to what the
 * team can know. `view`: its handler sees only what every person behind the turn may (`viewSees`).
 */
export type SharedToolPolicy = "allowed" | "team_memory" | "view" | "refused" | Condition;

const field = (args: unknown, name: string) =>
  Predicate.hasProperty(args, name) ? args[name] : undefined;

/** Writes into the chat the turn answers; `destination` checks the same inside the write. */
const inTurnChat: Condition = Effect.fnUntraced(function* (turn, args) {
  const chatId = field(args, "chatId");
  return typeof chatId === "string" && (yield* turnChat(turn))?.chatId === chatId;
});

const inAskedChat: Condition = Effect.fnUntraced(function* (turn, args) {
  const chatId = field(args, "chatId");
  return typeof chatId === "string" && (yield* askedIn(turn, chatId));
});

/** The turn answers in the company chat: what it makes is shared with the whole team. */
export const inCompanyChat = Effect.fn("KinSharedTools.inCompanyChat")(function* (turn: Turn) {
  const chat = yield* turnChat(turn);
  if (chat === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${turn.orgId}
    AND chat_id = ${chat.chatId} AND team_id = ${KIN_COMPANY_CHAT_TEAM_ID} AND archived_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
});

/** Every message, tap and reaction the turn answers is the owner's or a co-owner's, by stored author. */
const ownerAsked = Effect.fnUntraced(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ fromOwner: number }>`
    SELECT CASE
        WHEN json_extract(e.json, '$.origin.personId') IS NOT NULL THEN 0
        WHEN e.tag IN ('chat.message', 'widget.action') THEN
          m.author_kind = 'human' AND (m.author_person_id = a.owner_person_id
            OR ${sql.literal(ownerLevelSql("e.org_id", "m.author_person_id"))})
            AND m.chat_id = json_extract(e.json, '$.chatId')
        WHEN e.tag = 'chat.reaction' THEN
          json_extract(e.json, '$.provenance._tag') = 'human'
            AND (json_extract(e.json, '$.provenance.personId') = a.owner_person_id
              OR ${sql.literal(ownerLevelSql("e.org_id", "json_extract(e.json, '$.provenance.personId')"))})
        ELSE 0 END AS "fromOwner"
    FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId}
    ORDER BY e.event_id`;
  return rows.length > 0 && rows.every((row) => row.fromOwner === 1);
});

/**
 * Whether a turn others read may touch this worker: this lead's shared work, asked for in the
 * chat the turn answers, and not moved out of it by a join (`onPersonJoined`).
 */
export const sharedTurnMayTouch = Effect.fn("KinSharedTools.mayTouchWorker")(function* (
  turn: Turn,
  workerId: unknown,
) {
  if (typeof workerId !== "string") return false;
  const chat = yield* turnChat(turn);
  if (chat === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_workers
    WHERE org_id = ${turn.orgId} AND worker_id = ${workerId} AND agent_id = ${turn.agentId}
      AND chat_id = ${chat.chatId} AND moved_at IS NULL AND context = 'shared'
    LIMIT 1`;
  return rows.length > 0;
});

const ownerAskedAboutWorkerHere: Condition = Effect.fnUntraced(function* (turn, args) {
  return (yield* ownerAsked(turn)) && (yield* sharedTurnMayTouch(turn, field(args, "workerId")));
});

/**
 * The owner may start work from a team chat, but no note of theirs goes with it, and it builds on
 * or reviews only work the turn may touch.
 */
const ownerDelegates: Condition = Effect.fnUntraced(function* (turn, args) {
  const memory = field(args, "memoryItemIds");
  if (memory !== undefined && !(Array.isArray(memory) && memory.length === 0)) return false;
  const reviewOf = field(args, "reviewOf");
  if (reviewOf !== undefined && !(yield* sharedTurnMayTouch(turn, reviewOf))) return false;
  const baseRef = field(args, "baseRef");
  // A worker's branch (`publishBranch`) carries its work as a review's refs do.
  const branchOf =
    typeof baseRef === "string" ? /kin\/worker\/([^/\s~^:]+)/i.exec(baseRef)?.[1] : undefined;
  if (branchOf !== undefined && !(yield* sharedTurnMayTouch(turn, branchOf))) return false;
  return yield* ownerAsked(turn);
});

export const SHARED_TOOLS = {
  kin_chat_post: inTurnChat,
  kin_widget_upsert: inTurnChat,
  // These three take no chat: they go to the turn's own chat, and `destination` checks it.
  kin_ask: "allowed",
  kin_react: "allowed",
  // Numbers the agent supplies, which it could have written in that chat as text; it reads nothing.
  kin_chart: "allowed",
  // A page is code that runs on each reader's device: owner-only chats until it is reviewed.
  kin_visual: "refused",
  kin_chat_read: inAskedChat,
  // Lists only the names of the leads in the asked chat (`KinHandoff.leads`).
  kin_leads: "allowed",
  // What everyone in the org sees on profiles; workload only in the owner's own turns.
  people_read: "allowed",
  // Saved only for the one person who asked, with their own rights.
  people_update: "allowed",
  // Ends the turn; a shared turn's summary reaches no journal (`LeadMemory.end`).
  kin_end: "allowed",
  kin_delegate: ownerDelegates,
  kin_follow_up: ownerAskedAboutWorkerHere,
  kin_worker_stop: ownerAskedAboutWorkerHere,
  // Only to an agent in the group asked in (`KinHandoff.passInRoom`).
  kin_hand_off: "allowed",
  // Posts only the person's own stored words in their own direct chat; nothing of this turn.
  kin_take_private: "allowed",
  memory_search: "team_memory",
  memory_read: "team_memory",
  memory_write: "team_memory",
  kin_journal: "team_memory",
  // Who may know an item is the owner's to decide.
  memory_label: "refused",
  kin_defer: "refused",
  kin_schedule: "refused",
  kin_cancel: "refused",
  kin_github_repos: "refused",
  kin_github_prs: "refused",
  kin_github_pr: "refused",
  kin_github_runs: "refused",
  kin_github_review: "refused",
  kin_github_link: "refused",
  request_action: "refused",
  // Work tasks every person behind the turn may see, shaped as their own screens show them.
  records_query: "view",
  record_get: "view",
  // A teammate's own contact with a client is theirs to report; the whole client is the owner's.
  touch_log: "allowed",
  client_read: "refused",
  // Tasks, meetings and milestones for the people there, shared with the team (`viewGuard`).
  record_create: "view",
  record_update: "view",
  // Work facts on tasks every person behind the turn may see; money and system facts are the owner's.
  pulse_read: "view",
  pulse_handle: "refused",
  pulse_nudge: "refused",
  // Giving out a task everyone there sees; handing back is the asker's own task, in their view.
  record_assign: "view",
  record_hand_back: "view",
  // Docs every person behind the turn may see; writes as each of them may (a project's lead in
  // their project). Restoring stays the owner's.
  doc_create: "view",
  doc_read: "view",
  doc_edit: "view",
  doc_rewrite: "view",
  doc_move: "view",
  doc_link: "view",
  docs_search: "view",
  doc_history: "view",
  doc_restore: "refused",
  // Defining a list, payments and the company profile are the owner's (design 9.3, 4.9).
  list_define: "refused",
  payment_record: "refused",
  // Figures and dates of the money lines every person behind the turn sees, such as their
  // project's; the bank, budgets and the company's own figures stay the owner's.
  money_summary: "view",
  money_query: "refused",
  budget_set: "refused",
  dates_query: "view",
  company_profile: "refused",
  // A statement is the owner's bank account; reading one marks the turn as a sensitive read.
  statement_read: "refused",
  statement_rows: "refused",
  // Generated files, recipes and issued numbers read and make the owner's records and money.
  kin_document: "refused",
  kin_recipes: "refused",
  kin_issue: "refused",
  kin_recipe_undo: "refused",
  kin_receipt: "refused",
  // Connected services are the owner's accounts; the service checks the audience again.
  kin_connection_tools: "refused",
  kin_connection_call: "refused",
  kin_connection_offer: "refused",
  kin_connection_note: "refused",
} satisfies Record<string, SharedToolPolicy>;

/** Whether `name` may run with these arguments in a turn someone besides the owner reads. */
export const sharedToolAllowed = Effect.fn("KinSharedTools.allowed")(
  function* (turn: Turn, name: string, args: unknown) {
    const policy: SharedToolPolicy | undefined = Object.hasOwn(SHARED_TOOLS, name)
      ? SHARED_TOOLS[name as keyof typeof SHARED_TOOLS]
      : undefined;
    if (policy === undefined || policy === "refused") return false;
    if (policy === "allowed" || policy === "team_memory" || policy === "view") return true;
    return yield* policy(turn, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin shared tool check failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);

/**
 * The one check for a tool call: nothing in a turn aborted for its audience, everything in an
 * owner-only one, else what `SHARED_TOOLS` allows. The gate runs it before every call; services
 * whose writes outlive the call run it again inside them.
 */
export const toolAdmitted = Effect.fn("KinSharedTools.admitted")(
  function* (turn: Turn, name: string, args: unknown) {
    if (yield* aborted(turn)) return false;
    if ((yield* effectiveAudience(turn)) === "owner_only") return true;
    return yield* sharedToolAllowed(turn, name, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin tool check failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);
