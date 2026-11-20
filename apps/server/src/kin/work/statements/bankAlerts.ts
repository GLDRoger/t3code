// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinChatError,
  KinChoiceCardState,
  type KinChoiceOutcome,
  type KinOrgId,
  KinPersonId,
  kinWhenFormat,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import type { KinAlertMessage } from "../../connections/ConnectionsService.ts";
import { oneMailbox } from "../../connections/MailAuth.ts";
import { liveLead } from "../../lead/orgLeads.ts";
import { ownerLevel } from "../../people/KinAccess.ts";
import { choiceCardState } from "../../widgets/choiceCard.ts";
import { homeCurrency, textLocale } from "../companyProfile.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { dayIn, formatMoney } from "../money.ts";
import { countedPayment, ownerZone } from "../recordRows.ts";
import {
  type AlertMail,
  type AlertRead,
  type AlertReason,
  alertSigns,
  cutQuoted,
  isReplyOrForward,
  judgeAlert,
  readAlertText,
} from "./alertText.ts";
import { isAlertCard, PAY_CARD, SENDER_CARD } from "./alertCards.ts";
import { connectedNow } from "./alertSql.ts";
import { bankKey } from "./bankAccounts.ts";
import { type BankCoverage, bankCoverage } from "./bankKnown.ts";
import { nameIn } from "./statementMatch.ts";
import { postCard, updateCard } from "./statementReview.ts";

/**
 * Bank alerts by mail: a mail counts only from an owner-made approval, vouched for by the
 * mailbox's own service, and read true to its own text. It never records money: one card asks,
 * the owner's tap records. Once a confirmed statement covers its day, the statement is the evidence.
 */

/** A connected mailbox's new mail as the poll holds it: its headers and the vendor's first lines. */
export type AlertCandidate = {
  readonly connectionId: string;
  /** The mailbox's own address. */
  readonly mailbox: string | null;
  readonly threadId: string;
  readonly from: string | null;
  readonly subject: string;
  readonly preview: string;
  readonly date: string | null;
};

/** The one read of mail bodies: a counted sender's own messages since its cursor, nobody else's. */
export type AlertMailbox = (
  orgId: KinOrgId,
  connectionId: string,
  query: { readonly address: string; readonly since: number; readonly max: number },
) => Effect.Effect<
  {
    readonly messages: ReadonlyArray<KinAlertMessage>;
    readonly through: number | null;
    readonly more: boolean;
  },
  KinChatError
>;

const COUNT = "Yes, count these";
const DONT = "No";
const NONE_OF_THESE = "None of these";
const OTHER = "No, it's something else";
const UNSURE = "Not sure yet";
const ASKS_PER_POLL = 3;
/** One sender's messages read per poll; the rest wait for the next. */
const MESSAGES_PER_POLL = 20;
const INVOICES_ON_A_CARD = 3;
const DAY_MS = 86_400_000;
/** On a Yes, the sender's mail is read from this far back. */
export const LOOKBACK_MS = 7 * DAY_MS;
/** What a reader may see of one alert: its subject and its own words, cut. */
const ALERT_TEXT_CHARS = 2_000;

const hash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
const notAllowed = (message: string) => new KinChatError({ reason: "not_allowed", message });
const changed = (message: string) => new KinChatError({ reason: "widget_changed", message });
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** A day as the screens write it ("18 Nov", with its year when it isn't this one), in the company's words. */
const alertDayText = Effect.fn("KinBankAlerts.dayText")(function* (
  orgId: KinOrgId,
  day: string,
  now: number,
) {
  const locale = yield* textLocale(orgId);
  const thisYear = dayIn(now, yield* ownerZone(orgId)).slice(0, 4);
  return kinWhenFormat(day.slice(0, 4) === thisYear ? "date" : "dateYear", {
    zone: "UTC",
    locale,
  }).format(Date.parse(`${day}T12:00:00Z`));
});

export type Approval = {
  readonly senderId: string;
  readonly connectionId: string;
  readonly address: string;
  readonly account: string;
  readonly currency: string;
  readonly state: "asked" | "counted" | "declined" | "stopped";
  readonly bound: "open" | "bound" | "none";
  readonly boundBank: string | null;
  readonly sinceAt: number | null;
  readonly cursorAt: number | null;
};
const APPROVAL = (sql: SqlClient.SqlClient) => sql`sender_id AS "senderId",
  connection_id AS "connectionId", address, account, currency, state, bound,
  bound_bank AS "boundBank", since_at AS "sinceAt", cursor_at AS "cursorAt"`;

const approvalsOf = Effect.fn("KinBankAlerts.approvals")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Approval>`SELECT ${APPROVAL(sql)} FROM kin_bank_alert_senders
    WHERE org_id = ${orgId} ORDER BY connection_id, address, account, currency`;
});

/** Whether a statement account (its folded bank) is the one an approval is bound to. */
const sameBank = (a: string, b: string) => a === "" || b === "" || a === b;

