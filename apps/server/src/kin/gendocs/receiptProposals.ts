// @effect-diagnostics nodeBuiltinImport:off -- a proposal's id is a hash of what it asks.
import * as NodeCrypto from "node:crypto";

import {
  KinChatError,
  KinDay,
  kinImpliedRate,
  KinMoney,
  kinRateShown,
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
import { billedParty } from "../work/billTo.ts";
import { parseFields } from "../work/lists.ts";
import { rateMoney } from "../work/statements/invoiceCredits.ts";
import { endOfDay, issuedNumber, ownerZone } from "../work/recordRows.ts";
import { recordReceipt, standing } from "./receipts.ts";

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
  /** An agent's payment_record: this payment on the invoice `key`, recorded by the tap alone. */
  received: Schema.optionalKey(
    Schema.Struct({
      key: Schema.String,
      amount: Schema.optionalKey(KinMoney),
      withheld: Schema.optionalKey(KinMoney),
      paidOn: KinDay,
      /** Cash that came in another currency; `amount` is what it settles, in the invoice's. */
      receivedAs: Schema.optionalKey(KinMoney),
      note: Schema.optionalKey(Schema.String),
      /** The owner said it is a second payment of the same amount on the same day. */
      another: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
  noBankEvidence: Schema.optionalKey(Schema.Literal(true)),
  /** An agent's payment_record void: the payment `paymentId` on `key` taken back by the tap. */
  takeBack: Schema.optionalKey(Schema.Struct({ key: Schema.String, paymentId: Schema.String })),
  towards: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  reference: Schema.optionalKey(Schema.String),
  /** Asked since cards name the payer by bill-to and the invoice by number; older cards don't. */
  version: Schema.optionalKey(Schema.Literal(2)),
});
export type ReceiptRequest = typeof ReceiptRequest.Type;
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ReceiptRequest));

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });

/**
 * Whether this exact payment is on the invoice already: on the same day, a live row of the same
 * amount for each part it has, cash and withheld, and none for a part it hasn't. Cash said as it
 * came in another currency matches only that sum received; a credit note's reduction is no part.
 */
