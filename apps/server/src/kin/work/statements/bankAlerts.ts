// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinChatError,
  type KinChoiceOutcome,
  type KinOrgId,
  KinPersonId,
  KIN_TEXT_LOCALE,
  kinWhenFormat,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import type { KinAlertMessage } from "../../connections/ConnectionsService.ts";
import { addressesIn } from "../../connections/MailProvider.ts";
import { liveLead } from "../../lead/orgLeads.ts";
import { ownerLevel } from "../../people/KinAccess.ts";
import { choiceCardState } from "../../widgets/choiceCard.ts";
import { homeCurrency } from "../companyProfile.ts";
import type { KinRecords, Writer } from "../KinRecords.ts";
import { dayIn, formatMoney } from "../money.ts";
import { countedPayment, ownerZone } from "../recordRows.ts";
import {
  type AlertMail,
  type AlertRead,
  type AlertReason,
  alertSenderCheck,
  alertSigns,
  decodeAlertRead,
  isReplyOrForward,
  judgeAlert,
  readAlertText,
} from "./alertText.ts";
import { isAlertCard, PAY_CARD, SENDER_CARD } from "./alertCards.ts";
import { bankKnown } from "./bankKnown.ts";
import { nameIn } from "./statementMatch.ts";
import { postCard } from "./statementReview.ts";

/**
 * Bank alerts by mail: Kin's own tally between statements. Only mail from a sender the owner
 * level confirmed on Kin's card, in a connected mailbox, that passed the mailbox's sender checks.
 * A reader turns one mail into fields; every decision after that is this code over stored rows,
 * and money is recorded only by an owner-level tap on the card Kin draws here.
 */

/**
 * Reads one alert into fields. The plain reader is the default; a model may stand behind this
 * instead, with no tools and the mail as outside text, and its answer is checked the same way.
 */
export class KinAlertReader extends Context.Service<
  KinAlertReader,
  { readonly read: (mail: AlertMail) => Effect.Effect<unknown> }
>()("t3/kin/work/statements/bankAlerts/KinAlertReader") {}

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

/** The one read of mail bodies: a confirmed sender's messages of a thread, nobody else's. */
export type AlertMailbox = (
  orgId: KinOrgId,
  connectionId: string,
  threadId: string,
  address: string,
) => Effect.Effect<ReadonlyArray<KinAlertMessage>, KinChatError>;

const COUNT = "Yes, count these";
const DONT = "No";
const PAID = "Yes, record it";
const OTHER = "No, it's something else";
const UNSURE = "Not sure yet";
const ASKS_PER_POLL = 3;
const MESSAGES_PER_THREAD = 20;
const INVOICES_ON_A_CARD = 3;
const DAY_MS = 86_400_000;
/** Mail older than this before the sender was asked about is history, not news. */
const LOOKBACK_MS = 7 * DAY_MS;
/** A mail dated a little ahead of the server's clock still counts; further ahead it is wrong. */
const CLOCK_SLACK_MS = 10 * 60_000;

const hash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
const SHORT = kinWhenFormat("date", { zone: "UTC", locale: KIN_TEXT_LOCALE });
const dayText = (day: string) => SHORT.format(Date.parse(`${day}T12:00:00Z`));
const notAllowed = (message: string) => new KinChatError({ reason: "not_allowed", message });
const changed = (message: string) => new KinChatError({ reason: "widget_changed", message });
const RecordIds = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeIds = Schema.encodeSync(RecordIds);
const decodeIds = Schema.decodeOption(RecordIds);
const idsOf = (json: string | null) =>
  json === null ? [] : Option.getOrElse(decodeIds(json), () => []);
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

type Sender = {
  readonly connectionId: string;
  readonly address: string;
  readonly account: string;
  readonly currency: string;
  readonly state: "asked" | "counted" | "declined" | "stopped";
  readonly askedAt: number;
};

