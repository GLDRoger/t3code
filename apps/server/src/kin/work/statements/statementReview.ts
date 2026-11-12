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
  type KinStatementPasswordCard,
  type KinStatementReviewCard,
  type KinStatementTarget,
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

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import { KinChatHub } from "../../chat/KinChatHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { fieldText, parseFields } from "../lists.ts";
import { dayIn, formatMoney } from "../money.ts";
import { ownerZone } from "../recordRows.ts";
import { listDef } from "../registers.ts";
import { bankStates, findBankList, type KnownRow, knownRows } from "./bankList.ts";
import { type FileOutcome, readStatementFile } from "./statementFiles.ts";
import { type Candidate, matchRows, type RowMatch } from "./statementMatch.ts";
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
});
export type Review = {
  readonly statement: Statement;
  readonly format: string | null;
  readonly source: "file" | "agent";
  readonly known: ReadonlyMap<number, KnownRow>;
  /** Every row not already explained in Bank transactions. */
  readonly matches: ReadonlyMap<number, RowMatch>;
};
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
    }),
  });
const storeReview = (review: Review) =>
  encodeReview({
    statement: review.statement,
    format: review.format,
    source: review.source,
    known: [...review.known.entries()],
    matches: [...review.matches.entries()],
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
      password_widget_id AS "passwordWidgetId", applied_at AS "appliedAt", undone_at AS "undoneAt"
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

/** Open invoices and expenses the rows may be, with the owner's own accounts and vendors. */
const candidates = Effect.fn("KinStatements.candidates")(function* (
  orgId: KinOrgId,
  statement: Statement,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const day = (ms: number | null) => (ms === null ? null : dayIn(ms, zone));
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
      AND r.amount_minor IS NOT NULL
    ORDER BY r.key`;
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
      AND r.amount_minor IS NOT NULL
      AND COALESCE(r.date_at, r.due_at, r.created_at) >= ${Date.parse(`${statement.rows[0]?.date ?? "2000-01-01"}T00:00:00Z`) - 60 * 86_400_000}
    ORDER BY r.key`;
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
        currency: row.currency ?? "INR",
        amountMinor: row.amountMinor ?? 0,
        paidMinor: row.paid,
        taxMinor:
          typeof tax === "object" && tax !== null && !Array.isArray(tax) && "minor" in tax
            ? tax.minor
            : null,
        issued: day(row.dateAt),
        client: row.client,
        number: fieldText(fields, "number"),
      };
    }),
    expenses: expenseRows
      .filter((row) => row.linked === 0)
      .map((row) => ({
        recordId: row.recordId,
        key: row.key,
        title: row.title,
        currency: row.currency ?? "INR",
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

/** The review of a read statement: rows already explained are counted, the rest matched. */
export const buildReview = Effect.fn("KinStatements.buildReview")(function* (
  orgId: KinOrgId,
  statement: Statement,
  format: string | null,
  source: "file" | "agent",
) {
  const def = yield* findBankList(orgId);
  const known = yield* knownRows(orgId, def, statement);
  const states = def === undefined ? undefined : bankStates(def);
  const open = statement.rows.filter((row) => {
    const had = known.get(row.index);
    return had === undefined || (states !== undefined && had.state === states.open);
  });
  const results = matchRows(open, yield* candidates(orgId, statement));
  return {
    statement,
    format,
    source,
    known,
    matches: new Map(open.map((row, index) => [row.index, results[index]!])),
  } satisfies Review;
});

const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};
const SHORT = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const shortDay = (day: string) => SHORT.format(Date.parse(`${day}T00:00:00Z`));
const money = (minor: number, currency: string) => formatMoney({ minor, currency });

const target = (candidate: Candidate, option: number, currency: string): KinStatementTarget => ({
  option,
  kind: candidate.kind,
  key: candidate.key,
  label: clamp(`${candidate.key} · ${candidate.title}`, 200),
  ...(candidate.fit === "tds" && candidate.tdsMinor !== undefined
    ? { note: `Paid with ${money(candidate.tdsMinor, currency)} TDS deducted` }
    : candidate.fit === "part"
      ? { note: "Part payment" }
      : candidate.fit === "foreign"
        ? { note: "Same amount in its own currency" }
        : {}),
});

const STATEMENT_REVIEW_TEXT =
  "Kin read a bank statement and matched its rows. Review and confirm them on its card.";

/** The review card: what the owner confirms, and the hash that binds a confirm to it. */
export const reviewCard = (
  statementId: string,
  review: Review,
  categories: ReadonlyArray<string>,
): KinStatementReviewCard => {
  const { statement } = review;
  const currency = statement.currency;
  const shown = (index: number) => {
    const row = statement.rows[index]!;
    return {
      row: index,
      date: row.date,
      text: clamp(row.description, 120),
      amount: money(row.amountMinor, currency),
      direction: row.direction,
    };
  };
  const matched: Array<KinStatementReviewCard["matched"][number]> = [];
  const choose: Array<KinStatementReviewCard["choose"][number]> = [];
  const unmatched: Array<KinStatementReviewCard["unmatched"][number]> = [];
  for (const [index, match] of [...review.matches.entries()].toSorted(
    ([left], [right]) => left - right,
  )) {
    if (match.group === "matched")
      matched.push({ ...shown(index), target: target(match.candidates[0]!, 0, currency) });
    else if (match.group === "choose")
      choose.push({
        ...shown(index),
        options: match.candidates.map((one, option) => target(one, option, currency)),
      });
    else
      unmatched.push({
        ...shown(index),
        suggestion: match.suggestion.action,
        ...(match.suggestion.why === undefined ? {} : { why: clamp(match.suggestion.why, 200) }),
        ...(match.suggestion.vendor === undefined
          ? {}
          : { vendor: clamp(match.suggestion.vendor, 120) }),
        ...(match.suggestion.category === undefined ? {} : { category: match.suggestion.category }),
      });
  }
  const credits = statement.rows.filter((row) => row.direction === "credit");
  const debits = statement.rows.filter((row) => row.direction === "debit");
  const total = (rows: typeof credits) =>
    money(
      rows.reduce((sum, row) => sum + row.amountMinor, 0),
      currency,
    );
  const recorded = statement.rows.length - review.matches.size;
  const account =
    statement.account === null
      ? (statement.bank ?? "Statement")
      : `${statement.bank ?? (statement.kind === "card" ? "Card" : "Account")} ••${statement.account}`;
  const period =
    statement.from !== null && statement.to !== null
      ? ` · ${shortDay(statement.from)} to ${shortDay(statement.to)}`
      : "";
  const shownSet = JSON.stringify({
    statementId,
    matched: matched.map((one) => [one.row, review.matches.get(one.row)!.candidates[0]!.recordId]),
    choose: choose.map((one) => [
      one.row,
      review.matches.get(one.row)!.candidates.map((c) => c.recordId),
    ]),
    unmatched: unmatched.map((one) => one.row),
    recorded,
  });
  return {
    text: STATEMENT_REVIEW_TEXT,
    statementId,
    hash: hash(shownSet).slice(0, 32),
    title: clamp(`${account}${period}`, 200),
    summary: [
      `${statement.rows.length} rows: ${credits.length} in (${total(credits)}), ${debits.length} out (${total(debits)}).`,
      ...(statement.openingMinor === null || statement.closingMinor === null
        ? []
        : [
            `Opening ${money(statement.openingMinor, currency)}, closing ${money(statement.closingMinor, currency)}.`,
          ]),
      statement.check.line,
      ...(recorded === 0
        ? []
        : [`${recorded} already in Bank transactions from an earlier statement.`]),
      ...(review.source === "agent"
        ? ["Kin read these rows from images of a scanned statement: check them against it."]
        : []),
    ].map((line) => clamp(line, 300)),
    balance: statement.check.status,
    ...(review.source === "agent" ? { readByAgent: true as const } : {}),
    matched,
    choose,
    unmatched,
    recorded,
    categories: [...categories],
    status: "open",
  };
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
const postCard = Effect.fn("KinStatements.postCard")(function* (input: {
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

/** Replaces a card's state, closing it when the owner has nothing more to do on it. */
export const updateCard = Effect.fn("KinStatements.updateCard")(function* (
  orgId: KinOrgId,
  widgetId: string,
  state: unknown,
  closed: boolean,
) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) });
  if (Option.isNone(found)) return;
  const at = iso(yield* Clock.currentTimeMillis);
  const owner = found.value.awaiting.length > 0 ? found.value.awaiting : [];
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
  return (
    def?.categories ?? [
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
    ]
  );
});

/** Stores a read and posts its review card, in one write. */
export const saveRead = Effect.fn("KinStatements.saveRead")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly review: Review;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const card = reviewCard(input.statementId, input.review, yield* expenseCategories(input.orgId));
  const json = yield* storeReview(input.review);
  // Each read gets its own card, so a fresh read never edits a card the owner is looking at.
  const widgetId = `kin-statement:${input.statementId}:${card.hash.slice(0, 12)}`;
  yield* sql`UPDATE kin_bank_statements SET status = 'read', reason = NULL,
      source = ${input.review.source}, account = ${input.review.statement.account},
      review_json = ${json}, review_hash = ${card.hash}, review_widget_id = ${widgetId},
      read_at = ${input.now}, applied_at = NULL, applied_by = NULL, undone_at = NULL
    WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
  yield* postCard({
    orgId: input.orgId,
    chatId: input.chatId,
    agentId: input.agentId,
    widgetId,
    type: KIN_STATEMENT_REVIEW_CARD,
    text: STATEMENT_REVIEW_TEXT,
    state: card,
  });
  return card;
});

const PASSWORD_TEXT =
  "This statement is password-protected. Type its password on its card, never in a message.";

/** Asks the owner for a PDF's password on a card of its own. */
export const askPassword = Effect.fn("KinStatements.askPassword")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly fileName: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const widgetId = `kin-statement-password:${input.statementId}`;
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
  const kept = yield* sql<{ secretName: string }>`SELECT secret_name AS "secretName"
    FROM kin_statement_passwords WHERE org_id = ${orgId} ORDER BY remembered_at DESC`;
  for (const one of kept) {
    const value = yield* secrets
      .get(one.secretName)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(value)) continue;
    const password = Redacted.make(new TextDecoder().decode(value.value));
    const outcome = yield* readWith(bytes, password);
    if (outcome._tag !== "wrong_password" && outcome._tag !== "needs_password") return outcome;
  }
  return undefined;
});

/** Reads a statement file, with a password for a locked PDF; nothing of it leaves this call. */
export const readWith = (bytes: Uint8Array, password?: Redacted.Redacted<string>) =>
  Effect.promise((): Promise<FileOutcome> =>
    readStatementFile(bytes, password === undefined ? undefined : Redacted.value(password)).catch(
      () => ({
        _tag: "unreadable",
        reason: "Kin couldn't read this file.",
      }),
    ),
  );

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

export const forgetPassword = Effect.fn("KinStatements.forgetPassword")(function* (
  orgId: KinOrgId,
  statement: Pick<Statement, "bank" | "account" | "kind">,
) {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const accountKey = accountKeyOf(statement);
  yield* secrets.remove(secretName(orgId, accountKey));
  yield* sql`DELETE FROM kin_statement_passwords WHERE org_id = ${orgId} AND account_key = ${accountKey}`;
});