export const samePayment = Effect.fn("KinReceipts.samePayment")(function* (
  orgId: KinOrgId,
  invoiceKey: string,
  received: {
    readonly amount?: KinMoney | undefined;
    readonly withheld?: KinMoney | undefined;
    readonly receivedAs?: KinMoney | undefined;
    readonly paidOn: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  if (received.amount === undefined && received.withheld === undefined) return false;
  const rows = yield* sql<{
    minor: number;
    currency: string;
    withheld: number;
    receivedMinor: number | null;
    receivedCurrency: string | null;
  }>`SELECT p.amount_minor AS minor, p.currency, p.withheld,
      p.received_minor AS "receivedMinor", p.received_currency AS "receivedCurrency"
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND r.key = ${invoiceKey} AND p.voided_at IS NULL
      AND p.paid_on = ${received.paidOn} AND p.origin_key NOT LIKE 'credit_note:%'`;
  const came = received.receivedAs;
  const matches = (money: KinMoney | undefined, withheld: number) => {
    const part = rows.filter((row) => row.withheld === withheld);
    return money === undefined
      ? part.length === 0
      : part.some(
          (row) =>
            row.minor === money.minor &&
            row.currency === money.currency &&
            (withheld === 1 ||
              came === undefined ||
              (row.receivedMinor === came.minor && row.receivedCurrency === came.currency)),
        );
  };
  return matches(received.amount, 0) && matches(received.withheld, 1);
});

/** What the card shows, from the records it names: compared again when the owner confirms. */
export const snapshotOf = Effect.fn("KinReceipts.snapshot")(function* (
  orgId: KinOrgId,
  request: ReceiptRequest,
) {
  const records = yield* KinRecords;
  const zone = yield* ownerZone(orgId);
  const entry = request.key === undefined ? undefined : yield* records.get(orgId, request.key);
  const received = request.received;
  const takeBack = request.takeBack;
  const invoiceKey = request.against ?? received?.key ?? takeBack?.key;
  const against = invoiceKey === undefined ? undefined : yield* records.get(orgId, invoiceKey);
  // A payment is from the invoice's client; an entry's from its own.
  const party = received === undefined && takeBack === undefined ? entry : against;
  const [taking] =
    takeBack === undefined || against === undefined
      ? []
      : yield* (yield* SqlClient.SqlClient)<{
          minor: number;
          currency: string;
          paidOn: string;
          withheld: number;
          voided: number;
        }>`SELECT amount_minor AS minor, currency, paid_on AS "paidOn", withheld,
            voided_at IS NOT NULL AS voided
          FROM kin_record_payments WHERE org_id = ${orgId}
            AND payment_id = ${takeBack.paymentId} AND record_id = ${against.recordId}`;
  const client =
    request.advance?.client !== undefined
      ? yield* records.get(orgId, request.advance.client)
      : party?.partyId == null
        ? undefined
        : yield* records.getById(orgId, party.partyId);
  const named = request.version === 2;
  // An advance set against an invoice is money already received there, moved, not new.
  const moved =
    named && entry !== undefined && request.against !== undefined
      ? (yield* standing(orgId, entry)) === "live"
      : false;
  // Moved, it keeps the day its money came in (`setAgainst`), which the card shows.
  const [movedDay] = moved
    ? yield* (yield* SqlClient.SqlClient)<{ paidOn: string }>`SELECT paid_on AS "paidOn"
        FROM kin_record_payments WHERE org_id = ${orgId}
          AND payment_id = ${String(parseFields(entry!.fieldsJson).payment)}`
    : [];
  // An invoice to a typed bill-to name with no client record is from that name.
  const billedTo =
    named && client === undefined && against !== undefined
      ? billedParty(against, undefined)?.name
      : undefined;
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
    received?.amount ??
    (entry?.amountMinor == null || entry.currency === null
      ? null
      : { minor: entry.amountMinor, currency: entry.currency });
  return {
    entry:
      entry === undefined
        ? null
        : { key: entry.key, rev: entry.rev, state: entry.state, ...(moved ? { moved } : {}) },
    client: client === undefined ? null : { key: client.key, title: client.title, rev: client.rev },
    amount,
    receivedOn:
      request.advance?.receivedOn ??
      received?.paidOn ??
      movedDay?.paidOn ??
      (entry?.dateAt == null ? null : dayIn(entry.dateAt, zone)),
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
            // Only a newer card names the invoice by number: older snapshots stay as stored.
            ...(named || received !== undefined
              ? {
                  name: issuedNumber(parseFields(against.fieldsJson).number).number ?? against.key,
                }
              : {}),
            // Tax withheld on it settles it but isn't money received: said apart on newer cards.
            ...(named && against.withheld > 0 ? { tax: against.withheld } : {}),
          },
    recorded: sameAdvances,
    ...(taking === undefined ? {} : { taking: { ...taking } }),
    ...(billedTo === undefined ? {} : { billedTo }),
    ...(received?.withheld === undefined ? {} : { withheld: received.withheld }),
    // Asked as another payment, the card says the same one is already there.
    ...(received?.another === true && (yield* samePayment(orgId, received.key, received))
      ? { twin: true }
      : {}),
  };
});
export type Snapshot = Effect.Success<ReturnType<typeof snapshotOf>>;

// A calendar day has no zone: read at noon UTC it names the same day everywhere.
export const dayText = (day: string) =>
  formatKinWhen(Date.parse(`${day}T12:00:00Z`), "dayYear", {
    zone: "UTC",
    locale: KIN_TEXT_LOCALE,
  });

/** What the invoice has already, labelled settled when that includes tax withheld. */
const alreadyOn = (against: NonNullable<Snapshot["against"]>) =>
  against.total === null
    ? []
    : [
        `Already ${"tax" in against ? "settled" : "received"} on it: ${formatMoney({ minor: against.paid, currency: against.total.currency })} of ${formatMoney(against.total)}`,
      ];

/** Who the money is from, as the card and its outcome name them. */
const payerOf = (snapshot: Snapshot) =>
  snapshot.client?.title ?? ("billedTo" in snapshot ? snapshot.billedTo : undefined);

const NO_BANK_EVIDENCE =
  "No bank statement or alert shows this money yet. This rests on what Kin was told.";

