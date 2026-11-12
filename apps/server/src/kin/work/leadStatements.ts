import { KinChatError, KinDay, type KinOrgId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChat } from "../lead/Audience.ts";
import { turnFiles } from "./leadFields.ts";
import { admitted, type Lead, leadTool, sourceOf } from "./leadWork.ts";
import { formatMoney, parseAmount } from "./money.ts";
import { bankStates, findBankList, originKeyOf, rowFingerprints } from "./statements/bankList.ts";
import {
  askPassword,
  attachmentBytes,
  buildReview,
  type Review,
  reviewOf,
  readWith,
  saveRead,
  statementIdFor,
  statementRow,
  tryKeptPasswords,
} from "./statements/statementReview.ts";
import { checkBalances, type Statement, type StatementRow } from "./statements/statementTable.ts";

/** The lead tools for statements. Kin reads and matches; the owner confirms on Kin's card. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isChatError = Schema.is(KinChatError);
const Amount = TrimmedNonEmptyString.check(Schema.isMaxLength(40));

export const ReadInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString,
  attachment: TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
    description:
      "The statement file's id or name, as this turn's message or an earlier one in this chat shows it.",
  }),
  account: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}$/))).annotate({
    description:
      "Its account's or card's last four digits, only when the owner said them and the statement doesn't.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description: "Read it again and post a fresh card, after invoices or expenses changed.",
  }),
  rows: Schema.optional(
    Schema.Array(
      Schema.Struct({
        date: KinDay,
        description: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
        amount: Amount,
        direction: Schema.Literals(["debit", "credit"]),
        reference: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
        balance: Schema.optional(Amount),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(5_000)),
  ).annotate({
    description:
      "Only for a scanned statement Kin said has no text: the rows you read from its page images, amounts as printed.",
  }),
  opening: Schema.optional(Amount),
  closing: Schema.optional(Amount),
  bank: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  kind: Schema.optional(Schema.Literals(["account", "card"])),
});
const Shown = Schema.Struct({
  row: Schema.Number,
  date: Schema.String,
  text: Schema.String,
  amount: Schema.String,
  direction: Schema.String,
  to: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  suggestion: Schema.optional(Schema.String),
});
export const ReadResult = Schema.Struct({
  statement: Schema.String,
  status: Schema.Literals(["read", "needs_password", "scanned", "unreadable", "applied"]),
  file: Schema.String,
  account: Schema.optional(Schema.String),
  period: Schema.optional(Schema.String),
  rows: Schema.optional(Schema.Number),
  balance: Schema.optional(Schema.String),
  counts: Schema.optional(
    Schema.Struct({
      matched: Schema.Number,
      choose: Schema.Number,
      unmatched: Schema.Number,
      recorded: Schema.Number,
    }),
  ),
  matched: Schema.optional(Schema.Array(Shown)),
  choose: Schema.optional(Schema.Array(Shown)),
  unmatched: Schema.optional(Schema.Array(Shown)),
  more: Schema.optional(Schema.String),
  next: Schema.String,
  sensitive: Schema.Literal(true),
});

/** The file a lead names: on this turn's messages, else an owner's earlier message in this chat. */
const fileNamed = Effect.fn("KinStatements.fileNamed")(function* (
  lead: Lead,
  chatId: string,
  named: string,
) {
  const here = (yield* turnFiles(lead)).find((file) => file.id === named || file.name === named);
  if (here !== undefined) return here;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ id: string; name: string }>`SELECT json_extract(f.value, '$.id') AS id,
      json_extract(f.value, '$.name') AS name
    FROM kin_messages m JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = ${lead.agentId},
      json_each(COALESCE(m.attachments_json, '[]')) f
    WHERE m.org_id = ${lead.orgId} AND m.chat_id = ${chatId} AND m.status <> 'deleted'
      AND m.author_kind = 'human' AND m.author_person_id = a.owner_person_id
      AND (json_extract(f.value, '$.id') = ${named} OR json_extract(f.value, '$.name') = ${named})
    ORDER BY m.seq DESC LIMIT 1`;
  if (row === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No file ${named.slice(0, 80)} from the owner in this chat. Use the file's id or name as its message shows it.`,
    });
  return row;
});

