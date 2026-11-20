// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id and review hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_STATEMENT_PASSWORD_CARD,
  KIN_STATEMENT_REVIEW_CARD,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  type KinOrgId,
  type KinRecordState,
  KinStatementPasswordCard,
  KinStatementReviewCard,
  KinStatementSelection,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlStatement from "effect/sql/Statement";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import { KinChatHub } from "../../chat/KinChatHub.ts";
import { ownerLevel } from "../../people/KinAccess.ts";
import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { choiceCardState } from "../../widgets/choiceCard.ts";
import { fieldText, parseFields } from "../lists.ts";
import { homeCurrency } from "../companyProfile.ts";
import { dayIn } from "../money.ts";
import { keptEntry, ownerZone } from "../recordRows.ts";
import { listDef } from "../registers.ts";
import { alertsOnReview } from "./alertLines.ts";
import { bankStates, directionOf, findBankList, type KnownRow, knownRows } from "./bankList.ts";
import type { FileOutcome } from "./statementFiles.ts";
import { readIsolated } from "./statementReader.ts";
import { matchRows, type RowMatch, SALARIES, seenOf } from "./statementMatch.ts";
import {
  defaultSelection,
  type Held,
  type AlertMissing,
  type Missing,
  type Review,
  reviewCard,
  STATEMENT_REVIEW_TEXT,
} from "./statementCard.ts";
import type { Statement } from "./statementTable.ts";

/**
 * A statement Kin was sent: read once per file, its rows matched against the open invoices and
 * expenses, and put to the owner on one review card. A locked PDF gets a password card instead;
 * the password goes from that card to the server and is used for this file, never to a lead.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const statementIdFor = (orgId: string, attachmentId: string) =>
  `st_${hash(`${orgId.length}:${orgId}${attachmentId}`).slice(0, 20)}`;

/** What Kin keeps of a read: the rows, which are already saved, and each other row's matches. */
const StoredReview = Schema.Struct({
  statement: Schema.Unknown,
  format: Schema.NullOr(Schema.String),
  source: Schema.Literals(["file", "agent"]),
  known: Schema.Array(Schema.Tuple([Schema.Number, Schema.Unknown])),
  matches: Schema.Array(Schema.Tuple([Schema.Number, Schema.Unknown])),
  missing: Schema.optional(Schema.Array(Schema.Unknown)),
  alertsMissing: Schema.optional(Schema.Array(Schema.Unknown)),
});
const ReviewJson = Schema.fromJsonString(StoredReview);
const encodeReview = Schema.encodeEffect(ReviewJson);
const decodeReview = Schema.decodeUnknownOption(ReviewJson);
export const reviewOf = (json: string): Review | undefined =>
  Option.match(decodeReview(json), {
    onNone: () => undefined,
    onSome: (stored) => ({
      statement: stored.statement as Statement,
      format: stored.format,
      source: stored.source,
      known: new Map(stored.known.map(([index, row]) => [index, row as KnownRow])),
      matches: new Map(stored.matches.map(([index, match]) => [index, match as RowMatch])),
      ...(stored.missing === undefined || stored.missing.length === 0
        ? {}
        : { missing: stored.missing as ReadonlyArray<Missing> }),
      ...(stored.alertsMissing === undefined || stored.alertsMissing.length === 0
        ? {}
        : { alertsMissing: stored.alertsMissing as ReadonlyArray<AlertMissing> }),
    }),
  });
const storeReview = (review: Review) =>
  encodeReview({
    statement: review.statement,
    format: review.format,
    source: review.source,
    known: [...review.known.entries()],
    matches: [...review.matches.entries()],
    ...(review.missing === undefined ? {} : { missing: review.missing }),
    ...(review.alertsMissing === undefined ? {} : { alertsMissing: review.alertsMissing }),
  });

