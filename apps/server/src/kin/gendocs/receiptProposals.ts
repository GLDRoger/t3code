// @effect-diagnostics nodeBuiltinImport:off -- a proposal's id is a hash of what it asks.
import * as NodeCrypto from "node:crypto";

import { KinChatError, KinDay, KinMoney, type KinOrgId, KinPersonId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { dayIn, formatMoney } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { recordReceipt } from "./receipts.ts";

/**
 * An agent's receipt that would record money received waits here, as asked, with the figures its
 * card showed. The owner's tap on Confirm records it, in the tap's own transaction, only while
 * those figures still stand; changed arguments are a new proposal and a new card.
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
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ReceiptRequest));

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });

/** What the card shows, from the records it names: compared again when the owner confirms. */
export const snapshotOf = Effect.fn("KinReceipts.snapshot")(function* (
  orgId: KinOrgId,
  request: ReceiptRequest,
) {
  const records = yield* KinRecords;
  const zone = yield* ownerZone(orgId);
  const entry = request.key === undefined ? undefined : yield* records.get(orgId, request.key);
  const client =
    request.advance?.client !== undefined
      ? yield* records.get(orgId, request.advance.client)
      : entry?.partyId == null
        ? undefined
        : yield* records.getById(orgId, entry.partyId);
  const against =
    request.against === undefined ? undefined : yield* records.get(orgId, request.against);
  const amount =
    request.advance?.amount ??
    (entry?.amountMinor == null || entry.currency === null
      ? null
      : { minor: entry.amountMinor, currency: entry.currency });
  return {
    entry: entry === undefined ? null : { key: entry.key, rev: entry.rev, state: entry.state },
    client: client === undefined ? null : { key: client.key, title: client.title, rev: client.rev },
    amount,
    receivedOn:
      request.advance?.receivedOn ?? (entry?.dateAt == null ? null : dayIn(entry.dateAt, zone)),
    against:
      against === undefined
        ? null
        : { key: against.key, title: against.title, rev: against.rev, paid: against.paid },
  };
});
export type Snapshot = Effect.Success<ReturnType<typeof snapshotOf>>;

/** The card's lines: figures from the records, the agent's own words labelled as its note. */
export const cardLines = (snapshot: Snapshot, request: ReceiptRequest) => {
  const note = [
    request.towards === undefined ? undefined : `towards ${request.towards}`,
    request.mode === undefined ? undefined : `by ${request.mode}`,
    request.reference === undefined ? undefined : `ref ${request.reference}`,
  ].filter((one) => one !== undefined);
  return [
    `Client: ${snapshot.client === null ? "none named" : `${snapshot.client.title} (${snapshot.client.key})`}`,
    `Amount: ${snapshot.amount === null ? "none given" : formatMoney(snapshot.amount)}`,
    `Received on: ${snapshot.receivedOn ?? "no day given"}`,
    ...(snapshot.entry === null ? [] : [`Receipt entry: ${snapshot.entry.key}`]),
    `Set against: ${snapshot.against === null ? "no invoice; it stays an advance" : `${snapshot.against.title} (${snapshot.against.key})`}`,
    ...(note.length === 0 ? [] : [`Agent's note: ${note.join(", ")}`]),
  ];
};

/** Stores the request and its card's figures. The same ask on the same figures is one proposal. */
export const proposeReceipt = Effect.fn("KinReceipts.propose")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly chatId: string;
  readonly request: ReceiptRequest;
  readonly snapshot: Snapshot;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const json = stableStringify(input.request);
  const snapshot = stableStringify(input.snapshot);
  const proposalId = `rp_${NodeCrypto.createHash("sha256")
    .update(
      `${input.orgId.length}:${input.orgId}${input.agentId}:${input.wakeupId}:${json}:${snapshot}`,
    )
    .digest("hex")
    .slice(0, 16)}`;
  yield* sql`INSERT INTO kin_receipt_proposals (org_id, proposal_id, agent_id, wakeup_id, chat_id,
      request_json, snapshot_json, proposed_at)
    VALUES (${input.orgId}, ${proposalId}, ${input.agentId}, ${input.wakeupId}, ${input.chatId},
      ${json}, ${snapshot}, ${input.now})
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

type ProposalRow = {
  readonly proposalId: string;
  readonly json: string;
  readonly snapshot: string;
  readonly state: "open" | "made" | "declined";
  readonly receiptKey: string | null;
};

/**
 * The owner's answer on a receipt card. A tap on Confirm records exactly what the card showed,
 * once, and is refused when those figures changed since; Cancel ends it. Returns the receipt to
 * make the PDF of after the tap commits. Any other card is not this one's business.
 */
export const answerReceiptCard = Effect.fn("KinReceipts.answerCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<ProposalRow>`SELECT p.proposal_id AS "proposalId",
      p.request_json AS json, p.snapshot_json AS snapshot, p.state, p.receipt_key AS "receiptKey"
    FROM kin_receipt_proposals p
    WHERE p.org_id = ${input.orgId} AND p.widget_id = ${input.widgetId}`;
  if (row === undefined) return undefined;
  if (!(yield* ownerLevel(input.orgId, KinPersonId.make(input.personId))))
    return yield* refused("Only the owner or a co-owner confirms money received.");
  if (input.via === "reaction")
    return yield* refused("Tap Confirm or Cancel on the card to answer a receipt.");
  if (row.state !== "open")
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This receipt was already answered.",
    });
  const decide = (state: "made" | "declined", key: string | null) =>
    sql`UPDATE kin_receipt_proposals SET state = ${state}, receipt_key = ${key},
        decided_at = ${input.now}
      WHERE org_id = ${input.orgId} AND proposal_id = ${row.proposalId}`;
  if (!input.confirmed) {
    yield* decide("declined", null);
    return undefined;
  }
  const request = Option.getOrUndefined(decodeRequest(row.json));
  if (request === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That receipt proposal can no longer be read; nothing was recorded.",
    });
  if (stableStringify(yield* snapshotOf(input.orgId, request)) !== row.snapshot)
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "The figures changed since this card was made, so nothing was recorded. Tap Cancel and ask Kin again for a fresh card.",
    });
  const personId = KinPersonId.make(input.personId);
  const writer: Writer = { actor: { _tag: "person", personId }, via: "owner", askedBy: personId };
  const made = yield* recordReceipt({
    orgId: input.orgId,
    writer,
    paymentId: request.paymentId,
    key: request.key,
    advance:
      request.advance === undefined
        ? undefined
        : {
            client: request.advance.client,
            amount: request.advance.amount,
            receivedOn: request.advance.receivedOn,
            originKey: `receipt:advance:proposal:${row.proposalId}`,
          },
    against: request.against,
    extras: { towards: request.towards, mode: request.mode, reference: request.reference },
  });
  yield* decide("made", made.key);
  return { ...made, writer, personId };
});

/**
 * What became of an agent's own proposal, for its later turn: the receipt the owner's Confirm
 * made, else why there is none yet.
 */
export const proposalOutcome = Effect.fn("KinReceipts.outcome")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly proposalId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Pick<ProposalRow, "state" | "receiptKey">>`SELECT state,
      receipt_key AS "receiptKey" FROM kin_receipt_proposals
    WHERE org_id = ${input.orgId} AND proposal_id = ${input.proposalId}
      AND agent_id = ${input.agentId}`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No receipt proposal ${input.proposalId.slice(0, 40)} of yours. Call kin_receipt with what the owner asked for first.`,
    });
  if (row.state === "made" && row.receiptKey !== null) return row.receiptKey;
  return yield* refused(
    row.state === "declined"
      ? "The owner said no on this receipt's card, so nothing was recorded or numbered. Ask again only if they ask for it."
      : "The owner hasn't tapped Confirm on this receipt's card yet; nothing was recorded or numbered. Kin records it the moment they do; a typed yes doesn't confirm money.",
  );
});