/**
 * What the poll found, as the bank alert rules see it: mail from a counted sender is read and
 * checked; mail from anyone else that looks like an alert gets one card asking about it, never
 * a read. Everything else is ordinary mail and nothing here touches it.
 */
export const noticeAlerts = Effect.fn("KinBankAlerts.notice")(function* (
  orgId: KinOrgId,
  mail: ReadonlyArray<AlertCandidate>,
  now: number,
  mailbox: AlertMailbox | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  if (mail.length === 0) return;
  const senders = yield* sql<Sender>`SELECT connection_id AS "connectionId", address, account,
      currency, state, asked_at AS "askedAt"
    FROM kin_bank_alert_senders WHERE org_id = ${orgId}
    ORDER BY connection_id, address, account`;
  const home = yield* homeCurrency(orgId);
  let asked = 0;
  let read = false;
  for (const one of mail) {
    const address = addressesIn(one.from)[0]?.toLowerCase();
    if (address === undefined) continue;
    const mine = senders.filter(
      (sender) => sender.connectionId === one.connectionId && sender.address === address,
    );
    const counting = mine.filter((sender) => sender.state === "counted");
    if (counting.length > 0) {
      if (mailbox !== undefined)
        read = (yield* readCounted(orgId, one, address, counting, now, mailbox)) || read;
      continue;
    }
    if (asked >= ASKS_PER_POLL || isReplyOrForward(one.subject)) continue;
    if (one.mailbox !== null && domainOf(one.mailbox) === domainOf(address)) continue;
    const signs = alertSigns(`${one.subject}\n${one.preview}`, home);
    if (signs === undefined || mine.some((sender) => sender.account === signs.account)) continue;
    if (
      yield* askSender(orgId, one.connectionId, address, signs.account, signs.amount.currency, now)
    )
      asked += 1;
  }
  if (asked > 0) yield* (yield* KinRefreshObserver).touch(orgId, "connections");
  if (read) yield* (yield* KinRefreshObserver).touch(orgId, "moneyStatements");
});

/** One card, ever, per mailbox, sender and account: nothing counts before its Yes. */
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
  const widgetId = `${SENDER_CARD}${hash(`${orgId}\u0000${connectionId}\u0000${address}\u0000${account}`)}`;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const made = yield* sql<{ address: string }>`INSERT INTO kin_bank_alert_senders
          (org_id, connection_id, address, account, currency, state, widget_id, asked_at)
        VALUES (${orgId}, ${connectionId}, ${address}, ${account}, ${currency}, 'asked',
          ${widgetId}, ${now})
        ON CONFLICT DO NOTHING RETURNING address`;
      if (made.length === 0) return false;
      const question = `Is ${address} your bank's alerts for account ••${account}?`;
      yield* postCard({
        orgId,
        chatId: lead.ownerChatId,
        agentId: lead.agentId,
        widgetId,
        type: "choice",
        text: question,
        state: choiceCardState({
          question,
          detail:
            "Kin counts its alerts only after you say yes, and only mail that passes your mailbox's sender checks. Nothing is recorded as paid until you say so.",
          options: [{ label: COUNT }, { label: DONT }],
          untilAnswered: true,
        }),
      });
      return true;
    }),
  );
});

/**
 * Reads a counted sender's new messages in one thread, each once. Returns whether any was kept.
 * Its mail that fails the sender checks is kept as not counted; so is a read that fails a check.
 */