export type StatementRow = {
  readonly statementId: string;
  readonly attachmentId: string;
  readonly fileName: string;
  readonly chatId: string;
  readonly agentId: string;
  readonly status: "needs_password" | "read" | "scanned" | "unreadable";
  readonly reason: string | null;
  readonly source: "file" | "agent";
  readonly account: string | null;
  readonly reviewJson: string | null;
  readonly reviewHash: string | null;
  readonly reviewWidgetId: string | null;
  readonly passwordWidgetId: string | null;
  readonly appliedAt: number | null;
  readonly undoneAt: number | null;
  /** Rises on each undo, so a later confirm's retry keys are its own. */
  readonly generation: number;
  readonly selectionJson: string | null;
  readonly passwordAttempts: number;
  /** Wrong passwords a lead passed from the owner's chat, counted apart from the card's. */
  readonly chatPasswordAttempts: number;
  /** While a lead reads the rows: the pages' text, the rows given so far, and checks failed. */
  readonly pagesJson: string | null;
  readonly draftJson: string | null;
  readonly proofRounds: number;
};
export const statementRow = Effect.fn("KinStatements.row")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<StatementRow>`SELECT statement_id AS "statementId",
      attachment_id AS "attachmentId", file_name AS "fileName", chat_id AS "chatId",
      agent_id AS "agentId", status, reason, source, account, review_json AS "reviewJson",
      review_hash AS "reviewHash", review_widget_id AS "reviewWidgetId",
      password_widget_id AS "passwordWidgetId", applied_at AS "appliedAt", undone_at AS "undoneAt",
      generation, selection_json AS "selectionJson", password_attempts AS "passwordAttempts",
      chat_password_attempts AS "chatPasswordAttempts",
      pages_json AS "pagesJson", draft_json AS "draftJson", proof_rounds AS "proofRounds"
    FROM kin_bank_statements WHERE org_id = ${orgId} AND statement_id = ${statementId}`;
  return row;
});

/** The bytes of a file Kin keeps from a chat message. */
export const attachmentBytes = Effect.fn("KinStatements.attachmentBytes")(function* (
  attachmentId: string,
) {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
  if (path === null) return yield* invalid("That file can't be found any more.");
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFile(path)
    .pipe(
      Effect.mapError(() =>
        invalid("That file can't be read any more; ask the owner to send it again."),
      ),
    );
});

/** Live payments on the entries `where` picks (over `r`), but for those this statement recorded. */
const livePayments = Effect.fn("KinStatements.livePayments")(function* (
  orgId: KinOrgId,
  statementId: string | undefined,
  where: SqlStatement.Fragment,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ recordId: string; paymentId: string }>`SELECT p.record_id AS "recordId",
      p.payment_id AS "paymentId"
    FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND ${where}
      AND NOT EXISTS (SELECT 1 FROM kin_bank_statement_entries e WHERE e.org_id = p.org_id
        AND e.statement_id = ${statementId ?? ""} AND e.payment_id = p.payment_id)
    ORDER BY p.payment_id`;
});

/** What an invoice stands on now for this statement's match: its amount and others' payments. */
export const invoiceSeen = Effect.fn("KinStatements.invoiceSeen")(function* (
  orgId: KinOrgId,
  statementId: string,
  invoice: { readonly recordId: string; readonly amountMinor: number | null },
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* livePayments(orgId, statementId, sql`r.record_id = ${invoice.recordId}`);
  return seenOf(
    invoice.amountMinor ?? 0,
    ids.map((one) => one.paymentId),
  );
});