/** Whether a confirmed statement of the approval's bound account covers `day`. */
const coveredFor =
  (
    spans: ReadonlyArray<BankCoverage>,
    approval: Pick<Approval, "account" | "currency" | "bound" | "boundBank">,
  ) =>
  (day: string) =>
    approval.bound === "bound" &&
    spans.some(
      (span) =>
        span.digits === approval.account &&
        span.currency === approval.currency &&
        sameBank(bankKey(span.bank ?? null), approval.boundBank ?? "") &&
        span.from <= day &&
        day <= span.through,
    );

/** The confirmed statements' accounts with these digits and currency, one per bank. */
const accountsFor = (spans: ReadonlyArray<BankCoverage>, account: string, currency: string) => {
  const found = new Map<string, string>();
  for (const span of spans)
    if (span.digits === account && span.currency === currency && !found.has(span.account))
      found.set(span.account, span.bank ?? "");
  const banks = new Map<string, string>();
  for (const bank of found.values()) banks.set(bankKey(bank), bank);
  return [...banks].map(([key, name]) => ({ key, name }));
};

/**
 * What the poll found, as the bank alert rules see it, after the mail watches matched it: mail
 * from an address no approval counts that looks like an alert gets one card asking about it, from
 * its summary alone. Each counted sender's own mail is then read from its own cursor.
 */
export const noticeAlerts = Effect.fn("KinBankAlerts.notice")(function* (
  orgId: KinOrgId,
  mail: ReadonlyArray<AlertCandidate>,
  now: number,
  mailbox: AlertMailbox | undefined,
) {
  const approvals = yield* approvalsOf(orgId);
  const home = yield* homeCurrency(orgId);
  const asked = { count: 0 };
  for (const one of mail) {
    const address = oneMailbox(one.from);
    if (address === undefined || asked.count >= ASKS_PER_POLL) continue;
    const mine = approvals.filter(
      (approval) => approval.connectionId === one.connectionId && approval.address === address,
    );
    if (mine.some((approval) => approval.state === "counted")) continue;
    if (isReplyOrForward({ subject: one.subject })) continue;
    if (one.mailbox !== null && domainOf(one.mailbox) === domainOf(address)) continue;
    const signs = alertSigns(`${one.subject}\n${one.preview}`, home);
    if (signs === undefined) continue;
    if (
      yield* askSender(orgId, one.connectionId, address, signs.account, signs.amount.currency, now)
    )
      asked.count += 1;
  }
  let read = false;
  if (mailbox !== undefined) {
    const addresses = new Map<string, { connectionId: string; address: string }>();
    for (const approval of approvals)
      if (approval.state === "counted")
        addresses.set(`${approval.connectionId}\u0000${approval.address}`, approval);
    for (const { connectionId, address } of addresses.values())
      read =
        (yield* readSender(orgId, connectionId, address, now, mailbox, asked).pipe(
          // One slow mailbox never holds up the next sender or the next company's poll.
          Effect.timeout("60 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't read a bank sender's alerts", { orgId, cause }).pipe(
              Effect.as(false),
            ),
          ),
        )) || read;
  }
  if (asked.count > 0) yield* (yield* KinRefreshObserver).touch(orgId, "connections");
  if (read) yield* (yield* KinRefreshObserver).touch(orgId, "moneyStatements");
});

const SenderChoices = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
);
const encodeChoices = Schema.encodeSync(SenderChoices);
const decodeChoices = Schema.decodeOption(SenderChoices);

/**
 * One card per mailbox, sender, account and currency (and again only after Ask me again):
 * nothing counts before its Yes. When confirmed statements hold several accounts with these
 * digits and currency, the card asks which.
 */
const askSender = Effect.fn("KinBankAlerts.askSender")(function* (
  orgId: KinOrgId,
  connectionId: string,
  address: string,
  account: string,
  currency: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* liveLead(sql, orgId, { prefer: "finance" });
  if (lead === undefined) return false;
  const [mailbox] = yield* sql<{ label: string }>`SELECT COALESCE(account_label, label) AS label
    FROM kin_connections WHERE org_id = ${orgId} AND connection_id = ${connectionId}`;
  const choices = accountsFor(yield* bankCoverage(orgId), account, currency);
  const senderId = `bs_${hash(`${orgId}\u0000${connectionId}\u0000${address}\u0000${account}\u0000${currency}`)}`;
  const widgetId = `${SENDER_CARD}${hash(`${senderId}\u0000${now}`)}`;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const made = yield* sql<{ senderId: string }>`INSERT INTO kin_bank_alert_senders
          (org_id, sender_id, connection_id, address, account, currency, state, widget_id,
            choices_json, asked_at)
        VALUES (${orgId}, ${senderId}, ${connectionId}, ${address}, ${account}, ${currency},
          'asked', ${widgetId}, ${choices.length === 0 ? null : encodeChoices(choices)}, ${now})
        ON CONFLICT DO NOTHING RETURNING sender_id AS "senderId"`;
      if (made.length === 0) return false;
      const one = choices.length === 1 ? choices[0]! : undefined;
      const named =
        one === undefined ? "account" : `${one.name === "" ? "" : `${one.name} `}account`;
      const question =
        choices.length > 1
          ? `Is ${address} your bank's alerts for one of these accounts ••${account}?`
          : `Is ${address} your bank's alerts for your ${named} ••${account}?`;
      const detail = `${mailbox?.label ?? "Your mailbox"} gets mail from ${address} for ${currency} account ••${account}. Kin counts its alerts only after you say yes, and only mail that passes your mailbox's sender checks. Nothing is recorded as paid until you say so.${choices.length > 1 ? " None of these counts them as another account." : ""}`;
      yield* postCard({
        orgId,
        chatId: lead.ownerChatId,
        agentId: lead.agentId,
        widgetId,
        type: "choice",
        text: question,
        state: choiceCardState({
          question,
          detail,
          options:
            choices.length > 1
              ? [
                  ...choices.slice(0, 5).map((choice) => ({
                    label:
                      `Yes, ${choice.name === "" ? "Account" : choice.name} ••${account}`.slice(
                        0,
                        80,
                      ),
                  })),
                  { label: NONE_OF_THESE },
                  { label: DONT },
                ]
              : [{ label: COUNT }, { label: DONT }],
          untilAnswered: true,
        }),
      });
      return true;
    }),
  );
});