/** The card's lines: figures from the records, the agent's own words labelled as its note. */
export const cardLines = (snapshot: Snapshot, request: ReceiptRequest) => {
  const note = [
    request.towards === undefined ? undefined : `towards ${request.towards}`,
    request.mode === undefined ? undefined : `by ${request.mode}`,
    request.reference === undefined ? undefined : `ref ${request.reference}`,
  ].filter((one) => one !== undefined);
  const against = snapshot.against;
  if (request.received !== undefined)
    return paymentLines(snapshot, request.received, request.noBankEvidence === true);
  if (request.takeBack !== undefined) return takeBackLines(snapshot, request.takeBack.key);
  return [
    `Client: ${payerOf(snapshot) ?? "none named"}`,
    `Amount: ${snapshot.amount === null ? "none given" : formatMoney(snapshot.amount)}`,
    `Received on: ${snapshot.receivedOn === null ? "no day given" : dayText(snapshot.receivedOn)}`,
    ...(snapshot.recorded.length === 0 || snapshot.amount === null
      ? []
      : [
          `Already recorded: ${formatMoney(snapshot.amount)}${snapshot.client === null ? "" : ` from ${snapshot.client.title}`}${snapshot.receivedOn === null ? "" : ` on ${dayText(snapshot.receivedOn)}`} (${snapshot.recorded.map((one) => one.number ?? "receipt not numbered yet").join(", ")}). Confirm only if this is another payment.`,
        ]),
    `Set against: ${against === null ? "no invoice; it stays an advance" : "name" in against ? `${against.name}, ${against.title}` : against.title}`,
    ...(against === null ? [] : alreadyOn(against)),
    ...(snapshot.entry !== null && "moved" in snapshot.entry
      ? ["Already recorded as received; Confirm sets it against this invoice."]
      : []),
    ...(note.length === 0 ? [] : [`Agent's note: ${note.join(", ")}`]),
  ];
};

type Received = NonNullable<ReceiptRequest["received"]>;

/** What stays owed on the invoice once this payment is recorded; undefined with no amount. */
const owedAfter = (snapshot: Snapshot, received: Received) => {
  const total = snapshot.against?.total;
  if (total == null) return undefined;
  const settles = (received.amount?.minor ?? 0) + (received.withheld?.minor ?? 0);
  return { minor: total.minor - snapshot.against!.paid - settles, currency: total.currency };
};

/** A payment's card: who paid, how much in which currency, the day and the invoice, from Kin. */
const paymentLines = (snapshot: Snapshot, received: Received, noBankEvidence: boolean) => {
  const against = snapshot.against;
  const left = owedAfter(snapshot, received);
  return [
    `Client: ${payerOf(snapshot) ?? "none named"}`,
    `Received: ${
      received.amount === undefined
        ? "nothing in cash"
        : received.receivedAs === undefined
          ? formatMoney(received.amount)
          : `${rateMoney(received.receivedAs)} for ${rateMoney(received.amount)}, a rate of ${kinRateShown(kinImpliedRate(received.amount, received.receivedAs))}`
    }`,
    ...(received.withheld === undefined
      ? []
      : [`Tax the client withheld: ${formatMoney(received.withheld)}`]),
    `Received on: ${dayText(received.paidOn)}`,
    `Invoice: ${against === null ? received.key : `${against.name ?? against.key}, ${against.title}`}`,
    ...(against === null ? [] : alreadyOn(against)),
    ...(left === undefined
      ? []
      : [
          left.minor <= 0
            ? "It settles the invoice in full"
            : `Still owed after: ${formatMoney(left)}`,
        ]),
    ...("twin" in snapshot
      ? [
          "A payment of the same amount on the same day is already recorded on it; Confirm adds a second one.",
        ]
      : []),
    ...(noBankEvidence ? [NO_BANK_EVIDENCE] : []),
    ...(received.note === undefined ? [] : [`Agent's note: ${received.note}`]),
  ];
};

type Taking = {
  readonly minor: number;
  readonly currency: string;
  readonly paidOn: string;
  readonly withheld: number;
};
const takingOf = (snapshot: Snapshot): Taking | undefined =>
  "taking" in snapshot ? snapshot.taking : undefined;

/** The question on a card that takes a payment back. */
export const takeBackQuestion = (snapshot: Snapshot, key: string) => {
  const taking = takingOf(snapshot);
  const name = snapshot.against?.name ?? key;
  if (taking === undefined) return `Take back this payment on ${name}?`;
  return `Take back the ${taking.withheld === 1 ? "tax withheld" : "payment"} of ${formatMoney(taking)} on ${dayText(taking.paidOn)} from ${name}?`;
};