/** Open invoices and expenses the rows may be, with the owner's own accounts and vendors. */
const candidates = Effect.fn("KinStatements.candidates")(function* (
  orgId: KinOrgId,
  statement: Statement,
  statementId: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const home = yield* homeCurrency(orgId);
  const zone = yield* ownerZone(orgId);
  const day = (ms: number | null) => (ms === null ? null : dayIn(ms, zone));
  // Banks list newest first as often as oldest first; the window starts before either end.
  const earliest = statement.rows.reduce(
    (first, row) => (row.date < first ? row.date : first),
    statement.rows[0]?.date ?? "2000-01-01",
  );
  const invoiceRows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    currency: string | null;
    amountMinor: number | null;
    dateAt: number | null;
    fieldsJson: string;
    client: string | null;
    paid: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.currency, r.amount_minor AS "amountMinor",
      r.date_at AS "dateAt", r.fields_json AS "fieldsJson", c.title AS client,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid
    FROM kin_records r LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'invoices' AND r.state = 'waiting'
      AND r.amount_minor IS NOT NULL AND ${keptEntry(sql)} AND NOT EXISTS (SELECT 1 FROM kin_bank_statement_entries e
        WHERE e.org_id = r.org_id AND e.statement_id = ${statementId ?? ""}
          AND e.target_record_id = r.record_id)
    ORDER BY r.key`;
  const received = new Map<string, Array<string>>();
  for (const one of yield* livePayments(
    orgId,
    statementId,
    sql`r.register_id = 'invoices'
      AND r.state = 'waiting'`,
  ))
    received.set(one.recordId, [...(received.get(one.recordId) ?? []), one.paymentId]);
  const expenseRows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    state: string;
    currency: string | null;
    amountMinor: number | null;
    dateAt: number | null;
    dueAt: number | null;
    fieldsJson: string;
    repeats: number;
    linked: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.state, r.currency,
      r.amount_minor AS "amountMinor", r.date_at AS "dateAt", r.due_at AS "dueAt",
      r.fields_json AS "fieldsJson", (r.repeat_json IS NOT NULL) AS repeats,
      EXISTS (SELECT 1 FROM kin_bank_statement_entries e WHERE e.org_id = r.org_id
        AND e.target_record_id = r.record_id) AS linked
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state IN ('open', 'done')
      AND r.amount_minor IS NOT NULL AND ${keptEntry(sql)}
      AND COALESCE(r.date_at, r.due_at, r.created_at) >= ${Date.parse(`${earliest}T00:00:00Z`) - 60 * 86_400_000}
    ORDER BY r.key`;
  // Recorded on an invoice and not yet any statement's row: a bank row may be that money arriving.
  const payments = yield* sql<{
    paymentId: string;
    recordId: string;
    key: string;
    title: string;
    currency: string;
    amountMinor: number;
    paidOn: string;
    note: string;
    client: string | null;
  }>`SELECT p.payment_id AS "paymentId", r.record_id AS "recordId", r.key, r.title, p.currency,
      p.amount_minor AS "amountMinor", p.paid_on AS "paidOn", p.note, c.title AS client
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
    WHERE p.org_id = ${orgId} AND r.register_id = 'invoices' AND p.voided_at IS NULL
      AND ${keptEntry(sql)} AND p.withheld = 0 AND p.paid_on >= ${dayIn(Date.parse(`${earliest}T00:00:00Z`) - 15 * 86_400_000, "UTC")}
      AND NOT EXISTS (SELECT 1 FROM kin_bank_statement_entries e
        WHERE e.org_id = p.org_id AND e.payment_id = p.payment_id)
    ORDER BY p.paid_on, p.payment_id`;
  const vendors = yield* sql<{ vendor: string | null; category: string | null }>`
    SELECT json_extract(fields_json, '$.vendor') AS vendor, category FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'expenses' AND state = 'done'
      AND json_extract(fields_json, '$.vendor') IS NOT NULL
    ORDER BY updated_at DESC LIMIT 500`;
  const accounts = yield* sql<{ account: string }>`SELECT DISTINCT account FROM kin_bank_statements
    WHERE org_id = ${orgId} AND account IS NOT NULL ORDER BY account`;
  return {
    currency: statement.currency,
    bank: statement.bank,
    invoices: invoiceRows.map((row) => {
      const fields = parseFields(row.fieldsJson);
      const tax = fields.tax;
      return {
        recordId: row.recordId,
        key: row.key,
        title: row.title,
        currency: row.currency ?? home,
        amountMinor: row.amountMinor ?? 0,
        paidMinor: row.paid,
        seen: seenOf(row.amountMinor ?? 0, received.get(row.recordId) ?? []),
        taxMinor:
          typeof tax === "object" && tax !== null && !Array.isArray(tax) && "minor" in tax
            ? tax.minor
            : null,
        issued: day(row.dateAt),
        client: row.client,
        number: fieldText(fields, "number"),
      };
    }),
    payments,
    expenses: expenseRows
      .filter((row) => row.linked === 0)
      .map((row) => ({
        recordId: row.recordId,
        key: row.key,
        title: row.title,
        currency: row.currency ?? home,
        amountMinor: row.amountMinor ?? 0,
        day: day(row.dateAt),
        due: day(row.dueAt),
        open: row.state === "open",
        vendor: fieldText(parseFields(row.fieldsJson), "vendor"),
        repeats: row.repeats === 1,
      })),
    ownAccounts: accounts.map((row) => row.account).filter((one) => one !== statement.account),
    known: [
      ...new Map(
        vendors.flatMap((row) =>
          row.vendor === null ? [] : [[row.vendor.toLowerCase(), row] as const],
        ),
      ).values(),
    ].map((row) => ({ vendor: row.vendor!, category: row.category })),
  };
});