export type Row = {
  readonly alertId: string;
  readonly connectionId: string;
  readonly messageId: string;
  readonly address: string;
  readonly subject: string;
  readonly receivedAt: number;
};

/**
 * A counted sender's own mail since its cursor, a page per poll, each message once. A provider
 * error leaves the cursor where it was. Returns whether any row was kept.
 */
const readSender = Effect.fn("KinBankAlerts.readSender")(function* (
  orgId: KinOrgId,
  connectionId: string,
  address: string,
  now: number,
  mailbox: AlertMailbox,
  asked: { count: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const counted = (yield* approvalsOf(orgId)).filter(
    (one) =>
      one.connectionId === connectionId && one.address === address && one.state === "counted",
  );
  const since = Math.min(...counted.map((one) => one.cursorAt ?? now));
  if (counted.length === 0) return false;
  const page = yield* mailbox(orgId, connectionId, { address, since, max: MESSAGES_PER_POLL });
  let kept = false;
  for (const message of page.messages)
    kept = (yield* readMessage(orgId, connectionId, address, message, now, asked)) || kept;
  // Just past the newest looked at, so the next read never fetches that message's body again.
  if (page.through !== null)
    yield* sql`UPDATE kin_bank_alert_senders SET cursor_at = MAX(cursor_at, ${page.through + 1})
      WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND address = ${address}
        AND state = 'counted'`;
  return kept;
});

/** One message of a counted sender: kept counted, unread for a reader, or not counted with why. */
const readMessage = Effect.fn("KinBankAlerts.readMessage")(function* (
  orgId: KinOrgId,
  connectionId: string,
  address: string,
  message: KinAlertMessage,
  now: number,
  asked: { count: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const messageId = message.messageId.slice(0, 400);
  const [stored] = yield* sql<{ alertId: string; state: string }>`SELECT alert_id AS "alertId",
      state FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND message_id = ${messageId}`;
  // A copy kept not counted doesn't block a later read that counts it.
  if (stored !== undefined && stored.state !== "not_counted") return false;
  const row: Row = {
    alertId: stored?.alertId ?? `ba_${hash(`${orgId}\u0000${connectionId}\u0000${messageId}`)}`,
    connectionId,
    messageId,
    address,
    subject: message.subject.slice(0, 300),
    receivedAt: message.receivedAt ?? now,
  };
  if (message.sender.address !== address)
    return yield* keep(orgId, row, { state: "not_counted", reason: "not_checked" }, now);
  if (message.sender.verdict !== "passed")
    return yield* keep(
      orgId,
      row,
      {
        state: "not_counted",
        reason: message.sender.verdict === "failed" ? "failed_check" : "not_checked",
      },
      now,
    );
  if (isReplyOrForward(message))
    return yield* keep(orgId, row, { state: "not_counted", reason: "reply" }, now);
  const text = cutQuoted(message.text).slice(0, ALERT_TEXT_CHARS);
  const zone = yield* ownerZone(orgId);
  const said: AlertMail = {
    subject: message.subject,
    text,
    mailDay: dayIn(row.receivedAt, zone),
    home: yield* homeCurrency(orgId),
  };
  const fields = readAlertText(said);
  if (fields === undefined)
    return yield* keep(orgId, row, { state: "unread", text: `${message.subject}\n${text}` }, now);
  return yield* settleReading(orgId, row, fields, `${message.subject}\n${text}`, now, asked);
});

/**
 * A reading of one alert, from either reader, judged by the same checks: an approval for its
 * account and currency that counts now, the mail's own text, its day, coverage and repeats.
 * In one transaction with the write, so a Stop that landed while it was read is seen.
 */
export const settleReading = Effect.fn("KinBankAlerts.settleReading")(function* (
  orgId: KinOrgId,
  row: Row,
  fields: AlertRead,
  text: string,
  now: number,
  asked: { count: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const spans = yield* bankCoverage(orgId);
  const outcome = yield* sql.withTransaction(
    Effect.gen(function* () {
      const mine = (yield* approvalsOf(orgId)).filter(
        (one) => one.connectionId === row.connectionId && one.address === row.address,
      );
      const approval = mine.find(
        (one) => one.account === fields.account && one.currency === fields.currency,
      );
      const counting = approval?.state === "counted" ? approval : undefined;
      const reason: AlertReason | undefined =
        approval !== undefined && approval.state !== "counted"
          ? "stopped"
          : counting === undefined
            ? mine.some((one) => one.account === fields.account && one.state === "counted")
              ? "other_currency"
              : "other_account"
            : (judgeAlert(
                fields,
                { text },
                {
                  account: counting.account,
                  currency: counting.currency,
                  today: dayIn(now, zone),
                  since: dayIn(counting.sinceAt ?? now, zone),
                  covered: coveredFor(spans, counting),
                },
              ) ?? (yield* repeated(orgId, counting.senderId, fields)));
      const made = yield* keep(
        orgId,
        row,
        reason === undefined
          ? { state: "counted", senderId: counting!.senderId, fields }
          : { state: "not_counted", reason, fields },
        now,
      );
      return { made, reason, approval };
    }),
  );
  // An address counted for one account that mails about another gets its own card for that one.
  if (
    outcome.reason === "other_account" &&
    outcome.approval === undefined &&
    asked.count < ASKS_PER_POLL
  )
    if (
      yield* askSender(orgId, row.connectionId, row.address, fields.account, fields.currency, now)
    )
      asked.count += 1;
  if (outcome.made && outcome.reason === undefined && fields.direction === "credit")
    yield* offerPayCard(orgId, row.alertId, now);
  return outcome.made;
});

/** The same alert again: its reference already counted on this approval. */
const repeated = Effect.fn("KinBankAlerts.repeated")(function* (
  orgId: KinOrgId,
  senderId: string,
  fields: AlertRead,
) {
  if (fields.reference === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [same] = yield* sql`SELECT 1 FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND sender_id = ${senderId} AND reference = ${fields.reference}
      AND state IN ('counted', 'replaced', 'not_on_statement')
    LIMIT 1`;
  return same === undefined ? undefined : ("repeat" as const);
});

type Kept =
  | { readonly state: "unread"; readonly text: string }
  | { readonly state: "counted"; readonly senderId: string; readonly fields: AlertRead }
  | {
      readonly state: "not_counted";
      readonly reason: AlertReason;
      readonly fields?: AlertRead | undefined;
    };

/** Stores one alert's row, or turns a not-counted or unread one into what a new reading says. */
const keep = Effect.fn("KinBankAlerts.keep")(function* (
  orgId: KinOrgId,
  row: Row,
  kept: Kept,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const fields = kept.state === "unread" ? undefined : kept.fields;
  const values = {
    state: kept.state,
    reason: kept.state === "not_counted" ? kept.reason : null,
    text: kept.state === "unread" ? kept.text : null,
    senderId: kept.state === "counted" ? kept.senderId : null,
  };
  const made = yield* sql<{ alertId: string }>`INSERT INTO kin_bank_alerts (org_id, alert_id,
      connection_id, message_id, address, sender_id, subject, received_at, state, reason, text,
      account, currency, direction, amount_minor, day, party, balance_minor, reference, created_at)
    VALUES (${orgId}, ${row.alertId}, ${row.connectionId}, ${row.messageId}, ${row.address},
      ${values.senderId}, ${row.subject}, ${row.receivedAt}, ${values.state}, ${values.reason},
      ${values.text}, ${fields?.account ?? null}, ${fields?.currency ?? null},
      ${fields?.direction ?? null}, ${fields?.amountMinor ?? null}, ${fields?.day ?? null},
      ${fields?.party ?? null}, ${fields?.balanceMinor ?? null}, ${fields?.reference ?? null},
      ${now})
    ON CONFLICT (org_id, connection_id, message_id) DO UPDATE SET sender_id = excluded.sender_id,
      state = excluded.state, reason = excluded.reason, text = excluded.text,
      account = excluded.account, currency = excluded.currency, direction = excluded.direction,
      amount_minor = excluded.amount_minor, day = excluded.day, party = excluded.party,
      balance_minor = excluded.balance_minor, reference = excluded.reference
    WHERE kin_bank_alerts.state IN ('not_counted', 'unread')
    RETURNING alert_id AS "alertId"`;
  return made.length > 0;
});

/** Why an alert's card can't be acted on any more: one fixed line for each, on the card and the tap. */
const UNUSABLE = {
  stopped: "Kin stopped counting this sender's alerts, so nothing can be recorded from this card.",
  disconnected:
    "This alert's mailbox isn't connected now, so nothing can be recorded from this card.",
  covered:
    "A confirmed bank statement covers this day now, so its review answers for this money instead.",
  gone: "Kin no longer counts this alert, so nothing can be recorded from this card.",
} as const;
export type Unusable = keyof typeof UNUSABLE;

/**
 * The one rule for whether an alert still matters, used by the invoice read, the card and the
 * tap: its sender counts now, its mailbox is connected now, it is counted, and no confirmed
 * statement covers its day. Undefined when usable, else why not.
 */
const alertUnusable = Effect.fn("KinBankAlerts.unusable")(function* (
  orgId: KinOrgId,
  alertId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<
    {
      state: string;
      day: string | null;
      senderState: string | null;
      connected: number;
    } & Pick<Approval, "account" | "currency" | "bound" | "boundBank">
  >`SELECT a.state, a.day,
      s.state AS "senderState", s.account, s.currency, s.bound, s.bound_bank AS "boundBank",
      ${connectedNow(sql, "a")} AS connected
    FROM kin_bank_alerts a
    LEFT JOIN kin_bank_alert_senders s ON s.org_id = a.org_id AND s.sender_id = a.sender_id
    WHERE a.org_id = ${orgId} AND a.alert_id = ${alertId}`;
  if (row === undefined || row.day === null) return "gone" as const;
  if (row.senderState !== "counted") return "stopped" as const;
  if (row.connected !== 1) return "disconnected" as const;
  if (row.state !== "counted")
    return row.state === "replaced" || row.state === "not_on_statement"
      ? ("covered" as const)
      : ("gone" as const);
  if (coveredFor(yield* bankCoverage(orgId), row)(row.day)) return "covered" as const;
  return undefined;
});

/**
 * Closes each waiting pay card of the alerts `where` names with the line saying why, so a card
 * never offers what Kin can't use any more. Runs where the Stop, the disconnect or the statement
 * that made them unusable is written.
 */
export const closeAlertCards = Effect.fn("KinBankAlerts.closeCards")(function* (
  orgId: KinOrgId,
  where:
    | { readonly senderIds: ReadonlyArray<string> }
    | { readonly connectionId: string }
    | { readonly alertIds: ReadonlyArray<string> },
  why: Unusable,
) {
  const sql = yield* SqlClient.SqlClient;
  const filter =
    "connectionId" in where
      ? sql`connection_id = ${where.connectionId}`
      : "senderIds" in where
        ? where.senderIds.length === 0
          ? sql`0`
          : sql`sender_id IN ${sql.in(where.senderIds)}`
        : where.alertIds.length === 0
          ? sql`0`
          : sql`alert_id IN ${sql.in(where.alertIds)}`;
  const closing = yield* sql<{ widgetId: string }>`UPDATE kin_bank_alerts SET pay_state = 'closed'
    WHERE org_id = ${orgId} AND pay_state = 'asked' AND ${filter}
    RETURNING pay_widget_id AS "widgetId"`;
  for (const { widgetId } of closing) yield* closeCard(orgId, widgetId, UNUSABLE[why]);
});

/** The poll's sweep: any waiting card whose alert stopped mattering closes, whatever made it so. */
export const closeUnusableCards = Effect.fn("KinBankAlerts.closeUnusable")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const waiting = yield* sql<{ alertId: string }>`SELECT alert_id AS "alertId" FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND pay_state = 'asked' ORDER BY received_at, alert_id LIMIT 100`;
  for (const { alertId } of waiting) {
    const why = yield* alertUnusable(orgId, alertId);
    if (why !== undefined) yield* closeAlertCards(orgId, { alertIds: [alertId] }, why);
  }
});

const decodeCard = Schema.decodeUnknownOption(KinChoiceCardState);
/** A waiting card closed by the server, with what happened in one line. */
const closeCard = Effect.fn("KinBankAlerts.closeCard")(function* (
  orgId: KinOrgId,
  widgetId: string,
  text: string,
) {
  const repo = yield* KinChatRepository;
  const found = yield* repo.getWidget({ orgId, widgetId: widgetId as never });
  if (Option.isNone(found)) return;
  const card = Option.getOrUndefined(decodeCard(found.value.state));
  if (card === undefined || card.answer !== null || card.outcome !== undefined) return;
  yield* updateCard(orgId, widgetId, { ...card, outcome: { title: "Closed", text } }, true);
});

type Owed = {
  readonly recordId: string;
  readonly key: string;
  readonly label: string;
  readonly clientId: string | null;
  readonly client: string | null;
  readonly currency: string;
  readonly amountMinor: number;
  readonly balanceMinor: number;
};
type Parties = {
  readonly clients: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly contacts: ReadonlyArray<{ readonly clientId: string; readonly name: string }>;
  readonly vendors: ReadonlyArray<string>;
};
const NAMED = 0.5;

/**
 * Which owed invoices a counted inflow may pay, at most three, across clients when it comes to
 * that: the same currency, the amount its balance or its total, and the other party a client's or
 * contact's name; with no name it matches, the amount alone. Money from a name that matches a
 * vendor is a refund, never a client's payment.
 */
const payMatches = (
  alert: { readonly amountMinor: number; readonly currency: string; readonly party: string | null },
  owed: ReadonlyArray<Owed>,
  parties: Parties,
): ReadonlyArray<Owed> => {
  const fits = owed.filter(
    (one) =>
      one.currency === alert.currency &&
      alert.amountMinor <= one.balanceMinor &&
      (alert.amountMinor === one.balanceMinor || alert.amountMinor === one.amountMinor),
  );
  const party = alert.party;
  if (party !== null) {
    if (parties.vendors.some((vendor) => nameIn(vendor, party) >= NAMED)) return [];
    const named = new Set([
      ...parties.clients.filter((one) => nameIn(one.name, party) >= NAMED).map((one) => one.id),
      ...parties.contacts
        .filter((one) => nameIn(one.name, party) >= NAMED)
        .map((one) => one.clientId),
    ]);
    if (named.size > 0)
      return fits
        .filter((one) => one.clientId !== null && named.has(one.clientId))
        .slice(0, INVOICES_ON_A_CARD);
  }
  return fits.length <= INVOICES_ON_A_CARD ? fits : [];
};

const owedIn = Effect.fn("KinBankAlerts.owed")(function* (orgId: KinOrgId, currency: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    recordId: string;
    key: string;
    number: string | null;
    clientId: string | null;
    client: string | null;
    currency: string;
    amountMinor: number;
    paid: number;
  }>`SELECT r.record_id AS "recordId", r.key, n.number, c.record_id AS "clientId",
      c.title AS client, r.currency, r.amount_minor AS "amountMinor",
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND ${countedPayment(sql)}) AS paid
    FROM kin_records r
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      AND c.register_id = 'clients'
    LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND r.state = 'waiting'
      AND r.amount_minor IS NOT NULL AND r.currency = ${currency}
    ORDER BY r.key`;
  return rows
    .map((row): Owed => ({
      recordId: row.recordId,
      key: row.key,
      label: row.number ?? row.key,
      clientId: row.clientId,
      client: row.client,
      currency: row.currency,
      amountMinor: row.amountMinor,
      balanceMinor: row.amountMinor - row.paid,
    }))
    .filter((one) => one.balanceMinor > 0);
});

const partiesOf = Effect.fn("KinBankAlerts.parties")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const clients = yield* sql<{ id: string; name: string }>`SELECT record_id AS id, title AS name
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'clients' AND state <> 'dropped'
    ORDER BY key`;
  const contacts = yield* sql<{ clientId: string; name: string }>`SELECT party_id AS "clientId",
      title AS name
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'contacts' AND state = 'open'
      AND party_id IS NOT NULL
    ORDER BY key`;
  const vendors = yield* sql<{ vendor: string }>`SELECT DISTINCT
      json_extract(fields_json, '$.vendor') AS vendor
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'expenses'
      AND json_extract(fields_json, '$.vendor') IS NOT NULL
    ORDER BY vendor LIMIT 500`;
  return { clients, contacts, vendors: vendors.map((one) => one.vendor) } satisfies Parties;
});