const fromRows = (input: typeof ReadInput.Type): Statement | KinChatError => {
  const money = (text: string) => {
    const parsed = parseAmount(text.replace(/\b(cr|dr)\b\.?/gi, ""), "INR");
    return "error" in parsed ? parsed.error : parsed.money.minor;
  };
  const rows: Array<StatementRow> = [];
  for (const [index, row] of (input.rows ?? []).entries()) {
    const amount = money(row.amount);
    if (typeof amount !== "number") return invalid(`Row ${index + 1}: ${amount.message}`);
    const balance = row.balance === undefined ? null : money(row.balance);
    if (balance !== null && typeof balance !== "number")
      return invalid(`Row ${index + 1}: ${balance.message}`);
    rows.push({
      index,
      date: row.date,
      description: row.description,
      reference: row.reference === undefined || row.reference === "" ? null : row.reference,
      amountMinor: amount,
      direction: row.direction,
      balanceMinor: balance,
      foreign: null,
    });
  }
  const opening = input.opening === undefined ? null : money(input.opening);
  const closing = input.closing === undefined ? null : money(input.closing);
  if (opening !== null && typeof opening !== "number") return opening;
  if (closing !== null && typeof closing !== "number") return closing;
  const days = rows.map((row) => row.date).toSorted();
  const kind = input.kind ?? "account";
  return {
    kind,
    bank: input.bank ?? null,
    account: input.account ?? null,
    currency: "INR",
    from: days[0] ?? null,
    to: days.at(-1) ?? null,
    openingMinor: opening,
    closingMinor: closing,
    rows,
    check: checkBalances(kind, rows, opening, closing, "INR"),
  };
};

