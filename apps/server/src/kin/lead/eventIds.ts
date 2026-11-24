// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinEventId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The memory writer accepts only `[a-zA-Z0-9_-]` in event ids, so a readable key is hashed. */
export const hashedEventId = (prefix: string, key: string) =>
  KinEventId.make(
    `${prefix}-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
  );

/** What a tool's left-out source event decodes to where no Kin turn could fill it: refused. */
const UNFILLED_EVENT = "unfilled";

const filled = { description: "Optional: Kin fills in this turn's event." };
/**
 * A tool's `sourceEventId`: the agent may leave it out or pass a message id, and Kin's tool gate
 * puts in this turn's event (`KinToolGate.turnEvents`) before it is read.
 */
export const TurnEvent = TrimmedNonEmptyString.annotate(filled).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(UNFILLED_EVENT)),
);
export const TurnEventId = KinEventId.annotate(filled).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(UNFILLED_EVENT)),
);

/** Tools whose event says only which turn asks: an id from no event of this turn is this turn's. */
export const TURN_ONLY_EVENT_TOOLS: ReadonlySet<string> = new Set(["kin_cancel"]);

/** Tools whose input names the event they act on (`KinToolGate.test.ts` keeps this complete). */
export const TURN_EVENT_TOOLS: ReadonlySet<string> = new Set([
  "bills_add",
  "budget_set",
  "company_profile",
  "doc_create",
  "doc_edit",
  "doc_link",
  "doc_move",
  "doc_restore",
  "doc_rewrite",
  "kin_cancel",
  "kin_defer",
  "kin_document",
  "kin_github_link",
  "kin_github_review",
  "kin_hand_off",
  "kin_issue",
  "kin_receipt",
  "kin_recipe_undo",
  "kin_relay",
  "kin_schedule",
  "kin_take_private",
  "list_define",
  "memory_label",
  "memory_write",
  "payment_record",
  "record_assign",
  "record_create",
  "record_hand_back",
  "record_update",
  "statement_read",
  "touch_log",
]);