/** What a card's choice was bound to when asked: the invoice, its client and what it owed. */
const Offered = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      recordId: Schema.String,
      clientId: Schema.NullOr(Schema.String),
      balanceMinor: Schema.Number,
    }),
  ),
);
const encodeOffered = Schema.encodeSync(Offered);
const decodeOffered = Schema.decodeOption(Offered);

type AlertRow = {
  readonly alertId: string;
  readonly day: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly party: string | null;
  readonly payState: string | null;
  readonly payWidgetId: string | null;
  readonly payRecords: string | null;
  readonly payRedrawn: number;
};
const alertRow = Effect.fn("KinBankAlerts.row")(function* (
  orgId: KinOrgId,
  where: { readonly alertId: string } | { readonly widgetId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<AlertRow>`SELECT alert_id AS "alertId", day,
      amount_minor AS "amountMinor", currency, party, pay_state AS "payState",
      pay_widget_id AS "payWidgetId", pay_records_json AS "payRecords",
      pay_redrawn AS "payRedrawn"
    FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND direction = 'credit' AND ${
      "alertId" in where ? sql`alert_id = ${where.alertId}` : sql`pay_widget_id = ${where.widgetId}`
    }`;
  return row;
});

/** A choice as the owner reads it: whose invoice, which one, and what it owes. */
const choiceLabel = (one: Owed) =>
  `${one.client ?? "No client"} · ${one.label} · ${formatMoney({ minor: one.balanceMinor, currency: one.currency })}`.slice(
    0,
    80,
  );

/** The server's one "Did they pay?" card for a counted inflow that matches what is owed. */
const drawPayCard = Effect.fn("KinBankAlerts.drawPayCard")(function* (
  orgId: KinOrgId,
  alert: AlertRow,
  picks: ReadonlyArray<Owed>,
  widgetId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* liveLead(sql, orgId, { prefer: "finance" });
  if (lead === undefined) return false;
  const marked = yield* sql<{ alertId: string }>`UPDATE kin_bank_alerts
    SET pay_state = 'asked', pay_widget_id = ${widgetId},
      pay_records_json = ${encodeOffered(
        picks.map((one) => ({
          recordId: one.recordId,
          clientId: one.clientId,
          balanceMinor: one.balanceMinor,
        })),
      )}
    WHERE org_id = ${orgId} AND alert_id = ${alert.alertId}
      AND (pay_state IS NULL OR pay_widget_id <> ${widgetId})
    RETURNING alert_id AS "alertId"`;
  if (marked.length === 0) return false;
  const first = picks[0]!;
  const question =
    picks.length === 1
      ? `Did ${first.client ?? "a client"} pay ${first.label}?`
      : "Did one of these invoices get paid?";
  const day = yield* alertDayText(orgId, alert.day, now);
  const detail = `A bank alert on ${day} shows ${formatMoney({ minor: alert.amountMinor, currency: alert.currency })}${alert.party === null ? " coming in" : ` from ${alert.party}`}.`;
  yield* postCard({
    orgId,
    chatId: lead.ownerChatId,
    agentId: lead.agentId,
    widgetId,
    type: "choice",
    text: `${question} ${detail}`,
    state: choiceCardState({
      question,
      detail,
      options: [
        ...picks.map((one) => ({ label: choiceLabel(one) })),
        { label: OTHER },
        { label: UNSURE },
      ],
      untilAnswered: true,
    }),
  });
  return true;
});

/** After a counted inflow: a card when it matches what is owed, once per alert. */
const offerPayCard = Effect.fn("KinBankAlerts.offerPayCard")(function* (
  orgId: KinOrgId,
  alertId: string,
  now: number,
) {
  const alert = yield* alertRow(orgId, { alertId });
  if (alert === undefined || alert.payState !== null) return;
  if ((yield* alertUnusable(orgId, alertId)) !== undefined) return;
  const picks = payMatches(alert, yield* owedIn(orgId, alert.currency), yield* partiesOf(orgId));
  if (picks.length === 0) return;
  yield* drawPayCard(orgId, alert, picks, `${PAY_CARD}${alertId}`, now);
});

/**
 * An owner-level tap on one of Kin's alert cards, in the tap's transaction; undefined for any
 * other card. A choice on a pay card records the payment on the alert's day, as that person,
 * only while the alert is usable and the invoice is as it was offered.
 */
export const answerAlertCard = Effect.fn("KinBankAlerts.answer")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly widgetId: string;
    readonly personId: string;
    readonly optionId: string;
    readonly via: "tap" | "reaction";
    readonly now: number;
  },
  records: KinRecords["Service"],
) {
  if (!isAlertCard(input.widgetId)) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const personId = KinPersonId.make(input.personId);
  if (!(yield* ownerLevel(input.orgId, personId)))
    return yield* notAllowed("Only the owner or a co-owner answers Kin's bank alert cards.");
  if (input.via === "reaction") return yield* notAllowed("Tap one of the card's answers.");
  const index = Number(/^option-(\d+)$/.exec(input.optionId)?.[1] ?? Number.NaN) - 1;
  if (input.widgetId.startsWith(SENDER_CARD))
    return yield* answerSenderCard(input, personId, index);
  const alert = yield* alertRow(input.orgId, { widgetId: input.widgetId });
  if (alert === undefined) return undefined;
  if (alert.payState !== "asked") return yield* changed("This was already answered.");
  const decide = (state: "paid" | "other" | "unsure" | "closed", paymentId: string | null) =>
    sql`UPDATE kin_bank_alerts SET pay_state = ${state}, payment_id = ${paymentId},
        pay_by = ${personId}, pay_at = ${input.now}
      WHERE org_id = ${input.orgId} AND alert_id = ${alert.alertId}`;
  const offered = Option.getOrElse(decodeOffered(alert.payRecords ?? "[]"), () => []);
  if (index === offered.length + 1) {
    yield* decide("unsure", null);
    return {
      title: "Left for now",
      text: "Nothing was recorded. When the bank statement for that day is in, its review asks about this money.",
    } satisfies KinChoiceOutcome;
  }
  if (index === offered.length) {
    yield* decide("other", null);
    return {
      title: "Not a payment",
      text: "Nothing was recorded; the alert stays an unexplained bank line.",
    } satisfies KinChoiceOutcome;
  }
  const choice = offered[index];
  if (choice === undefined) return yield* changed("That answer isn't on this card.");
  const why = yield* alertUnusable(input.orgId, alert.alertId);
  if (why !== undefined) {
    yield* decide("closed", null);
    return { title: "Nothing recorded", text: UNUSABLE[why] } satisfies KinChoiceOutcome;
  }
  const owed = yield* owedIn(input.orgId, alert.currency);
  const invoice = owed.find((one) => one.recordId === choice.recordId);
  if (
    invoice === undefined ||
    invoice.clientId !== choice.clientId ||
    invoice.balanceMinor !== choice.balanceMinor ||
    alert.amountMinor > invoice.balanceMinor
  )
    return yield* redraw(input.orgId, alert, owed, input.now);
  const writer: Writer = { actor: { _tag: "person", personId }, via: "owner", askedBy: personId };
  const paid = yield* records.pay(input.orgId, writer, invoice.key, {
    amount: { minor: alert.amountMinor, currency: alert.currency },
    paidOn: alert.day,
    originKey: `bank-alert:${alert.alertId}`,
  });
  yield* decide("paid", paid.paymentId);
  return {
    title: "Money recorded",
    text: `${formatMoney({ minor: alert.amountMinor, currency: alert.currency })} is recorded as paid on ${invoice.label}, on ${yield* alertDayText(input.orgId, alert.day, input.now)}, from the bank alert.`,
  } satisfies KinChoiceOutcome;
});

