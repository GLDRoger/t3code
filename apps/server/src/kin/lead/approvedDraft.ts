import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { resolveConnection } from "../connections/ConnectionRows.ts";
import { MAIL_TOOL } from "../connections/MailProvider.ts";
import { KIN_READ_TOOLS } from "../mcp/readTools.ts";
import {
  approvalOf,
  DRAFT_LIST,
  type DraftKind,
  keepsDraft,
  writtenOnApprove,
} from "../questions/approval.ts";

/**
 * The turn the owner's Approve on a sent-up draft queued (`approveDraft`) is confined, as an
 * outside review is (`outsideReview`): it may read, ask the owner on a card, and make the ONE
 * thing of the approved kind through Kin's own draft paths. Anything else is refused at the gate.
 */
export const APPROVED_REFUSAL =
  "This turn only makes the draft the owner approved. Nothing else ran.";

/** Where each make carries the approved text. */
const WORDS_IN: Record<string, string> = {
  record_create: "the entry's notes",
  social_draft: "the caption",
};
/** A make that changed the approved words: refused, so the one make stays open. */
export const approvedWords = (tool: string) =>
  tool === "kin_connection_call"
    ? "Nothing was made: send the approved draft word for word and nothing else, its own To, Cc and Subject lines at the top, if any, as the mail's addresses and subject, and the rest as its body."
    : `Nothing was made: put the approved draft's whole text in ${WORDS_IN[tool] ?? "it"} word for word, and nothing else, as the owner approved it.`;
/** A proposal or client terms: Kin wrote it in the owner's Approve (`writeApproved`). */
export const WRITTEN_ITSELF = "Kin wrote this one itself when it was approved: it is in Docs.";
/** An approved quote or invoice is one entry. */
export const ONE_ENTRY =
  "Nothing was made: the approved draft is one entry, so make it with one row.";
/** A post's week card waits on the post it carries. */
export const POST_FIRST = "Save the approved post first.";
/** Its card carries that post alone: other drafts of its group wait for a card of their own. */
export const POST_ALONE =
  "Nothing was made: this group has other drafts still to come, and the approved post's card carries it alone.";

/** What it may read: the owner lane's read tools. */
const APPROVED_READS: ReadonlySet<string> = new Set([
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
const APPROVED_ASKS: ReadonlySet<string> = new Set(["kin_ask"]);

/** The one make each kind allows: a doc, an entry on its list, or Kin's own draft-to-Confirm path. */
const APPROVED_MAKES: Record<DraftKind, ReadonlySet<string>> = {
  proposal: new Set(),
  terms: new Set(),
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

/** Whether the make's own text is the approved text; a mail is checked as prepared (`ConnectionsService`). */
const keepsWords = (name: string, args: unknown, text: string) => {
  if (name === "record_create") {
    const rows = field(args, "records");
    return (
      Array.isArray(rows) && rows.every((row: unknown) => keepsDraft(field(row, "notes"), text))
    );
  }
  if (name === "social_draft") return keepsDraft(field(args, "caption"), text);
  return true;
};
const rowsOf = (args: unknown) => {
  const rows = field(args, "records");
  return Array.isArray(rows) ? rows.length : 0;
};

const ALLOWED = "allowed";

/**
 * What an approved draft's turn makes of `name`: undefined when the turn isn't one, else allowed
 * or the refusal it answers with. It may read and ask; then one make of the approved kind with the
 * approved words, and nothing once that is made, but a post's one week card. A wake that names an
 * approval it isn't (`approvalOf` invalid) may only read.
 */
const verdict = Effect.fn("KinApprovedDraft.verdict")(function* (
  turn: Turn,
  name: string,
  args: unknown,
) {
  const of = yield* approvalOf(turn);
  if (of._tag === "none") return undefined;
  if (APPROVED_READS.has(name)) return ALLOWED;
  if (of._tag === "invalid") return APPROVED_REFUSAL;
  if (APPROVED_ASKS.has(name)) return ALLOWED;
  const { draft, made } = of.approval;
  if (writtenOnApprove(draft.kind))
    return name === "doc_create" || name === "kin_document" ? WRITTEN_ITSELF : APPROVED_REFUSAL;
  if (name === "social_week" && draft.kind === "post") {
    if (made === null) return POST_FIRST;
    return made.kind === "post" && made.postId !== undefined && made.cardId === undefined
      ? ALLOWED
      : APPROVED_REFUSAL;
  }
  if (made !== null || !(yield* makes(turn, draft.kind, name, args))) return APPROVED_REFUSAL;
  if (name === "record_create" && rowsOf(args) !== 1) return ONE_ENTRY;
  return keepsWords(name, args, draft.text) ? ALLOWED : approvedWords(name);
});
const refuseOnFailure = Effect.catchCause((cause) =>
  Effect.logWarning("Kin approved draft check failed; refusing", { cause }).pipe(
    Effect.as<string | undefined>(APPROVED_REFUSAL),
  ),
);

/** Whether `name` may run in an approved draft's turn; undefined when the turn isn't one. */
export const approvedToolAllowed = (turn: Turn, name: string, args: unknown) =>
  verdict(turn, name, args).pipe(
    refuseOnFailure,
    Effect.map((of) => (of === undefined ? undefined : of === ALLOWED)),
  );

/** What an approved draft's turn answers a call it refuses with; undefined lets it run. */
export const approvedRefusal = (turn: Turn, name: string, args: unknown) =>
  verdict(turn, name, args).pipe(
    refuseOnFailure,
    Effect.map((of) => (of === ALLOWED ? undefined : of)),
  );