const readCounted = Effect.fn("KinBankAlerts.readCounted")(function* (
  orgId: KinOrgId,
  mail: AlertCandidate,
  address: string,
  counting: ReadonlyArray<Sender>,
  now: number,
  mailbox: AlertMailbox,
) {
  const sql = yield* SqlClient.SqlClient;
  const latest = mail.date === null ? Number.NaN : Date.parse(mail.date);
  if (Number.isFinite(latest)) {
    const [seen] = yield* sql<{ at: number }>`SELECT MAX(received_at) AS at FROM kin_bank_alerts
      WHERE org_id = ${orgId} AND connection_id = ${mail.connectionId}
        AND thread_id = ${mail.threadId}`;
    if (seen?.at != null && seen.at >= latest) return false;
  }
  const messages = yield* mailbox(orgId, mail.connectionId, mail.threadId, address).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't read a bank alert's mail", { orgId, cause }).pipe(
        Effect.as([] as ReadonlyArray<KinAlertMessage>),
      ),
    ),
  );
  const earliest = Math.min(...counting.map((sender) => sender.askedAt)) - LOOKBACK_MS;
  const zone = yield* ownerZone(orgId);
  const home = yield* homeCurrency(orgId);
  const reader = yield* Effect.serviceOption(KinAlertReader);
  let kept = false;
  for (const message of messages.slice(-MESSAGES_PER_THREAD)) {
    const sent = message.date === null ? Number.NaN : Date.parse(message.date);
    const at = Number.isFinite(sent) ? sent : now;
    if (at < earliest || at > now + CLOCK_SLACK_MS) continue;
    const key = message.key.slice(0, 400);
    const [stored] = yield* sql`SELECT 1 FROM kin_bank_alerts
      WHERE org_id = ${orgId} AND mail_key = ${key}`;
    if (stored !== undefined) continue;
    const row = {
      alertId: `ba_${hash(`${orgId}\u0000${key}`)}`,
      connectionId: mail.connectionId,
      address,
      key,
      threadId: message.threadId,
      subject: message.subject.slice(0, 300),
      receivedAt: at,
    };
    const check = alertSenderCheck(message.authResults, address);
    if (check !== "passed") {
      kept =
        (yield* keep(
          orgId,
          row,
          "unchecked",
          check === "failed" ? "failed_check" : "not_checked",
          undefined,
          now,
        )) || kept;
      continue;
    }
    const mailDay = dayIn(at, zone);
    const said: AlertMail = { subject: message.subject, text: message.text, mailDay, home };
    const raw = Option.isSome(reader) ? yield* reader.value.read(said) : readAlertText(said);
    const fields = Option.getOrUndefined(decodeAlertRead(raw));
    if (fields === undefined) {
      kept = (yield* keep(orgId, row, "unread", "unreadable", undefined, now)) || kept;
      continue;
    }
    const sender = counting.find((one) => one.account === fields.account);
    const reason =
      sender === undefined
        ? ("other_account" as const)
        : (judgeAlert(fields, {
            account: sender.account,
            currency: sender.currency,
            today: dayIn(now, zone),
            coveredThrough: yield* coveredThrough(orgId, fields.account, sender.currency),
          }) ?? (yield* repeated(orgId, fields)));
    const made = yield* keep(
      orgId,
      row,
      reason === undefined ? "counted" : "unread",
      reason,
      fields,
      now,
    );
    kept = made || kept;
    if (made && reason === undefined && fields.direction === "credit")
      yield* offerPayCard(orgId, row.alertId);
  }
  return kept;
});

/** The last day a confirmed statement of this account covers: an alert before it adds nothing. */
const coveredThrough = Effect.fn("KinBankAlerts.coveredThrough")(function* (
  orgId: KinOrgId,
  account: string,
  currency: string,
) {
  const known = yield* bankKnown(orgId);
  return known.accounts
    .filter((one) => one.digits === account && one.currency === currency)
    .reduce<string | null>(
      (latest, one) =>
        latest === null || (one.lastEnd ?? one.through) > latest
          ? (one.lastEnd ?? one.through)
          : latest,
      null,
    );
});