/** The bank rows this statement recorded an entry for, in the order it recorded them. */
const ownRows = Effect.fn("KinStatements.ownRows")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const rows = yield* sql<{
    recordId: string;
    key: string;
    state: KinRecordState;
    amountMinor: number | null;
    dateAt: number | null;
    fieldsJson: string;
  }>`SELECT r.record_id AS "recordId", r.key, r.state, r.amount_minor AS "amountMinor",
      r.date_at AS "dateAt", r.fields_json AS "fieldsJson"
    FROM kin_bank_statement_entries e
    JOIN kin_records r ON r.org_id = e.org_id AND r.record_id = e.bank_record_id
    WHERE e.org_id = ${orgId} AND e.statement_id = ${statementId}
    GROUP BY r.record_id ORDER BY MIN(e.seq)`;
  return rows.map((row) => {
    const fields = parseFields(row.fieldsJson);
    const balance = fields.balance;
    return {
      ...row,
      date: row.dateAt === null ? null : dayIn(row.dateAt, zone),
      direction: directionOf(fields),
      balanceMinor:
        typeof balance === "object" && balance !== null && "minor" in balance
          ? balance.minor
          : null,
    };
  });
});

/**
 * The review of a read statement: rows already explained are counted, the rest matched. Read
 * again, each row this statement recorded finds its row by day, amount and direction, however
 * the narration or reference reads now; one that finds none is named, and nothing is ticked.
 */
export const buildReview = Effect.fn("KinStatements.buildReview")(function* (
  orgId: KinOrgId,
  read: Statement,
  format: string | null,
  source: "file" | "agent",
  statementId: string,
) {
  const before = yield* statementRow(orgId, statementId);
  const stored = before?.reviewJson == null ? undefined : reviewOf(before.reviewJson);
  // Read before account identities, a statement keeps its rows' old identity on every read again.
  const { accountId: _accountId, ...legacy } = read;
  const statement =
    stored !== undefined && stored.statement.accountId === undefined ? legacy : read;
  const def = yield* findBankList(orgId);
  const found = yield* knownRows(orgId, def, statement, statementId);
  const known = new Map(found.known);
  const missing: Array<Missing> = [];
  const used = new Set<number>();
  for (const earlier of yield* ownRows(orgId, statementId)) {
    const fits = statement.rows.filter(
      (row) =>
        !used.has(row.index) &&
        row.date === earlier.date &&
        row.amountMinor === earlier.amountMinor &&
        row.direction === earlier.direction,
    );
    const row =
      (earlier.balanceMinor === null
        ? undefined
        : fits.find((one) => one.balanceMinor === earlier.balanceMinor)) ?? fits[0];
    if (row === undefined) {
      missing.push({
        key: earlier.key,
        date: earlier.date,
        amountMinor: earlier.amountMinor,
        direction: earlier.direction,
      });
      continue;
    }
    used.add(row.index);
    for (const [index, other] of known)
      if (other.recordId === earlier.recordId || index === row.index) known.delete(index);
    known.set(row.index, { recordId: earlier.recordId, key: earlier.key, state: earlier.state });
  }
  const states = def === undefined ? undefined : bankStates(def);
  const open = statement.rows.filter((row) => {
    const had = known.get(row.index);
    return had === undefined || (states !== undefined && had.state === states.open);
  });
  const results = matchRows(open, yield* candidates(orgId, statement, statementId));
  const alerts = yield* alertsOnReview(orgId, statement);
  // A possible duplicate is the owner's call: nothing is ticked or matched for it.
  const judged = open.map((row, index): RowMatch => {
    const like = found.possible.get(row.index);
    // The owner already recorded this line's money from its bank alert's card: it is that payment.
    const recorded = alerts.recorded.get(row.index);
    if (recorded !== undefined)
      return {
        group: "matched",
        candidates: [
          {
            kind: "invoice",
            recordId: recorded.recordId,
            key: recorded.key,
            title: recorded.title,
            fit: "recorded",
            paymentId: recorded.paymentId,
            score: 100,
            why: ["already recorded from its bank alert"],
          },
        ],
        suggestion: results[index]!.suggestion,
      };
    return like === undefined
      ? results[index]!
      : {
          group: "unmatched",
          candidates: [],
          suggestion: {
            action: "ignore",
            why: `It may already be in Bank transactions as ${like.key}, from another statement or account; ignore it if it is.`,
          },
        };
  });
  const alertsMissing = alerts.missing;
  return {
    statement,
    format,
    source,
    known,
    matches: new Map(open.map((row, index) => [row.index, judged[index]!])),
    ...(missing.length === 0 ? {} : { missing }),
    ...(alertsMissing.length === 0 ? {} : { alertsMissing }),
  } satisfies Review;
});