/** A take-back card: the payment, the invoice, and what stays owed once it is taken back. */
const takeBackLines = (snapshot: Snapshot, key: string) => {
  const against = snapshot.against;
  const taking = takingOf(snapshot);
  const total = against?.total ?? null;
  return [
    `Client: ${payerOf(snapshot) ?? "none named"}`,
    ...(taking === undefined
      ? []
      : [
          taking.withheld === 1
            ? `Tax the client withheld: ${formatMoney(taking)} on ${dayText(taking.paidOn)}`
            : `Payment: ${formatMoney(taking)} received on ${dayText(taking.paidOn)}`,
        ]),
    `Invoice: ${against === null ? key : `${against.name ?? against.key}, ${against.title}`}`,
    ...(against === null || total === null
      ? []
      : [
          `${"tax" in against ? "Settled" : "Received"} on it now: ${formatMoney({ minor: against.paid, currency: total.currency })} of ${formatMoney(total)}`,
          ...(taking === undefined
            ? []
            : [
                `Owed after: ${formatMoney({ minor: total.minor - against.paid + taking.minor, currency: total.currency })}`,
              ]),
        ]),
  ];
};

/** What the owner's Confirm did, in their words, for the answered card. */
const madeOutcome = (made: { readonly number: string | null }, shown: Snapshot) => {
  const money = shown.amount === null ? "The money" : formatMoney(shown.amount);
  const payer = payerOf(shown);
  const from = payer === undefined ? "" : ` from ${payer}`;
  const on = shown.receivedOn === null ? "" : `, received ${dayText(shown.receivedOn)}`;
  const target =
    shown.against === null
      ? undefined
      : "name" in shown.against
        ? `${shown.against.name}, ${shown.against.title}`
        : shown.against.title;
  const receipt =
    made.number === null
      ? "Its receipt is being numbered."
      : `Receipt ${made.number}; its PDF follows.`;
  if (target !== undefined && shown.entry !== null && "moved" in shown.entry)
    return {
      title: "Advance set against the invoice",
      text: `${money}${from}${on}, already received as an advance, is set against ${target}; no new money was recorded. ${receipt}`,
    };
  const where = target === undefined ? "kept as an advance" : `set against ${target}`;
  return {
    title: "Money recorded",
    text: `${money}${from}${on}, is recorded and ${where}. ${receipt}`,
  };
};

/** What the owner's Confirm on a take-back card did. */
const takenOutcome = (shown: Snapshot, key: string) => {
  const taking = takingOf(shown);
  const total = shown.against?.total ?? null;
  const name = shown.against?.name ?? key;
  return {
    title: "Payment taken back",
    text: `${taking === undefined ? "The payment" : `${formatMoney(taking)} received ${dayText(taking.paidOn)}`} is taken back from ${name}${
      total === null || taking === undefined || shown.against === null
        ? ""
        : `; ${formatMoney({ minor: total.minor - shown.against.paid + taking.minor, currency: total.currency })} is owed on it now`
    }.`,
  };
};

/** What the owner's Confirm on a payment's card recorded. */
const paidOutcome = (shown: Snapshot, received: Received) => {
  const parts = [
    ...(received.amount === undefined
      ? []
      : [
          received.receivedAs === undefined
            ? formatMoney(received.amount)
            : `${formatMoney(received.amount)} (${rateMoney(received.receivedAs)} received, a rate of ${kinRateShown(kinImpliedRate(received.amount, received.receivedAs))})`,
        ]),
    ...(received.withheld === undefined
      ? []
      : [`${formatMoney(received.withheld)} of tax the client withheld`]),
  ].join(" and ");
  const payer = payerOf(shown);
  const from = payer === undefined ? "" : ` from ${payer}`;
  const left = owedAfter(shown, received);
  return {
    title: "Payment recorded",
    text: `Recorded ${parts}${from}, received ${dayText(received.paidOn)}, on ${shown.against?.name ?? received.key}; ${
      left === undefined || left.minor <= 0
        ? "the invoice is paid in full"
        : `${formatMoney(left)} is still owed on it`
    }.`,
  };
};