/** The same alert again: its reference already counted on this account. */
const repeated = Effect.fn("KinBankAlerts.repeated")(function* (
  orgId: KinOrgId,
  fields: AlertRead,
) {
  if (fields.reference === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const [same] = yield* sql`SELECT 1 FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND account = ${fields.account} AND reference = ${fields.reference}
      AND state IN ('counted', 'replaced', 'not_on_statement')
    LIMIT 1`;
  return same === undefined ? undefined : ("repeat" as const);
});

const keep = Effect.fn("KinBankAlerts.keep")(function* (
  orgId: KinOrgId,
  row: {
    readonly alertId: string;
    readonly connectionId: string;
    readonly address: string;
    readonly key: string;
    readonly threadId: string;
    readonly subject: string;
    readonly receivedAt: number;
  },
  state: "counted" | "unread" | "unchecked",
  reason: AlertReason | undefined,
  fields: AlertRead | undefined,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const made = yield* sql<{ alertId: string }>`INSERT INTO kin_bank_alerts (org_id, alert_id,
      connection_id, address, mail_key, thread_id, subject, received_at, state, reason, account,
      currency, direction, amount_minor, day, party, balance_minor, reference, created_at)
    VALUES (${orgId}, ${row.alertId}, ${row.connectionId}, ${row.address}, ${row.key},
      ${row.threadId}, ${row.subject}, ${row.receivedAt}, ${state}, ${reason ?? null},
      ${fields?.account ?? null}, ${fields?.currency ?? null}, ${fields?.direction ?? null},
      ${fields?.amountMinor ?? null}, ${fields?.day ?? null}, ${fields?.party ?? null},
      ${fields?.balanceMinor ?? null}, ${fields?.reference ?? null}, ${now})
    ON CONFLICT DO NOTHING RETURNING alert_id AS "alertId"`;
  return made.length > 0;
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
 * Which owed invoices a counted inflow may pay: the same currency, the amount its balance or its
 * total, and the other party a client's or contact's name; with no name it matches, the amount
 * alone when only one owed invoice has it. Money from a vendor is a refund, not a client's.
 */
const payMatches = (
  alert: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly party: string | null;
  },
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
    const named = new Set([
      ...parties.clients.filter((one) => nameIn(one.name, party) >= NAMED).map((one) => one.id),
      ...parties.contacts
        .filter((one) => nameIn(one.name, party) >= NAMED)
        .map((one) => one.clientId),
    ]);
    if (named.size > 0)
      return fits.filter((one) => one.clientId !== null && named.has(one.clientId));
    if (parties.vendors.some((vendor) => nameIn(vendor, party) >= NAMED)) return [];
  }
  return fits.length === 1 ? fits : [];
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

type AlertRow = {
  readonly alertId: string;
  readonly day: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly party: string | null;
  readonly payState: string | null;
  readonly payWidgetId: string | null;
  readonly payRecords: string | null;
};
const alertRow = Effect.fn("KinBankAlerts.row")(function* (
  orgId: KinOrgId,
  where: { readonly alertId: string } | { readonly widgetId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<AlertRow>`SELECT alert_id AS "alertId", day,
      amount_minor AS "amountMinor", currency, party, pay_state AS "payState",
      pay_widget_id AS "payWidgetId", pay_records_json AS "payRecords"
    FROM kin_bank_alerts
    WHERE org_id = ${orgId} AND direction = 'credit' AND ${
      "alertId" in where ? sql`alert_id = ${where.alertId}` : sql`pay_widget_id = ${where.widgetId}`
    }`;
  return row;
});

const shownAs = (alert: Pick<AlertRow, "day" | "amountMinor" | "currency" | "party">) =>
  `A bank alert on ${dayText(alert.day)} shows ${formatMoney({ minor: alert.amountMinor, currency: alert.currency })}${alert.party === null ? " coming in" : ` from ${alert.party}`}.`;

const listed = (labels: ReadonlyArray<string>) =>
  labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;

/** The server's one "Did they pay?" card for a counted inflow that matches what is owed. */
const drawPayCard = Effect.fn("KinBankAlerts.drawPayCard")(function* (
  orgId: KinOrgId,
  alert: AlertRow,
  picks: ReadonlyArray<Owed>,
  widgetId: string,
  state: "asked" | "asked_again",
) {
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* liveLead(sql, orgId, { prefer: "finance" });
  if (lead === undefined) return;
  const marked = yield* sql<{ alertId: string }>`UPDATE kin_bank_alerts
    SET pay_state = ${state}, pay_widget_id = ${widgetId},
      pay_records_json = ${encodeIds(picks.map((one) => one.recordId))}
    WHERE org_id = ${orgId} AND alert_id = ${alert.alertId}
      AND ${state === "asked" ? sql`pay_state IS NULL` : sql`pay_state = 'unsure'`}
    RETURNING alert_id AS "alertId"`;
  if (marked.length === 0) return;
  const client = picks[0]!.client;
  const sameClient = picks.every((one) => one.client === client);
  const invoices = listed(picks.map((one) => one.label));
  const question =
    client !== null && sameClient ? `Did ${client} pay ${invoices}?` : `Was ${invoices} paid?`;
  const detail = `${shownAs(alert)}${state === "asked_again" ? " The bank statement for that day is in now." : ""}`;
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
        ...(picks.length === 1
          ? [{ label: PAID }]
          : picks.map((one) => ({ label: `Yes, ${one.label}`.slice(0, 80) }))),
        { label: OTHER },
        { label: UNSURE },
      ],
      untilAnswered: true,
    }),
  });
});

