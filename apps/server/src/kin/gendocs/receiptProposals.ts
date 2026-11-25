// @effect-diagnostics nodeBuiltinImport:off -- a proposal's id is a hash of what it asks.
import * as NodeCrypto from "node:crypto";

import {
  KinChatError,
  KinDay,
  KinMoney,
  type KinOrgId,
  KinPersonId,
  formatKinWhen,
  KIN_TEXT_LOCALE,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinShell from "../shell/KinShell.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { dayIn, formatMoney } from "../work/money.ts";
import { endOfDay, ownerZone } from "../work/recordRows.ts";
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
  const sql = yield* SqlClient.SqlClient;
  const advance = request.advance;
  // Kin can't tell two advances apart: the same sum from the same client on the same day already
  // on the books is shown, and one recorded after the card was drawn makes its Confirm refuse.
  const sameAdvances =
    advance === undefined
      ? []
      : yield* sql<{ key: string; number: string | null }>`SELECT r.key, n.number
          FROM kin_records r
          LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
          LEFT JOIN kin_record_payments pay ON pay.org_id = r.org_id
            AND pay.payment_id = json_extract(r.fields_json, '$.payment')
          WHERE r.org_id = ${orgId} AND r.register_id = 'receipts' AND r.state <> 'dropped'
            AND r.party_id IS ${client?.recordId ?? null}
            AND r.amount_minor = ${advance.amount.minor} AND r.currency = ${advance.amount.currency}
            AND r.date_at = ${endOfDay(advance.receivedOn, zone)}
            AND (json_extract(r.fields_json, '$.payment') IS NULL
              OR (pay.payment_id IS NOT NULL AND pay.voided_at IS NULL))
          ORDER BY r.key`;
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
        : {
            key: against.key,
            title: against.title,
            rev: against.rev,
            paid: against.paid,
            total:
              against.amountMinor === null || against.currency === null
                ? null
                : { minor: against.amountMinor, currency: against.currency },
          },
    recorded: sameAdvances,
  };
});
export type Snapshot = Effect.Success<ReturnType<typeof snapshotOf>>;

// A calendar day has no zone: read at noon UTC it names the same day everywhere.
const dayText = (day: string) =>
  formatKinWhen(Date.parse(`${day}T12:00:00Z`), "dayYear", {
    zone: "UTC",
    locale: KIN_TEXT_LOCALE,
  });

/** The card's lines: figures from the records, the agent's own words labelled as its note. */
export const cardLines = (snapshot: Snapshot, request: ReceiptRequest) => {
  const note = [
    request.towards === undefined ? undefined : `towards ${request.towards}`,
    request.mode === undefined ? undefined : `by ${request.mode}`,
    request.reference === undefined ? undefined : `ref ${request.reference}`,
  ].filter((one) => one !== undefined);
  const against = snapshot.against;
  return [
    `Client: ${snapshot.client === null ? "none named" : snapshot.client.title}`,
    `Amount: ${snapshot.amount === null ? "none given" : formatMoney(snapshot.amount)}`,
    `Received on: ${snapshot.receivedOn === null ? "no day given" : dayText(snapshot.receivedOn)}`,
    ...(snapshot.recorded.length === 0 || snapshot.amount === null
      ? []
      : [
          `Already recorded: ${formatMoney(snapshot.amount)}${snapshot.client === null ? "" : ` from ${snapshot.client.title}`}${snapshot.receivedOn === null ? "" : ` on ${dayText(snapshot.receivedOn)}`} (${snapshot.recorded.map((one) => one.number ?? "receipt not numbered yet").join(", ")}). Confirm only if this is another payment.`,
        ]),
    `Set against: ${against === null ? "no invoice; it stays an advance" : against.title}`,
    ...(against?.total == null
      ? []
      : [
          `Already received on it: ${formatMoney({ minor: against.paid, currency: against.total.currency })} of ${formatMoney(against.total)}`,
        ]),
    ...(note.length === 0 ? [] : [`Agent's note: ${note.join(", ")}`]),
  ];
};

/** What the owner's Confirm did, in their words, for the answered card. */
const madeOutcome = (made: { readonly number: string | null }, shown: Snapshot) => {
  const money = shown.amount === null ? "The money" : formatMoney(shown.amount);
  const from = shown.client === null ? "" : ` from ${shown.client.title}`;
  const on = shown.receivedOn === null ? "" : `, received ${dayText(shown.receivedOn)}`;
  const where =
    shown.against === null ? "kept as an advance" : `set against ${shown.against.title}`;
  return {
    title: "Money recorded",
    text: `${money}${from}${on}, is recorded and ${where}. ${made.number === null ? "Its receipt is being numbered." : `Receipt ${made.number}; its PDF follows.`}`,
  };
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
    return { _tag: "declined" as const };
  }
  const request = Option.getOrUndefined(decodeRequest(row.json));
  if (request === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That receipt proposal can no longer be read; nothing was recorded.",
    });
  const shell = yield* KinShell.get(input.orgId);
  const section = !KinShell.sectionOn(shell, "money")
    ? "money"
    : request.against !== undefined && !KinShell.sectionOn(shell, "invoices")
      ? "invoices"
      : request.advance?.client !== undefined && !KinShell.sectionOn(shell, "clients")
        ? "clients"
        : undefined;
  if (section !== undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${KinShell.sectionName(shell, section)} is turned off for this company, so nothing was recorded. Turn it on in Settings › Sections and confirm again.`,
    });
  const shown = yield* snapshotOf(input.orgId, request);
  if (stableStringify(shown) !== row.snapshot)
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
  return { _tag: "made" as const, ...made, writer, personId, outcome: madeOutcome(made, shown) };
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
  const [row] = yield* sql<
    Pick<ProposalRow, "state" | "receiptKey"> & { readonly cardClosed: number }
  >`SELECT p.state, p.receipt_key AS "receiptKey",
      EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = p.org_id
        AND w.widget_id = p.widget_id AND w.closed_at IS NOT NULL) AS "cardClosed"
    FROM kin_receipt_proposals p
    WHERE p.org_id = ${input.orgId} AND p.proposal_id = ${input.proposalId}
      AND p.agent_id = ${input.agentId}`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No receipt proposal ${input.proposalId.slice(0, 40)} of yours. Call kin_receipt with what the owner asked for first.`,
    });
  if (row.state === "made" && row.receiptKey !== null) return row.receiptKey;
  return yield* refused(
    row.state === "declined"
      ? "The owner said no on this receipt's card, so nothing was recorded or numbered. Ask again only if they ask for it."
      : row.cardClosed === 1
        ? "This receipt's card closed before the owner answered it, because what it was about changed; nothing was recorded or numbered. Call kin_receipt again only if the owner still wants it."
        : "The owner hasn't tapped Confirm on this receipt's card yet; nothing was recorded or numbered. Kin records it the moment they do; a typed yes doesn't confirm money.",
  );
});
