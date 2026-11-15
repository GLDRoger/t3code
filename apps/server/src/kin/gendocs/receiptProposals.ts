// @effect-diagnostics nodeBuiltinImport:off -- a proposal's id is a hash of what it asks.
import * as NodeCrypto from "node:crypto";

import { KinChatError, KinDay, KinMoney, type KinOrgId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { cardAnswer } from "../work/ownerCards.ts";

/**
 * An agent's receipt that would record money received waits here, exactly as asked, until the
 * owner taps Confirm on its card. Only that tap carries it out; changed arguments are a new
 * proposal and a new card.
 */

export const ReceiptRequest = Schema.Struct({
  paymentId: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
  advance: Schema.optionalKey(
    Schema.Struct({
      client: Schema.optionalKey(Schema.String),
      amount: KinMoney,
      receivedOn: KinDay,
    }),
  ),
  against: Schema.optionalKey(Schema.String),
  towards: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  reference: Schema.optionalKey(Schema.String),
});
export type ReceiptRequest = typeof ReceiptRequest.Type;
const RequestJson = Schema.fromJsonString(ReceiptRequest);
const decodeRequest = Schema.decodeUnknownOption(RequestJson);

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });

/** Stores the request in this turn's chat. The same request in the same turn is one proposal. */
export const proposeReceipt = Effect.fn("KinReceipts.propose")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly chatId: string;
  readonly request: ReceiptRequest;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const json = stableStringify(input.request);
  const proposalId = `rp_${NodeCrypto.createHash("sha256")
    .update(`${input.orgId.length}:${input.orgId}${input.agentId}:${input.wakeupId}:${json}`)
    .digest("hex")
    .slice(0, 16)}`;
  yield* sql`INSERT INTO kin_receipt_proposals (org_id, proposal_id, agent_id, wakeup_id, chat_id,
      request_json, proposed_at)
    VALUES (${input.orgId}, ${proposalId}, ${input.agentId}, ${input.wakeupId}, ${input.chatId},
      ${json}, ${input.now})
    ON CONFLICT DO NOTHING`;
  return proposalId;
});

/** The card the proposal was put to the owner with; a retry keeps the first. */
export const attachReceiptCard = Effect.fn("KinReceipts.attachCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly proposalId: string;
  readonly widgetId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_receipt_proposals SET widget_id = ${input.widgetId}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId} AND widget_id IS NULL`;
});

/**
 * The stored request of an agent's own proposal the owner confirmed on its card, or the receipt
 * it already made. Refused while the card is unanswered, and for good once it says no.
 */
export const confirmedReceipt = Effect.fn("KinReceipts.confirmed")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly proposalId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    json: string;
    widgetId: string | null;
    receiptKey: string | null;
    owner: string;
  }>`SELECT p.request_json AS json, p.widget_id AS "widgetId", p.receipt_key AS "receiptKey",
      a.owner_person_id AS owner
    FROM kin_receipt_proposals p
    JOIN kin_agents a ON a.org_id = p.org_id AND a.agent_id = p.agent_id
    WHERE p.org_id = ${input.orgId} AND p.proposal_id = ${input.proposalId}
      AND p.agent_id = ${input.agentId}`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No receipt proposal ${input.proposalId.slice(0, 40)} of yours. Call kin_receipt with what the owner asked for first.`,
    });
  if (row.receiptKey !== null) return { _tag: "made" as const, key: row.receiptKey };
  const tapped =
    row.widgetId === null ? undefined : yield* cardAnswer(input.orgId, row.widgetId, row.owner);
  if (tapped === "no")
    return yield* refused(
      "The owner said no on this receipt's card, so nothing was recorded or numbered. Ask again only if they ask for it.",
    );
  if (tapped === undefined)
    return yield* refused(
      row.widgetId === null
        ? "Kin couldn't show the owner this receipt's card, so it can't be confirmed. Ask the owner to record the money themselves in Money; nothing was recorded."
        : "The owner hasn't tapped Confirm on this receipt's card yet; nothing was recorded or numbered. Wait for their tap; a typed yes doesn't confirm money.",
    );
  const request = Option.getOrUndefined(decodeRequest(row.json));
  if (request === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That receipt proposal can no longer be read; nothing was made.",
    });
  return { _tag: "confirmed" as const, request };
});

/** The receipt a confirmed proposal made, kept so asking again returns it. */
export const markReceiptMade = Effect.fn("KinReceipts.markMade")(function* (input: {
  readonly orgId: KinOrgId;
  readonly proposalId: string;
  readonly key: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_receipt_proposals SET receipt_key = ${input.key}, applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId} AND receipt_key IS NULL`;
});