const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** The owner and their direct chat with the lead, where a statement's cards go. */
const ownerOf = Effect.fn("KinStatements.ownerOf")(function* (orgId: KinOrgId, agentId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    personId: string;
  }>`SELECT owner_person_id AS "personId" FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  if (row === undefined) return yield* invalid("No owner found.");
  return KinPersonId.make(row.personId);
});

/** Posts a card of Kin's own, for the owner alone, waiting on them; the same id twice is one card. */
export const postCard = Effect.fn("KinStatements.postCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly agentId: string;
  readonly widgetId: string;
  readonly type: string;
  readonly text: string;
  readonly state: unknown;
}) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const widgetId = KinWidgetId.make(input.widgetId);
  if (Option.isSome(yield* repo.getWidget({ orgId: input.orgId, widgetId }))) return widgetId;
  const owner = yield* ownerOf(input.orgId, input.agentId);
  const at = iso(yield* Clock.currentTimeMillis);
  const chatId = KinChatId.make(input.chatId);
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    chatId,
    audience: "owner",
    messageId: KinMessageId.make(input.widgetId),
    author: { _tag: "system" },
    kind: "system",
    body: input.text,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    clientMessageId: null,
    createdAt: at,
    editedAt: null,
  });
  const widget = {
    orgId: input.orgId,
    chatId,
    messageId: message.messageId,
    widgetId,
    widgetClass: "native" as const,
    type: input.type,
    state: input.state,
    source: null,
    feed: null,
    awaiting: [owner],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  };
  yield* repo.insertWidget({ ...widget, audience: "owner" });
  yield* sql.afterCommit(
    hub.publish({ type: "message.posted", orgId: input.orgId, message: { ...message, widgetId } }),
  );
  yield* sql.afterCommit(
    hub.publish({ type: "widget.updated", orgId: input.orgId, widget: { ...widget, revision: 1 } }),
  );
  return widgetId;
});

/**
 * Replaces a card's state, closing it when the owner has nothing more to do on it; reopened, it
 * waits on `awaiting` again when given.
 */
export const updateCard = Effect.fn("KinStatements.updateCard")(function* (
  orgId: KinOrgId,
  widgetId: string,
  state: unknown,
  closed: boolean,
  awaiting?: ReadonlyArray<KinPersonId>,
) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  if (Option.isNone(found)) return;
  const at = iso(yield* Clock.currentTimeMillis);
  const owner = found.value.awaiting.length > 0 ? found.value.awaiting : (awaiting ?? []);
  const widget = yield* repo.updateWidget({
    ...found.value,
    audience: "owner",
    state,
    awaiting: closed ? [] : owner,
    expectedRevision: found.value.revision,
    closedAt: closed ? at : null,
    updatedAt: at,
  });
  yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
});

/** The Expenses categories a new expense may take, or the preset's when there is no list yet. */
export const expenseCategories = Effect.fn("KinStatements.expenseCategories")(function* (
  orgId: KinOrgId,
) {
  const def = yield* listDef(orgId, "expenses");
  const listed = def?.categories ?? [
    "travel",
    "software",
    "hardware",
    "office",
    "meals",
    "contractors",
    "rent",
    "fees",
    "taxes",
    "other",
  ];
  // Confirm adds it to the list the first time a salary is recorded.
  return listed.includes(SALARIES) ? listed : [...listed, SALARIES];
});

const decodeSelection = Schema.decodeUnknownOption(Schema.fromJsonString(KinStatementSelection));
export const encodeSelection = Schema.encodeEffect(Schema.fromJsonString(KinStatementSelection));
/** The owner's selection on the stored review: Kin's proposal until they change it. */
export const selectionOf = (stored: Pick<StatementRow, "selectionJson">, review: Review) =>
  stored.selectionJson === null
    ? defaultSelection(review)
    : Option.getOrElse(decodeSelection(stored.selectionJson), () => defaultSelection(review));

/**
 * Rows this statement recorded that are still recorded: every row while it is applied, and after
 * an undo the ones it kept, such as a payment with a receipt. With the receipt that holds each.
 */
export const heldRows = Effect.fn("KinStatements.heldRows")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ row: number; receipt: string | null }>`SELECT e.row_index AS row,
      MAX((SELECT COALESCE(n.number, r.key) FROM kin_records r
        LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
        WHERE r.org_id = e.org_id AND r.register_id = 'receipts' AND r.state <> 'dropped'
          AND e.payment_id IS NOT NULL AND json_extract(r.fields_json, '$.payment') = e.payment_id
        ORDER BY r.created_at DESC, r.record_id DESC LIMIT 1)) AS receipt
    FROM kin_bank_statement_entries e
    WHERE e.org_id = ${orgId} AND e.statement_id = ${statementId}
    GROUP BY e.row_index ORDER BY e.row_index`;
  return new Map(
    rows.map((one) => [
      one.row,
      one.receipt === null ? "Already recorded" : `Already recorded · receipt ${one.receipt}`,
    ]),
  ) satisfies Held;
});

const decodeReviewCard = Schema.decodeUnknownOption(KinStatementReviewCard);
export const cardState = Effect.fn("KinStatements.cardState")(function* (
  orgId: KinOrgId,
  widgetId: string | null,
) {
  if (widgetId === null) return undefined;
  const repo = yield* KinChatRepository;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  if (Option.isNone(found)) return undefined;
  return Option.getOrUndefined(decodeReviewCard(found.value.state));
});

/**
 * Stores a read and posts its review card, in one write. A fresh read replaces the card before
 * it, so the owner never has two live cards for one statement, and starts from Kin's proposal.
 */
export const saveRead = Effect.fn("KinStatements.saveRead")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly review: Review;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const before = yield* statementRow(input.orgId, input.statementId);
  const earlier = before?.reviewJson == null ? undefined : reviewOf(before.reviewJson);
  // Read again, a row this statement already recorded may sit at another place: its entries follow
  // it. One this reading lacks keeps a place of its own below 0, so nothing it holds holds another.
  if (earlier !== undefined) {
    const places = new Map([...input.review.known].map(([index, row]) => [row.recordId, index]));
    const entries = yield* sql<{ seq: number; bankRecordId: string }>`SELECT seq,
        bank_record_id AS "bankRecordId" FROM kin_bank_statement_entries
      WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId} ORDER BY seq`;
    const orphans = new Map<string, number>();
    for (const entry of entries) {
      if (!places.has(entry.bankRecordId) && !orphans.has(entry.bankRecordId))
        orphans.set(entry.bankRecordId, -(orphans.size + 1));
      const place = places.get(entry.bankRecordId) ?? orphans.get(entry.bankRecordId)!;
      yield* sql`UPDATE kin_bank_statement_entries SET row_index = ${place}
        WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId} AND seq = ${entry.seq}`;
    }
  }
  // A card from an earlier read never confirms this one: its revision is always below.
  const selection = {
    ...defaultSelection(input.review),
    revision:
      before === undefined || earlier === undefined ? 0 : selectionOf(before, earlier).revision + 1,
  };
  const card = reviewCard(
    input.statementId,
    input.review,
    yield* expenseCategories(input.orgId),
    selection,
    yield* heldRows(input.orgId, input.statementId),
  );
  const json = yield* storeReview(input.review);
  // Each read gets its own card, so a fresh read never edits a card the owner is looking at.
  const widgetId = `kin-statement:${input.statementId}:${card.hash.slice(0, 12)}`;
  yield* sql`UPDATE kin_bank_statements SET status = 'read', reason = NULL,
      source = ${input.review.source}, account = ${input.review.statement.account},
      review_json = ${json}, review_hash = ${card.hash}, review_widget_id = ${widgetId},
      selection_json = ${yield* encodeSelection(selection)}, read_at = ${input.now},
      applied_at = NULL, applied_by = NULL,
      undone_at = NULL, pages_json = NULL, draft_json = NULL, proof_rounds = 0,
      generation = generation + ${earlier === undefined ? 0 : 1}
    WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
  yield* (yield* KinRefreshObserver).touch(input.orgId, "moneyStatements");
  const previous = before?.reviewWidgetId ?? null;
  // The same review read again is the same card, back to Kin's proposal and open.
  if (previous === widgetId)
    yield* updateCard(input.orgId, widgetId, card, false, [
      yield* ownerOf(input.orgId, input.agentId),
    ]);
  if (previous !== null && previous !== widgetId) {
    const old = yield* cardState(input.orgId, previous);
    if (old !== undefined && old.status !== "replaced")
      yield* updateCard(
        input.orgId,
        previous,
        {
          ...old,
          status: "replaced" as const,
          result: ["Kin read this statement again; the newer card below replaces this one."],
        },
        true,
      );
  }
  yield* postCard({
    orgId: input.orgId,
    chatId: input.chatId,
    agentId: input.agentId,
    widgetId,
    type: KIN_STATEMENT_REVIEW_CARD,
    text: STATEMENT_REVIEW_TEXT,
    state: card,
  });
  const choices = input.review.statement.currencyChoice;
  if (choices !== undefined)
    yield* postCard({
      orgId: input.orgId,
      chatId: input.chatId,
      agentId: input.agentId,
      widgetId: currencyCardId(input.statementId, card.hash),
      type: "choice",
      text: CURRENCY_QUESTION,
      state: choiceCardState({
        question: CURRENCY_QUESTION,
        detail: `Kin couldn't tell from ${clamp(before?.fileName ?? "the file", 80)}. Kin's guess is ${choices[0]}.`,
        options: choices.slice(0, 8).map((code) => ({ label: code })),
      }),
    });
  return card;
});