const LIST = 15;
const describe = (statementId: string, file: string, review: Review, applied: boolean) => {
  const { statement } = review;
  const currency = statement.currency;
  const shown = (index: number) => {
    const row = statement.rows[index]!;
    return {
      row: index,
      date: row.date,
      text: row.description.slice(0, 120),
      amount: formatMoney({ minor: row.amountMinor, currency }),
      direction: row.direction,
    };
  };
  const entries = [...review.matches.entries()];
  const of = (group: string) => entries.filter(([, match]) => match.group === group);
  const note = (fit: string, tds: number | undefined) =>
    fit === "tds" && tds !== undefined
      ? ` (paid with ${formatMoney({ minor: tds, currency })} TDS deducted)`
      : fit === "part"
        ? " (part payment)"
        : "";
  const matched = of("matched");
  const choose = of("choose");
  const unmatched = of("unmatched");
  const total = matched.length + choose.length + unmatched.length;
  return {
    statement: statementId,
    status: applied ? ("applied" as const) : ("read" as const),
    file,
    ...(statement.account === null
      ? {}
      : { account: `${statement.bank ?? "Account"} ••${statement.account}` }),
    ...(statement.from === null || statement.to === null
      ? {}
      : { period: `${statement.from} to ${statement.to}` }),
    rows: statement.rows.length,
    balance: statement.check.line,
    counts: {
      matched: matched.length,
      choose: choose.length,
      unmatched: unmatched.length,
      recorded: statement.rows.length - total,
    },
    matched: matched.slice(0, LIST).map(([index, match]) => ({
      ...shown(index),
      to: `${match.candidates[0]!.key}${note(match.candidates[0]!.fit, match.candidates[0]!.tdsMinor)}`,
    })),
    choose: choose.slice(0, LIST).map(([index, match]) => ({
      ...shown(index),
      options: match.candidates.map((one) => `${one.key}${note(one.fit, one.tdsMinor)}`),
    })),
    unmatched: unmatched.slice(0, LIST).map(([index, match]) => ({
      ...shown(index),
      suggestion:
        match.suggestion.action === "expense"
          ? `new expense${match.suggestion.vendor === undefined ? "" : `: ${match.suggestion.vendor}`}${match.suggestion.category === undefined ? "" : ` (${match.suggestion.category})`}`
          : match.suggestion.action,
    })),
    ...(Math.max(matched.length, choose.length, unmatched.length) > LIST
      ? { more: "statement_rows has every row and its matches." }
      : {}),
    next: applied
      ? "The owner already confirmed this statement on its card; Money and Invoices show it. Answer from it in a line or two."
      : "Kin posted one review card to the owner with these matches. Nothing is recorded until they confirm on it, and you can't apply any of it yourself: never call payment_record or record_update for these rows. Say in one or two lines what Kin found (rows, how many matched, whether it adds up) and point them to the card.",
    sensitive: true as const,
  };
};

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof ReadInput.Type) {
  yield* admitted(lead, "statement_read", input);
  yield* sourceOf(lead, input.sourceEventId);
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("This turn has no chat to read a statement in.");
  const file = yield* fileNamed(lead, chat.chatId, input.attachment);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const statementId = statementIdFor(lead.orgId, file.id);
  yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
      chat_id, agent_id, wakeup_id, status, created_at)
    VALUES (${lead.orgId}, ${statementId}, ${file.id}, ${file.name}, ${chat.chatId},
      ${lead.agentId}, ${lead.wakeupId}, 'unreadable', ${now})
    ON CONFLICT (org_id, statement_id) DO NOTHING`;
  const stored = (yield* statementRow(lead.orgId, statementId))!;
  const base = { statement: statementId, file: file.name, sensitive: true as const };
  if (stored.status === "read" && input.refresh !== true && input.rows === undefined) {
    const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
    if (review !== undefined)
      return describe(statementId, file.name, review, stored.appliedAt !== null);
  }
  if (stored.appliedAt !== null && input.refresh === true)
    return yield* invalid(
      "The owner already applied this statement. Reading it again would show its rows as recorded; ask them to undo it on its card first if something is wrong.",
    );
  const post = (review: Review) =>
    sql.withTransaction(
      saveRead({
        orgId: lead.orgId,
        statementId,
        agentId: lead.agentId,
        chatId: chat.chatId,
        review,
        now,
      }),
    );
  if (input.rows !== undefined) {
    if (stored.status !== "scanned")
      return yield* invalid("Pass rows only for a scanned statement Kin couldn't read itself.");
    const statement = fromRows(input);
    if (isChatError(statement)) return yield* statement;
    yield* post(yield* buildReview(lead.orgId, statement, null, "agent"));
    return describe(statementId, file.name, yield* storedReview(lead.orgId, statementId), false);
  }
  const bytes = yield* attachmentBytes(file.id);
  let outcome = yield* readWith(bytes);
  if (outcome._tag === "needs_password")
    outcome = (yield* tryKeptPasswords(lead.orgId, bytes)) ?? outcome;
  if (outcome._tag === "needs_password" || outcome._tag === "wrong_password") {
    yield* sql.withTransaction(
      askPassword({
        orgId: lead.orgId,
        statementId,
        agentId: lead.agentId,
        chatId: chat.chatId,
        fileName: file.name,
      }),
    );
    return {
      ...base,
      status: "needs_password" as const,
      next: "The file is password-protected. Kin asked the owner for the password on a card of its own; it goes to Kin, never to you or the chat. Say in one line that the statement is locked and they can open it on the card. Never ask them to type the password in a message.",
    };
  }
  if (outcome._tag === "scanned" || outcome._tag === "unreadable") {
    const scanned = outcome._tag === "scanned";
    const reason = outcome._tag === "unreadable" ? outcome.reason : null;
    yield* sql`UPDATE kin_bank_statements SET status = ${scanned ? "scanned" : "unreadable"},
        reason = ${reason}
      WHERE org_id = ${lead.orgId} AND statement_id = ${statementId}`;
    return {
      ...base,
      status: outcome._tag,
      next: scanned
        ? "The PDF is a scan with no text, so Kin can't read its rows itself. Read the pages as images yourself if you can, and call statement_read again with rows: every row as printed, plus opening and closing if shown. Kin checks them, matches them and puts them to the owner on the same card, marked as read by you. If you can't read the pages, say so in one line."
        : `Kin couldn't read it: ${reason ?? ""} Say so in one line and ask for the PDF, CSV or Excel download from their bank.`,
    };
  }
  const statement: Statement =
    outcome.statement.account === null && input.account !== undefined
      ? { ...outcome.statement, account: input.account }
      : outcome.statement;
  yield* post(yield* buildReview(lead.orgId, statement, outcome.format, "file"));
  return describe(statementId, file.name, yield* storedReview(lead.orgId, statementId), false);
});
export const read = leadTool("KinStatementTools.read", runRead);

const storedReview = Effect.fn("KinStatements.storedReview")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const row = yield* statementRow(orgId, statementId);
  const review =
    row?.reviewJson === null || row === undefined ? undefined : reviewOf(row.reviewJson);
  if (review === undefined) return yield* invalid("That statement hasn't been read.");
  return review;
});