/**
 * Stores the request and its card's figures. The same ask on the same figures is one proposal;
 * a payment's same ask in the same turn is one whatever the figures.
 */
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
  const { noBankEvidence: _noBankEvidence, ...identity } = input.request;
  const json = stableStringify(input.request);
  const snapshot = stableStringify(input.snapshot);
  // A payment's ask in one turn is one card whatever its figures do; its first snapshot stands.
  const figures =
    input.request.received === undefined && input.request.takeBack === undefined ? snapshot : "";
  const proposalId = `rp_${NodeCrypto.createHash("sha256")
    .update(
      `${input.orgId.length}:${input.orgId}${input.agentId}:${input.wakeupId}:${stableStringify(identity)}:${figures}`,
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
  const request = Option.getOrUndefined(decodeRequest(row.json));
  if (!input.confirmed) {
    yield* decide("declined", null);
    return {
      _tag: "declined" as const,
      outcome:
        request?.takeBack === undefined
          ? { title: "Not recorded", text: "You said no, so nothing was recorded or numbered." }
          : { title: "Not taken back", text: "You said no, so the payment stays recorded." },
    };
  }
  if (request === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That receipt proposal can no longer be read; nothing was recorded.",
    });
  const shell = yield* KinShell.get(input.orgId);
  const section = !KinShell.sectionOn(shell, "money")
    ? "money"
    : (request.against ?? request.received ?? request.takeBack) !== undefined &&
        !KinShell.sectionOn(shell, "invoices")
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
  const takeBack = request.takeBack;
  if (takeBack !== undefined) {
    yield* (yield* KinRecords).voidPayment(input.orgId, writer, takeBack.key, takeBack.paymentId);
    yield* decide("made", null);
    return { _tag: "takenBack" as const, outcome: takenOutcome(shown, takeBack.key) };
  }
  const received = request.received;
  if (received !== undefined) {
    const records = yield* KinRecords;
    const pay = (money: KinMoney | undefined, part: "cash" | "tds") =>
      money === undefined
        ? Effect.undefined
        : records
            .pay(input.orgId, writer, received.key, {
              amount: money,
              ...(part === "cash" && received.receivedAs !== undefined
                ? {
                    received: received.receivedAs,
                    rate: kinImpliedRate(money, received.receivedAs),
                  }
                : {}),
              paidOn: received.paidOn,
              ...(received.note === undefined ? {} : { note: received.note }),
              ...(part === "tds" ? { withheld: true } : {}),
              originKey: `receipt-proposal:${row.proposalId}:${part}`,
            })
            .pipe(Effect.map((paid) => paid.paymentId));
    const cash = yield* pay(received.amount, "cash");
    const tds = yield* pay(received.withheld, "tds");
    yield* decide("made", null);
    return {
      _tag: "paid" as const,
      paymentId: cash ?? tds,
      tdsPaymentId: tds,
      outcome: paidOutcome(shown, received),
    };
  }
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
    Pick<ProposalRow, "state" | "receiptKey" | "json"> & { readonly cardClosed: number }
  >`SELECT p.state, p.receipt_key AS "receiptKey", p.request_json AS json,
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
  const asked = Option.getOrUndefined(decodeRequest(row.json));
  if (row.state === "made" && asked?.takeBack !== undefined)
    return yield* refused(
      "The owner confirmed taking this payment back on its card, so Kin took it back; there is no receipt to read.",
    );
  const received = asked?.received;
  if (row.state === "made" && received !== undefined && received.amount === undefined)
    return yield* refused(
      "The owner confirmed this tax the client withheld on its card, so Kin recorded it. Tax withheld isn't money received, so it gets no receipt.",
    );
  if (row.state === "made")
    return yield* refused(
      "The owner confirmed this payment on its card, so Kin recorded it; it has no receipt. For one, call kin_receipt with its paymentId from record_get.",
    );
  return yield* refused(
    row.state === "declined"
      ? "The owner said no on this receipt's card, so nothing was recorded or numbered. Ask again only if they ask for it."
      : row.cardClosed === 1
        ? "This receipt's card closed before the owner answered it, because what it was about changed; nothing was recorded or numbered. Call kin_receipt again only if the owner still wants it."
        : "The owner hasn't tapped Confirm on this receipt's card yet; nothing was recorded or numbered. Kin records it the moment they do; a typed yes doesn't confirm money.",
  );
});
