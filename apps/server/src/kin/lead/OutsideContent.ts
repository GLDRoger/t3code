import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { sensitiveShown } from "../work/sensitiveReads.ts";
import { LEAD_T3_TOOLS } from "./t3Tools.ts";
import { SALES_OUTSIDE_TOOLS } from "../sales/policies.ts";

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
  "This turn read text from a connected service, so it can't do this now. Offer it to the owner with kin_ask instead; their tap starts it in a fresh turn. Next time, start the work before you read it.";

const field = (args: unknown, name: string) =>
  Predicate.hasProperty(args, name) ? args[name] : undefined;

/** A recipe's file is made by Kin in the call; a file the agent made, or a recipe it writes, is not. */
const recipeOnly: Condition = (_turn, args) =>
  Effect.succeed(
    typeof field(args, "recipe") === "string" && field(args, "writeRecipe") === undefined,
  );

export const OUTSIDE_TOOLS = {
  kin_chat_post: "allowed",
  kin_widget_upsert: "allowed",
  kin_ask: "allowed",
  kin_ask_close: "allowed",
  // The question carries the turn's stamp, so the turn its answer wakes reads as outside.
  // A question to one person of the company, checked for what they may read; no action rides on it.
  kin_ask_person: "allowed",
  kin_react: "allowed",
  kin_chart: "allowed",
  kin_visual: "allowed",
  kin_chat_read: "allowed",
  kin_leads: "allowed",
  // Outside text could move an agent onto a costlier model.
  agent_update: "refused",
  kin_computer: "allowed",
  people_read: "allowed",
  // Outside text could rename someone or move their hours.
  people_update: "refused",
  // Only the speaker's own date (`setAway`): it holds lines to them alone, on their profile to clear.
  away_set: "allowed",
  // The event each makes carries the turn's stamp, so the turn it starts reads as outside.
  kin_hand_off: "allowed",
  // A discussion wakes every agent on its question: outside text doesn't get to set one.
  team_open: "refused",
  // A turn's words, as kin_chat_post; the turns it wakes act only inside the company.
  team_say: "allowed",
  // Carries only the person's stored message, never what the turn read.
  kin_take_private: "allowed",
  // Words to one person of the company, checked for what they may read.
  kin_relay: "allowed",
  kin_defer: "allowed",
  kin_schedule: "allowed",
  kin_cancel: "allowed",
  memory_search: "allowed",
  memory_read: "allowed",
  // What it writes is the owner's alone: the outside read marks the turn sensitive.
  memory_write: "allowed",
  kin_journal: "allowed",
  memory_label: "allowed",
  // Posts on its own only to the company's repos; anywhere else on the owner's Confirm.
  kin_github_review: "allowed",
  kin_github_link: "allowed",
  // Outside text could start reviews in a person's name.
  kin_github_review_ask: "refused",
  // Outside text could tell Kin to stop watching a repo.
  kin_github_watch: "refused",
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
  record_assign: "allowed",
  record_hand_back: "allowed",
  record_comment: "allowed",
  record_link: "allowed",
  project_note: "allowed",
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
  // A bank's or anyone's text must not become money received; a person's tap records it.
  payment_record: "refused",
  deal_stages: "allowed",
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
  // `callOn` decides: a closed read runs, and anything that may reach the open world, whose
  // arguments could carry what the outside text asked for, becomes one Confirm card instead.
  kin_connection_call: "allowed",
  kin_connection_offer: "allowed",
  // Outside text could relabel which account is for what.
  kin_connection_note: "refused",
  // Drafts stay in Kin; only the owner's Confirm on a card Kin draws from them posts anything.
  social_read: "allowed",
  social_lookup: "allowed",
  social_draft: "allowed",
  social_week: "allowed",
  social_pack: "allowed",
  ...SALES_OUTSIDE_TOOLS,
  // A delegated task, clone or browser is work outside text could steer.
  ...(Object.fromEntries(LEAD_T3_TOOLS.map((name) => [name, "refused" as const])) as Record<
    (typeof LEAD_T3_TOOLS)[number],
    "refused"
  >),
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

const CODING_AGENT_SOURCE = "coding-agent:";
/** The stamp for text a person's coding agent wrote through its key, by the key's name. */
export const codingAgentSource = (name: string) => `${CODING_AGENT_SOURCE}${name}`;

/**
 * The turn is shown what a person's coding agent wrote: outside-read and sensitive-shown at once,
 * so the two marks never differ. Before the text reaches the turn.
 */
export const codingAgentTextShown = Effect.fn("KinOutsideContent.codingAgentTextShown")(function* (
  turn: Pick<Turn, "orgId" | "wakeupId">,
  source: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.all([markOutside(turn, source), sensitiveShown(turn)], { discard: true }).pipe(
    sql.withTransaction,
  );
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

/** The stamp stored under `key`: an event's, or a question's an outside-read turn asked. */
export const storedStamp = Effect.fn("KinOutsideContent.storedStamp")(function* (
  orgId: KinOrgId,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ source: string }>`SELECT outside_from AS source
    FROM kin_event_outside WHERE org_id = ${orgId} AND event_id = ${key}`;
  return row?.source;
});

/**
 * A turn starts outside-read when it shows outside text itself, or when an event it shows, or the
 * event a reminder it shows was asked in, carries a stamp. Run before the prompt is sent; a failure stops the prompt.
 */
export const inheritOutside = Effect.fn("KinOutsideContent.inherit")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly eventIds: ReadonlyArray<string>;
  /** The prompt itself shows outside text, such as a check-in's mail lines, from here. */
  readonly shows?: string | undefined;
}) {
  if (input.shows !== undefined) return yield* markOutside(input, input.shows);
  const sql = yield* SqlClient.SqlClient;
  const events =
    input.eventIds.length === 0
      ? []
      : yield* sql<{ source: string }>`SELECT outside_from AS source FROM kin_event_outside
          WHERE org_id = ${input.orgId} AND event_id IN ${sql.in(input.eventIds)}
          ORDER BY event_id LIMIT 1`;
  const source = events[0]?.source;
  if (source === undefined) return;
  yield* source.startsWith(CODING_AGENT_SOURCE)
    ? codingAgentTextShown(input, source)
    : markOutside(input, source);
});