/** After a counted inflow: a card when it matches what is owed, once per alert, ever. */
const offerPayCard = Effect.fn("KinBankAlerts.offerPayCard")(function* (
  orgId: KinOrgId,
  alertId: string,
) {
  const alert = yield* alertRow(orgId, { alertId });
  if (alert === undefined || alert.payState !== null) return;
  const picks = payMatches(
    { ...alert, party: alert.party },
    yield* owedIn(orgId, alert.currency),
    yield* partiesOf(orgId),
  ).slice(0, INVOICES_ON_A_CARD);
  if (picks.length === 0) return;
  yield* drawPayCard(orgId, alert, picks, `${PAY_CARD}${alertId}`, "asked");
});

/**
 * "Not sure yet" asks once more when the statement for its day is confirmed, if what it offered
 * is still owed. A second "Not sure yet" leaves it.
 */
export const reaskAfterStatement = Effect.fn("KinBankAlerts.reask")(function* (
  orgId: KinOrgId,
  alertIds: ReadonlyArray<string>,
) {
  for (const alertId of alertIds) {
    const alert = yield* alertRow(orgId, { alertId });
    if (alert?.payState !== "unsure" || alert.payWidgetId?.endsWith(":again") !== false) continue;
    const offered = new Set(idsOf(alert.payRecords));
    const picks = (yield* owedIn(orgId, alert.currency)).filter(
      (one) => offered.has(one.recordId) && alert.amountMinor <= one.balanceMinor,
    );
    if (picks.length === 0) continue;
    yield* drawPayCard(orgId, alert, picks, `${PAY_CARD}${alertId}:again`, "asked_again");
  }
});

/**
 * An owner-level tap on one of Kin's alert cards, in the tap's transaction; undefined for any
 * other card. A Yes on a pay card records the payment on the alert's day, as that person.
 */