/** An invoice that moved since the card asked: nothing is recorded, and the card is drawn once more. */
const redraw = Effect.fn("KinBankAlerts.redraw")(function* (
  orgId: KinOrgId,
  alert: AlertRow,
  owed: ReadonlyArray<Owed>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const picks = alert.payRedrawn === 0 ? payMatches(alert, owed, yield* partiesOf(orgId)) : [];
  yield* sql`UPDATE kin_bank_alerts SET pay_state = 'closed', pay_redrawn = 1
    WHERE org_id = ${orgId} AND alert_id = ${alert.alertId}`;
  const again =
    picks.length > 0 &&
    (yield* drawPayCard(orgId, alert, picks, `${PAY_CARD}${alert.alertId}:again`, now));
  return {
    title: "Nothing recorded",
    text: again
      ? "That invoice changed since Kin asked, so nothing was recorded. Kin asks again with what is owed now."
      : "That invoice changed since Kin asked, so nothing was recorded.",
  } satisfies KinChoiceOutcome;
});

const answerSenderCard = Effect.fn("KinBankAlerts.answerSender")(function* (
  input: { readonly orgId: KinOrgId; readonly widgetId: string; readonly now: number },
  personId: KinPersonId,
  index: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [sender] = yield* sql<Approval & { choices: string | null }>`SELECT ${APPROVAL(sql)},
      choices_json AS choices
    FROM kin_bank_alert_senders WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}`;
  if (sender === undefined) return undefined;
  if (sender.state !== "asked") return yield* changed("This was already answered.");
  const choices = Option.getOrElse(decodeChoices(sender.choices ?? "[]"), () => []);
  const several = choices.length > 1;
  const shown = Math.min(choices.length, 5);
  const no = several ? index === shown + 1 : index === 1;
  const picked = several ? (index < shown ? choices[index] : undefined) : choices[0];
  const none = several && index === shown;
  if (!no && !none && several && picked === undefined)
    return yield* changed("That answer isn't on this card.");
  const from = input.now - LOOKBACK_MS;
  yield* sql`UPDATE kin_bank_alert_senders
    SET state = ${no ? "declined" : "counted"}, decided_at = ${input.now}, decided_by = ${personId},
      bound = ${no ? "open" : none ? "none" : picked === undefined ? "open" : "bound"},
      bound_bank = ${no || none || picked === undefined ? null : picked.key},
      since_at = ${no ? null : from}, cursor_at = ${no ? null : from}
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND state = 'asked'`;
  yield* (yield* KinRefreshObserver).touch(input.orgId, "connections");
  return (
    no
      ? { title: "Not counted", text: `Kin won't count mail from ${sender.address}.` }
      : {
          title: "Counting these alerts",
          text: `Kin counts alerts from ${sender.address} for account ••${sender.account} from now on, and reads its mail from the last 7 days. Stop it in Settings, Connections.`,
        }
  ) satisfies KinChoiceOutcome;
});

