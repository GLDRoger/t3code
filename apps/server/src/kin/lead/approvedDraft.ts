import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { resolveConnection } from "../connections/ConnectionRows.ts";
import { MAIL_TOOL } from "../connections/MailProvider.ts";
import { KIN_READ_TOOLS } from "../mcp/readTools.ts";
import { approvalOf, DRAFT_LIST, type DraftKind, keepsDraft } from "../questions/approval.ts";

/**
 * The turn the owner's Approve on a sent-up draft queued (`approveDraft`) is confined, as an
 * outside review is (`outsideReview`): it may read, ask the owner on a card, and make the ONE
 * thing of the approved kind through Kin's own draft paths. Anything else is refused at the gate.
 */
export const APPROVED_REFUSAL =
  "This turn only makes the draft the owner approved. Nothing else ran.";

/** Where each make carries the approved text. */
const WORDS_IN: Record<string, string> = {
  doc_create: "the doc's body",
  record_create: "each entry's notes",
  kin_connection_call: "the mail's body",
  social_draft: "the caption",
};
/** A make that changed the approved words: refused, so the one make stays open. */
export const approvedWords = (tool: string) =>
  `Nothing was made: put the approved draft's whole text in ${WORDS_IN[tool] ?? "it"} word for word, as the owner approved it.`;

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

/** The text each make writes, by its own arguments: none for a week card of drafts already made. */
const madeTexts = (name: string, args: unknown): ReadonlyArray<unknown> => {
  if (name === "doc_create") return [field(args, "body")];
  if (name === "record_create") {
    const rows = field(args, "records");
    return Array.isArray(rows) ? rows.map((row: unknown) => field(row, "notes")) : [undefined];
  }
  if (name === "kin_connection_call") return [field(field(args, "arguments"), "body")];
  if (name === "social_draft") return [field(args, "caption")];
  return [];
};

/**
 * What an approved draft's turn makes of `name`: undefined when the turn isn't one; refused, or
 * reworded when it is the one make but drops or changes the approved words. A wake that names an
 * approval it isn't (`approvalOf` invalid) may only read.
 */
const verdict = Effect.fn("KinApprovedDraft.verdict")(function* (
  turn: Turn,
  name: string,
  args: unknown,
) {
  const of = yield* approvalOf(turn);
  if (of._tag === "none") return undefined;
  if (APPROVED_READS.has(name)) return "allowed" as const;
  if (of._tag === "invalid") return "refused" as const;
  if (APPROVED_ASKS.has(name)) return "allowed" as const;
  if (!(yield* makes(turn, of.approval.draft.kind, name, args))) return "refused" as const;
  const text = of.approval.draft.text;
  return madeTexts(name, args).every((made) => keepsDraft(made, text))
    ? ("allowed" as const)
    : ("reworded" as const);
});
const refuseOnFailure = Effect.catchCause((cause) =>
  Effect.logWarning("Kin approved draft check failed; refusing", { cause }).pipe(
    Effect.as("refused" as const),
  ),
);

/** Whether `name` may run in an approved draft's turn; undefined when the turn isn't one. */
export const approvedToolAllowed = (turn: Turn, name: string, args: unknown) =>
  verdict(turn, name, args).pipe(
    refuseOnFailure,
    Effect.map((of) => (of === undefined ? undefined : of === "allowed")),
  );

/** What an approved draft's turn answers a call it refuses with; undefined lets it run. */
export const approvedRefusal = (turn: Turn, name: string, args: unknown) =>
  verdict(turn, name, args).pipe(
    refuseOnFailure,
    Effect.map((of) =>
      of === "refused" ? APPROVED_REFUSAL : of === "reworded" ? approvedWords(name) : undefined,
    ),
  );