export const answerAlertCard = Effect.fn("KinBankAlerts.answer")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly widgetId: string;
    readonly personId: string;
    readonly label: string;
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
  if (input.widgetId.startsWith(SENDER_CARD)) {
    const [sender] = yield* sql<{
      connectionId: string;
      address: string;
      account: string;
      currency: string;
      state: string;
    }>`SELECT connection_id AS "connectionId", address, account, currency, state
      FROM kin_bank_alert_senders WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}`;
    if (sender === undefined) return undefined;
    if (sender.state !== "asked") return yield* changed("This was already answered.");
    const yes = input.label === COUNT;
    const known = (yield* bankKnown(input.orgId)).accounts.find(
      (one) => one.digits === sender.account,
    );
    yield* sql`UPDATE kin_bank_alert_senders
      SET state = ${yes ? "counted" : "declined"}, decided_at = ${input.now},
        decided_by = ${personId}, currency = ${known?.currency ?? sender.currency}
      WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND state = 'asked'`;
    yield* (yield* KinRefreshObserver).touch(input.orgId, "connections");
    return (
      yes
        ? {
            title: "Counting these alerts",
            text: `Kin counts alerts from ${sender.address} for account ••${sender.account} from now on, beside your statements. Stop it in Settings, Connections.`,
          }
        : { title: "Not counted", text: `Kin won't count mail from ${sender.address}.` }
    ) satisfies KinChoiceOutcome;
  }
  const alert = yield* alertRow(input.orgId, { widgetId: input.widgetId });
  if (alert === undefined) return undefined;
  if (alert.payState !== "asked" && alert.payState !== "asked_again")
    return yield* changed("This was already answered.");
  const decide = (state: "paid" | "other" | "unsure", paymentId: string | null) =>
    sql`UPDATE kin_bank_alerts SET pay_state = ${state}, payment_id = ${paymentId},
        pay_by = ${personId}, pay_at = ${input.now}
      WHERE org_id = ${input.orgId} AND alert_id = ${alert.alertId}`;
  if (input.label === UNSURE) {
    yield* decide("unsure", null);
    return {
      title: "Left for now",
      text:
        alert.payState === "asked"
          ? "Nothing was recorded. Kin asks once more when the bank statement for that day is confirmed."
          : "Nothing was recorded.",
    } satisfies KinChoiceOutcome;
  }
  if (input.label === OTHER) {
    yield* decide("other", null);
    return {
      title: "Not a payment",
      text: "Nothing was recorded; the alert stays an unexplained bank line.",
    } satisfies KinChoiceOutcome;
  }
  const offered = idsOf(alert.payRecords);
  const owed = (yield* owedIn(input.orgId, alert.currency)).filter((one) =>
    offered.includes(one.recordId),
  );
  const invoice =
    input.label === PAID && offered.length === 1
      ? owed.find((one) => one.recordId === offered[0])
      : owed.find((one) => `Yes, ${one.label}`.slice(0, 80) === input.label);
  if (invoice === undefined)
    return yield* changed("That invoice isn't owed any more, so nothing was recorded.");
  const writer: Writer = { actor: { _tag: "person", personId }, via: "owner", askedBy: personId };
  const paid = yield* records.pay(input.orgId, writer, invoice.key, {
    amount: { minor: alert.amountMinor, currency: alert.currency },
    paidOn: alert.day,
    originKey: `bank-alert:${alert.alertId}`,
  });
  yield* decide("paid", paid.paymentId);
  return {
    title: "Money recorded",
    text: `${formatMoney({ minor: alert.amountMinor, currency: alert.currency })} is recorded as paid on ${invoice.label}, on ${dayText(alert.day)}, from the bank alert.`,
  } satisfies KinChoiceOutcome;
});

/** An owed invoice's alert while its card waits, for the owner level's invoice page. */
export const invoiceAlert = Effect.fn("KinBankAlerts.invoiceAlert")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    day: string;
    amountMinor: number;
    currency: string;
    party: string | null;
  }>`SELECT a.day, a.amount_minor AS "amountMinor", a.currency, a.party
    FROM kin_bank_alerts a
    WHERE a.org_id = ${orgId} AND a.direction = 'credit'
      AND a.pay_state IN ('asked', 'asked_again', 'unsure')
      AND EXISTS (SELECT 1 FROM json_each(a.pay_records_json) j WHERE j.value = ${recordId})
    ORDER BY a.day DESC, a.received_at DESC, a.alert_id LIMIT 1`;
  return row === undefined
    ? undefined
    : {
        day: row.day,
        amount: { minor: row.amountMinor, currency: row.currency },
        party: row.party,
      };
});