const PAGES_TURNS = 200;
const PAGES_PER_TURN = 2_000;
/** Per wake-up, the page addresses it was given (`web_page`): the newest 200 turns, 2,000 each. */
const pagesSeen = new Map<string, Set<string>>();
const turnKey = (turn: Pick<Turn, "orgId" | "wakeupId">) => `${turn.orgId} ${turn.wakeupId}`;
const pageKey = (address: string) => {
  if (!URL.canParse(address)) return undefined;
  const url = new URL(address);
  url.hash = "";
  return url.href;
};

/** Pages the turn read, and the links they gave, which it may open after outside text. */
export const rememberPages = (
  turn: Pick<Turn, "orgId" | "wakeupId">,
  addresses: ReadonlyArray<string>,
) =>
  Effect.sync(() => {
    const key = turnKey(turn);
    const seen = pagesSeen.get(key) ?? new Set<string>();
    pagesSeen.delete(key);
    pagesSeen.set(key, seen);
    for (const address of addresses) {
      if (seen.size >= PAGES_PER_TURN) break;
      const page = pageKey(address);
      if (page !== undefined) seen.add(page);
    }
    for (const old of pagesSeen.keys()) {
      if (pagesSeen.size <= PAGES_TURNS) break;
      pagesSeen.delete(old);
    }
  });

/** Whether the turn read this page, or a page it read links to it. */
export const pageSeen = (turn: Pick<Turn, "orgId" | "wakeupId">, address: string) => {
  const page = pageKey(address);
  return page !== undefined && pagesSeen.get(turnKey(turn))?.has(page) === true;
};

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