const CURRENCY_QUESTION = "Which currency is this statement in?";
const CURRENCY_CARD = "kin-statement-currency:";
const currencyCardId = (statementId: string, hash: string) =>
  `${CURRENCY_CARD}${statementId}:${hash.slice(0, 12)}`;

/**
 * The owner's pick on a statement's currency card: its review, figures unchanged since every
 * choice has the same minor units, is matched again in that currency on a fresh card.
 */
export const answerCurrencyCard = Effect.fn("KinStatements.answerCurrency")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly code: string;
  readonly now: number;
}) {
  if (!input.widgetId.startsWith(CURRENCY_CARD)) return;
  const statementId = input.widgetId.slice(CURRENCY_CARD.length).split(":")[0]!;
  const stored = yield* statementRow(input.orgId, statementId);
  if (stored === undefined) return;
  if (!(yield* ownerLevel(input.orgId, KinPersonId.make(input.personId))))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner picks a statement's currency.",
    });
  const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
  const choices = review?.statement.currencyChoice;
  if (
    review === undefined ||
    stored.appliedAt !== null ||
    currencyCardId(statementId, stored.reviewHash ?? "") !== input.widgetId ||
    choices === undefined
  )
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This statement was read again or confirmed since; use its latest card.",
    });
  if (!choices.includes(input.code)) return yield* invalid("Pick one of the card's currencies.");
  const { currencyChoice: _choice, ...rest } = review.statement;
  const statement = { ...rest, currency: input.code };
  const next = yield* buildReview(
    input.orgId,
    statement,
    review.format,
    review.source,
    statementId,
  );
  yield* saveRead({
    orgId: input.orgId,
    statementId,
    agentId: stored.agentId,
    chatId: stored.chatId,
    review: next,
    now: input.now,
  });
  return input.code;
});