/**
 * Binds each open approval with these digits and currency to the one confirmed statement account
 * that fits, once a statement makes it one; with several, or a choice made, nothing changes.
 */
export const bindApprovals = Effect.fn("KinBankAlerts.bind")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const spans = yield* bankCoverage(orgId);
  for (const approval of yield* approvalsOf(orgId)) {
    if (approval.bound !== "open" || approval.state === "asked" || approval.state === "declined")
      continue;
    const fits = accountsFor(spans, approval.account, approval.currency);
    if (fits.length !== 1) continue;
    yield* sql`UPDATE kin_bank_alert_senders SET bound = 'bound', bound_bank = ${fits[0]!.key}
      WHERE org_id = ${orgId} AND sender_id = ${approval.senderId} AND bound = 'open'`;
  }
});

/** An owed invoice's alert while its card waits or was answered Not sure, and it is usable. */
export const invoiceAlert = Effect.fn("KinBankAlerts.invoiceAlert")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    alertId: string;
    day: string;
    amountMinor: number;
    currency: string;
    party: string | null;
  }>`SELECT a.alert_id AS "alertId", a.day, a.amount_minor AS "amountMinor", a.currency, a.party
    FROM kin_bank_alerts a
    WHERE a.org_id = ${orgId} AND a.direction = 'credit' AND a.state = 'counted'
      AND a.pay_state IN ('asked', 'unsure')
      AND EXISTS (SELECT 1 FROM json_each(a.pay_records_json) j
        WHERE json_extract(j.value, '$.recordId') = ${recordId})
    ORDER BY a.day DESC, a.received_at DESC, a.alert_id LIMIT 5`;
  for (const row of rows)
    if ((yield* alertUnusable(orgId, row.alertId)) === undefined)
      return {
        day: row.day,
        amount: { minor: row.amountMinor, currency: row.currency },
        party: row.party,
      };
  return undefined;
});
