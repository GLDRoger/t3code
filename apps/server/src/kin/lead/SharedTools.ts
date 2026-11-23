import { KIN_COMPANY_CHAT_TEAM_ID, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { LEAD_T3_TOOLS } from "./t3Tools.ts";
import { SALES_SHARED_TOOLS } from "../sales/policies.ts";
import { aborted, askedIn, askersDirectChat, effectiveAudience, turnChat } from "./Audience.ts";
import { reviewToolAllowed } from "./outsideReview.ts";

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

/**
 * A reminder for whoever asked, in their own chat with this agent: it never messages anyone else.
 * `LeadMemory.cancelOwn` lets `replaces` name only their own reminder there.
 */
const ownReminder: Condition = Effect.fnUntraced(function* (turn, args) {
  const chatId = field(args, "chatId");
  if (field(args, "onDue") !== "remind") return false;
  return typeof chatId === "string" && (yield* askersDirectChat(turn, chatId));
});

/** Asked in the asker's own chat with this agent; `LeadMemory.cancelOwn` checks the item is theirs. */
const ownReminderCancel: Condition = Effect.fnUntraced(function* (turn) {
  const chat = yield* turnChat(turn);
  return chat !== undefined && (yield* askersDirectChat(turn, chat.chatId));
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

const t3ToolsRefused = Object.fromEntries(
  LEAD_T3_TOOLS.map((name) => [name, "refused" as const]),
) as Record<(typeof LEAD_T3_TOOLS)[number], "refused">;

export const SHARED_TOOLS = {
  kin_chat_post: inTurnChat,
  kin_widget_upsert: inTurnChat,
  // These three take no chat: they go to the turn's own chat, and `destination` checks it.
  kin_ask: "allowed",
  // Closes a question to the person in the turn's chat; only its asker withdraws one.
  kin_ask_close: "allowed",
  // Checked against everyone behind the turn, in its own transaction (`askPerson`).
  kin_ask_person: "allowed",
  kin_react: "allowed",
  // Numbers the agent supplies, which it could have written in that chat as text; it reads nothing.
  kin_chart: "allowed",
  // Like a chart, in the sealed frame; its figures are checked against everyone behind the
  // turn (`KinLevelGate.visual`).
  kin_visual: "allowed",
  // Its page is checked against everyone behind the turn as a visual's is; an earlier picture it
  // revises is one they all see; its doc carries the turn's audience (`teamView.personSees`).
  kin_picture: "view",
  kin_chat_read: inAskedChat,
  // Lists only the names of the leads in the asked chat (`KinHandoff.leads`).
  kin_leads: "allowed",
  // An agent's model is the owner's call, made in the owner's own chat.
  agent_update: "refused",
  // Why agents can't work and the computer's state: no company data, and the asker's answer.
  kin_computer: "allowed",
  // What everyone in the org sees on profiles; workload only in the owner's own turns.
  people_read: "allowed",
  // Saved only for the one person who asked, with their own rights.
  people_update: "allowed",
  // Only the speaker's own date, in their own direct chat with this agent (`setAway`).
  away_set: "allowed",
  // Only to an agent in the group asked in (`KinHandoff.passInRoom`).
  kin_hand_off: "allowed",
  // Posts only the person's own stored words in their own direct chat; nothing of this turn.
  kin_take_private: "allowed",
  // The asker's request, quoted as theirs, to someone who decides for them (`KinHandoff.relay`).
  kin_relay: "allowed",
  // The Team room is owner-level: a turn someone else reads neither opens nor speaks there.
  team_open: "refused",
  team_say: "refused",
  memory_search: "team_memory",
  memory_read: "team_memory",
  memory_write: "team_memory",
  kin_journal: "team_memory",
  // Who may know an item is the owner's to decide.
  memory_label: "refused",
  kin_defer: ownReminder,
  kin_schedule: "refused",
  kin_cancel: ownReminderCancel,
  kin_github_review: "refused",
  // Only from the asker's own direct chat with this agent, checked by the service (`askReview`).
  kin_github_review_ask: "allowed",
  kin_github_link: "refused",
  kin_github_watch: "refused",
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
  // A note on a task everyone there sees, for them; it changes nothing on the task.
  record_comment: "view",
  // A web link on an entry each of them may edit on their own screen.
  record_link: "view",
  // A project's note for every task is the owner level's.
  project_note: "refused",
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
  // The company's stage names: no deal, figure or client in them.
  deal_stages: "view",
  money_summary: "view",
  money_query: "refused",
  budget_set: "refused",
  number_record: "refused",
  numbers_read: "refused",
  dates_query: "view",
  company_profile: "refused",
  // How Kin is set up for the company is the owner level's to change.
  shell_propose: "refused",
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
  // The company's and clients' social accounts are the owner's.
  social_read: "refused",
  social_lookup: "refused",
  social_draft: "refused",
  social_week: "refused",
  social_pack: "refused",
  ...SALES_SHARED_TOOLS,
  // A shell's worth of reach as the owner, on his GitHub login (`AgentSession`).
  ...t3ToolsRefused,
} satisfies Record<string, SharedToolPolicy>;

/**
 * Whether a shared thread lists `name`. Its turns are never owner-only (`effectiveAudience`), so a
 * tool refused there, or one without a line, can't succeed in any of them.
 */
export const listedOnSharedThread = (name: string) => {
  const policy: SharedToolPolicy | undefined = Object.hasOwn(SHARED_TOOLS, name)
    ? SHARED_TOOLS[name as keyof typeof SHARED_TOOLS]
    : undefined;
  return policy !== undefined && policy !== "refused";
};

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
 * The one check for a tool call: nothing in a turn aborted for its audience, only `REVIEW_TOOLS`
 * in an outside review, everything in an owner-only turn, else what `SHARED_TOOLS` allows. The
 * gate runs it before every call; services whose writes outlive the call run it again inside them.
 */
export const toolAdmitted = Effect.fn("KinSharedTools.admitted")(
  function* (turn: Turn, name: string, args: unknown) {
    if (yield* aborted(turn)) return false;
    const review = yield* reviewToolAllowed(turn, name, args);
    if (review !== undefined) return review;
    if ((yield* effectiveAudience(turn)) === "owner_only") return true;
    return yield* sharedToolAllowed(turn, name, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin tool check failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);