const PASSWORD_TEXT =
  "This statement is password-protected. Type its password on its card to open it.";

/** Asks the owner for a PDF's password on a card of its own. */
export const askPassword = Effect.fn("KinStatements.askPassword")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly fileName: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const stored = yield* statementRow(input.orgId, input.statementId);
  const first = `kin-statement-password:${input.statementId}`;
  const current = stored?.passwordWidgetId ?? first;
  const shown = yield* repo.getWidget({ orgId: input.orgId, widgetId: KinWidgetId.make(current) });
  // Asked again after its card closed, as when the statement is read again: a fresh card below.
  const again = Option.isSome(shown) && shown.value.closedAt !== null;
  const widgetId = again ? `${first}:${yield* Clock.currentTimeMillis}` : current;
  yield* sql`UPDATE kin_bank_statements SET status = 'needs_password', password_widget_id = ${widgetId}
    WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
  yield* postCard({
    orgId: input.orgId,
    chatId: input.chatId,
    agentId: input.agentId,
    widgetId,
    type: KIN_STATEMENT_PASSWORD_CARD,
    text: PASSWORD_TEXT,
    state: {
      text: PASSWORD_TEXT,
      statementId: input.statementId,
      fileName: clamp(input.fileName, 200),
      status: "locked",
    } satisfies KinStatementPasswordCard,
  });
  return widgetId;
});

const decodePasswordCard = Schema.decodeUnknownOption(KinStatementPasswordCard);
/** A line of Kin's on a statement's password card, such as why it stopped trying chat passwords. */
export const notePasswordCard = Effect.fn("KinStatements.notePasswordCard")(function* (
  orgId: KinOrgId,
  widgetId: string,
  detail: string,
) {
  const repo = yield* KinChatRepository;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  const card = Option.isNone(found)
    ? undefined
    : Option.getOrUndefined(decodePasswordCard(found.value.state));
  if (card !== undefined && card.detail !== detail)
    yield* updateCard(orgId, widgetId, { ...card, detail }, false);
});

// Passwords the owner asked Kin to keep, one per account, in the server's own secret store.
const secretName = (orgId: string, accountKey: string) =>
  `kin-statement-${hash(`${orgId.length}:${orgId}${accountKey}`).slice(0, 24)}`;
const accountKeyOf = (statement: Pick<Statement, "bank" | "account" | "kind">) =>
  `${statement.kind}:${(statement.bank ?? "").toLowerCase()}:${statement.account ?? ""}`;

/** Tries each kept password on a locked file: the read, or why it still can't be read. */
export const tryKeptPasswords = Effect.fn("KinStatements.tryKept")(function* (
  orgId: KinOrgId,
  bytes: Uint8Array,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const home = yield* homeCurrency(orgId);
  const kept = yield* sql<{ secretName: string }>`SELECT secret_name AS "secretName"
    FROM kin_statement_passwords WHERE org_id = ${orgId} ORDER BY remembered_at DESC`;
  for (const one of kept) {
    const value = yield* secrets
      .get(one.secretName)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(value)) continue;
    const password = Redacted.make(new TextDecoder().decode(value.value));
    const outcome = yield* readWith(bytes, home, password);
    if (outcome._tag !== "wrong_password" && outcome._tag !== "needs_password") return outcome;
  }
  return undefined;
});

/**
 * Reads a statement file, with a password for a locked PDF; nothing of it leaves this call. `home`
 * is the company's home currency, which picks the region an unlabelled file reads in.
 */
export const readWith = (bytes: Uint8Array, home: string, password?: Redacted.Redacted<string>) =>
  readIsolated(bytes, home, password).pipe(Effect.flatMap(identified));

const ACCOUNT_KEY = "kin-bank-account-key";
/**
 * The file's full account number as its keyed identity with its bank, so two accounts that end
 * in the same four digits stay two; the number itself is dropped here and never kept.
 */
const identified = Effect.fn("KinStatements.identified")(function* (outcome: FileOutcome) {
  if (outcome._tag !== "read" && outcome._tag !== "pages") return outcome;
  const facts = outcome._tag === "read" ? outcome.statement : outcome.facts;
  const number = facts.accountNumber;
  const bank = facts.bank;
  const accountId =
    number == null || bank === null
      ? null
      : yield* (yield* ServerSecretStore.ServerSecretStore).getOrCreateRandom(ACCOUNT_KEY, 32).pipe(
          Effect.map((key) =>
            NodeCrypto.createHmac("sha256", key)
              .update(`${bank.toLowerCase()}|${number}`)
              .digest("hex")
              .slice(0, 32),
          ),
          // Without the key the account stays unidentified, whose rows Kin never merges on its own.
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't key a statement's account", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
  if (outcome._tag === "read") {
    const { accountNumber: _number, ...statement } = outcome.statement;
    return { ...outcome, statement: { ...statement, accountId } };
  }
  const { accountNumber: _number, ...kept } = outcome.facts;
  return { ...outcome, facts: { ...kept, accountId } };
});

export const keepPassword = Effect.fn("KinStatements.keepPassword")(function* (
  orgId: KinOrgId,
  statement: Pick<Statement, "bank" | "account" | "kind">,
  password: Redacted.Redacted<string>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const accountKey = accountKeyOf(statement);
  const name = secretName(orgId, accountKey);
  yield* secrets.set(name, new TextEncoder().encode(Redacted.value(password)));
  const label =
    statement.account === null
      ? (statement.bank ?? "this account")
      : `${statement.bank ?? "account"} ••${statement.account}`;
  yield* sql`INSERT INTO kin_statement_passwords (org_id, account_key, label, secret_name, remembered_at)
    VALUES (${orgId}, ${accountKey}, ${label}, ${name}, ${now})
    ON CONFLICT (org_id, account_key) DO UPDATE SET remembered_at = excluded.remembered_at`;
  return label;
});

export const forgetPassword = (
  orgId: KinOrgId,
  statement: Pick<Statement, "bank" | "account" | "kind">,
) => forgetAccount(orgId, accountKeyOf(statement));

/** Forgets the password kept for one account; the next locked statement of it asks again. */
export const forgetAccount = Effect.fn("KinStatements.forgetAccount")(function* (
  orgId: KinOrgId,
  accountKey: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  yield* secrets.remove(secretName(orgId, accountKey));
  yield* sql`DELETE FROM kin_statement_passwords WHERE org_id = ${orgId} AND account_key = ${accountKey}`;
});

/** The accounts whose statement password Kin keeps, newest first; never the password. */
export const keptAccounts = Effect.fn("KinStatements.keptAccounts")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ account: string; label: string; rememberedAt: number }>`SELECT
      account_key AS account, label, remembered_at AS "rememberedAt"
    FROM kin_statement_passwords WHERE org_id = ${orgId} ORDER BY remembered_at DESC, account_key`;
  return {
    accounts: rows.map((row) => ({
      account: row.account,
      label: row.label,
      rememberedAt: iso(row.rememberedAt),
    })),
  };
});
