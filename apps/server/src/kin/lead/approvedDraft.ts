import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { resolveConnection } from "../connections/ConnectionRows.ts";
import { MAIL_TOOL } from "../connections/MailProvider.ts";
import { KIN_READ_TOOLS } from "../mcp/readTools.ts";
import { approvalOf, DRAFT_LIST, type DraftKind } from "../questions/approval.ts";

/**
 * The turn the owner's Approve on a sent-up draft queued (`approveDraft`) is confined, as an
 * outside review is (`outsideReview`): it may read, ask the owner on a card, and make the ONE
 * thing of the approved kind through Kin's own draft paths. Anything else is refused at the gate.
 */
export const APPROVED_REFUSAL =
  "This turn only makes the draft the owner approved. Nothing else ran.";

/** What it may read: the owner lane's read tools. */
export const APPROVED_READS: ReadonlySet<string> = new Set([
  ...KIN_READ_TOOLS,
  "memory_search",
  "memory_read",
  "kin_chat_read",
  "kin_connection_tools",
  "kin_recipes",
  "social_read",
  "social_lookup",
]);

/** It may ask the owner, in his chat, for a price or term the draft leaves blank. */
export const APPROVED_ASKS: ReadonlySet<string> = new Set(["kin_ask"]);

/** The one make each kind allows: a doc, an entry on its list, or Kin's own draft-to-Confirm path. */
export const APPROVED_MAKES: Record<DraftKind, ReadonlySet<string>> = {
  proposal: new Set(["doc_create"]),
  terms: new Set(["doc_create"]),
  quote: new Set(["record_create"]),
  invoice: new Set(["record_create"]),
  mail: new Set(["kin_connection_call"]),
  post: new Set(["social_draft", "social_week"]),
};

/** Kin's own mail tools that stage a mail on its Confirm card (builtin mail always asks). */
const MAIL_DRAFTS: ReadonlySet<string> = new Set([MAIL_TOOL.send, MAIL_TOOL.reply]);

type Turn = { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string };

const field = (args: unknown, key: string) =>
  Predicate.hasProperty(args, key) ? args[key] : undefined;

/** Whether this call is the approved kind's make, by its own arguments. */
const makes = Effect.fn("KinApprovedDraft.makes")(function* (
  turn: Turn,
  kind: DraftKind,
  name: string,
  args: unknown,
) {
  if (!APPROVED_MAKES[kind].has(name)) return false;
  if (name === "doc_create") return field(args, "whatWeSell") !== true;
  if (name === "record_create") {
    const rows = field(args, "records");
    return (
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every((row: unknown) => field(row, "list") === DRAFT_LIST[kind])
    );
  }
  if (name === "social_draft")
    return field(args, "postId") === undefined && field(args, "remove") === undefined;
  if (name === "kin_connection_call") {
    const tool = field(args, "tool");
    const connection = field(args, "connection");
    if (typeof tool !== "string" || !MAIL_DRAFTS.has(tool) || typeof connection !== "string")
      return false;
    // Only Kin's own mail: a connector's tool of the same name could send without a Confirm.
    const found = yield* resolveConnection(turn.orgId, connection);
    return found._tag === "found" && found.row.kind === "builtin";
  }
  return true;
});

/**
 * Whether `name` may run in an approved draft's turn; undefined when the turn isn't one. A wake
 * that names an approval it isn't (`approvalOf` invalid) may only read.
 */
export const approvedToolAllowed = Effect.fn("KinApprovedDraft.allowed")(
  function* (turn: Turn, name: string, args: unknown) {
    const of = yield* approvalOf(turn);
    if (of._tag === "none") return undefined;
    if (APPROVED_READS.has(name)) return true;
    if (of._tag === "invalid") return false;
    if (APPROVED_ASKS.has(name)) return true;
    return yield* makes(turn, of.approval.draft.kind, name, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin approved draft check failed; refusing", { cause }).pipe(
      Effect.as<boolean | undefined>(false),
    ),
  ),
);