export const RowsInput = Schema.Struct({
  statement: TrimmedNonEmptyString.check(Schema.isMaxLength(40)).annotate({
    description: "The statement id statement_read returned.",
  }),
  group: Schema.optional(Schema.Literals(["matched", "choose", "unmatched", "recorded", "all"])),
  text: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))).annotate({
    description: "Only rows whose narration or reference has this.",
  }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
});
export const RowsResult = Schema.Struct({
  statement: Schema.String,
  total: Schema.Number,
  rows: Schema.Array(
    Schema.Struct({
      row: Schema.Number,
      date: Schema.String,
      description: Schema.String,
      reference: Schema.optional(Schema.String),
      amount: Schema.String,
      direction: Schema.String,
      balance: Schema.optional(Schema.String),
      group: Schema.String,
      candidates: Schema.optional(
        Schema.Array(
          Schema.Struct({ key: Schema.String, title: Schema.String, why: Schema.String }),
        ),
      ),
      suggestion: Schema.optional(Schema.String),
      saved: Schema.optional(Schema.Struct({ key: Schema.String, state: Schema.String })),
    }),
  ),
  sensitive: Schema.Literal(true),
});

const runRows = Effect.fnUntraced(function* (lead: Lead, input: typeof RowsInput.Type) {
  const stored = yield* statementRow(lead.orgId, input.statement);
  if (stored === undefined || stored.agentId !== lead.agentId)
    return yield* new KinChatError({
      reason: "not_found",
      message: "No statement by that id; statement_read returns it.",
    });
  const review = yield* storedReview(lead.orgId, input.statement);
  const { statement } = review;
  const currency = statement.currency;
  const groupOf = (index: number) => review.matches.get(index)?.group ?? "recorded";
  const needle = input.text?.toLowerCase();
  const picked = statement.rows.filter(
    (row) =>
      (input.group === undefined || input.group === "all" || groupOf(row.index) === input.group) &&
      (needle === undefined ||
        row.description.toLowerCase().includes(needle) ||
        (row.reference ?? "").toLowerCase().includes(needle)),
  );
  const offset = input.offset ?? 0;
  const page = picked.slice(offset, offset + (input.limit ?? 50));
  // What became of each row, once the owner applied the statement or an earlier one.
  const def = yield* findBankList(lead.orgId);
  const saved = new Map<number, { key: string; state: string }>();
  if (def !== undefined && page.length > 0) {
    const sql = yield* SqlClient.SqlClient;
    const fingerprints = rowFingerprints(statement);
    const keys = page.map((row) => originKeyOf(fingerprints[row.index]!));
    const found = yield* sql<{ key: string; state: string; originKey: string }>`SELECT key, state,
        origin_key AS "originKey" FROM kin_records
      WHERE org_id = ${lead.orgId} AND register_id = ${def.id} AND origin_key IN ${sql.in(keys)}
      ORDER BY key`;
    const labels = bankStates(def);
    for (const row of page) {
      const hit =
        found.find((one) => one.originKey === originKeyOf(fingerprints[row.index]!)) ??
        Option.getOrUndefined(Option.fromNullishOr(review.known.get(row.index)));
      if (hit !== undefined)
        saved.set(row.index, {
          key: hit.key,
          state:
            hit.state === labels.open
              ? "unexplained"
              : hit.state === labels.ignored
                ? "ignored"
                : "explained",
        });
    }
  }
  return {
    statement: input.statement,
    total: picked.length,
    rows: page.map((row) => {
      const match = review.matches.get(row.index);
      const kept = saved.get(row.index);
      return {
        row: row.index,
        date: row.date,
        description: row.description,
        ...(row.reference === null ? {} : { reference: row.reference }),
        amount: formatMoney({ minor: row.amountMinor, currency }),
        direction: row.direction,
        ...(row.balanceMinor === null || row.balanceMinor < 0
          ? {}
          : { balance: formatMoney({ minor: row.balanceMinor, currency }) }),
        group: groupOf(row.index),
        ...(match === undefined || match.candidates.length === 0
          ? {}
          : {
              candidates: match.candidates.map((one) => ({
                key: one.key,
                title: one.title,
                why: one.why.join(", "),
              })),
            }),
        ...(match === undefined || match.group !== "unmatched"
          ? {}
          : { suggestion: match.suggestion.action }),
        ...(kept === undefined ? {} : { saved: kept }),
      };
    }),
    sensitive: true as const,
  };
});
export const rows = leadTool("KinStatementTools.rows", runRows);
