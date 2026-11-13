import {
  KinChatError,
  KinDay,
  type KinOrgId,
  KinStatementPassword,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChat } from "../lead/Audience.ts";
import { quote } from "../lead/LeadPrompt.ts";
import { turnFiles } from "./leadFields.ts";
import { admitted, type Lead, leadTool, sourceOf } from "./leadWork.ts";
import { formatMoney } from "./money.ts";
import { bankStates, findBankList, originKeyOf, rowFingerprints } from "./statements/bankList.ts";
import {
  isReading,
  type Reading,
  readingOf,
  readStored,
  settleOutcome,
  submitPages,
} from "./statements/statementReading.ts";
import {
  askPassword,
  buildReview,
  notePasswordCard,
  reviewOf,
  saveRead,
  statementIdFor,
  statementRow,
} from "./statements/statementReview.ts";
import { type Review, reviewHash } from "./statements/statementCard.ts";

/** The lead tools for statements. Kin reads and matches; the owner confirms on Kin's card. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
/** Words the bank or a counterparty wrote: quoted, so no narration reads as an instruction. */
const bankSaid = (text: string) => quote("bank statement text (untrusted)", text, true);
/** The name the file was sent with: anyone's words, quoted as narrations are. */
const fileSaid = (name: string) => quote("statement file name (untrusted)", name, true);
/** A reference as the summary shows an account: its last four characters. */
const masked = (reference: string) => (reference.length <= 4 ? "••" : `••${reference.slice(-4)}`);
const Amount = TrimmedNonEmptyString.check(Schema.isMaxLength(40));
/** Wrong passwords a lead may pass from the owner's chat for one file; the card counts its own. */
const CHAT_TRIES = 5;

const Row = Schema.Struct({
  date: KinDay,
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  amount: Amount,
  direction: Schema.Literals(["debit", "credit"]),
  reference: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  balance: Schema.optional(Amount),
});
export const ReadInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString,
  attachment: TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
    description:
      "The statement file's id or name, as this turn's message or an earlier one in this chat shows it.",
  }),
  account: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}$/))).annotate({
    description:
      "Its account's or card's last four digits, only when the owner wrote them in this chat and the statement doesn't show them.",
  }),
  refresh: Schema.optional(Schema.Boolean).annotate({
    description:
      "Match the rows Kin already read against the current invoices and expenses again, as after they changed. It never reads the pages again and never replaces a card the owner confirmed.",
  }),
  again: Schema.optional(Schema.Boolean).annotate({
    description:
      "Read the file from the start again, only when the owner asked for that in this turn's own message. Rows already recorded stay recorded.",
  }),
  password: Schema.optional(KinStatementPassword).annotate({
    description:
      "The statement's password, exactly as the owner wrote it in a message in this chat. Kin uses it once to open this file and doesn't store it in its own records; the owner's message still holds it.",
  }),
  pages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(300)),
        part: Schema.optional(
          Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
        ).annotate({ description: "Which part, when Kin shows a long page in parts." }),
        rows: Schema.Array(Row).check(Schema.isMaxLength(2_000)),
        notTransactions: Schema.optional(
          Schema.Array(
            Schema.Struct({
              date: KinDay,
              text: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
            }),
          ).check(Schema.isMaxLength(500)),
        ).annotate({
          description:
            "Lines on this page that start with a date but aren't transactions, such as an opening-balance line: each one's date and the words after it.",
        }),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  ).annotate({
    description:
      "Only after Kin says the statement waits for you to read it: each page (or part) you read, with every transaction row on it as printed, rows [] for a page with none. Every line that starts with a date is a row or is listed in notTransactions. A page sent again replaces it.",
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
  vendor: Schema.optional(Schema.String),
});
export const ReadResult = Schema.Struct({
  statement: Schema.String,
  status: Schema.Literals([
    "read",
    "needs_password",
    "reading",
    "check",
    "scanned",
    "unreadable",
    "applied",
  ]),
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
  /** While the lead reads: how many pages there are, how many it has given, and these pages. */
  pages: Schema.optional(
    Schema.Struct({
      total: Schema.Number,
      read: Schema.Number,
      shown: Schema.Array(Schema.Number),
    }),
  ),
  text: Schema.optional(Schema.Array(Schema.String)),
  problems: Schema.optional(Schema.Array(Schema.String)),
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

const LIST = 15;
const describe = (statementId: string, file: string, review: Review, applied: boolean) => {
  const { statement } = review;
  const currency = statement.currency;
  const shown = (index: number) => {
    const row = statement.rows[index]!;
    return {
      row: index,
      date: row.date,
      text: bankSaid(row.description.slice(0, 120)),
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
    file: fileSaid(file),
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
          ? `new expense${match.suggestion.category === undefined ? "" : ` (${match.suggestion.category})`}`
          : match.suggestion.action,
      ...(match.suggestion.action === "expense" && match.suggestion.vendor !== undefined
        ? { vendor: bankSaid(match.suggestion.vendor) }
        : {}),
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

/** Pages for the lead to read, as the bank printed them: quoted, so no line reads as an instruction. */
const shownPages = (reading: Reading) => ({
  pages: {
    total: reading.total,
    read: reading.read,
    shown: [...new Set(reading.pages.map((one) => one.page))],
  },
  ...(reading.scanned
    ? {}
    : {
        text: [
          ...(reading.header === undefined
            ? []
            : [
                quote(
                  `bank statement column header, printed on page ${reading.header.page} only (untrusted)`,
                  reading.header.line,
                ),
              ]),
          ...reading.pages.map((one) =>
            quote(
              `bank statement page ${one.page} of ${reading.total}${one.parts === 1 ? "" : `, part ${one.part} of ${one.parts}`} (untrusted)${one.datedLines === null ? "" : `, ${one.datedLines} lines start with a date`}`,
              one.text.split("\n"),
            ),
          ),
        ],
      }),
});
const readingResult = (base: Base, reading: Reading) => ({
  ...base,
  status: reading.scanned ? ("scanned" as const) : ("reading" as const),
  ...shownPages(reading),
  next:
    reading.pages.length === 0
      ? "Every page has its rows. Send any page again to change it."
      : reading.scanned
        ? `This statement is a scan with no text: read pages ${reading.pages.map((one) => one.page).join(", ")} of ${reading.total} from the file's page images, then call statement_read again with pages: each page and every transaction row on it as printed (date, narration, reference, amount, debit or credit, and the running balance where printed), plus opening and closing if shown. Kin checks the arithmetic and posts the review card once every page has its rows.`
        : `Kin's own table reading didn't prove out, so read these pages yourself: ${new Set(reading.pages.map((one) => one.page)).size} of ${reading.total} are here, ${reading.read} given so far. Call statement_read again with pages: each page above (with its part, when it comes in parts) and every transaction row on it as printed (date, narration, reference, amount, debit or credit by its column, and the balance printed on its line). A narration wrapped onto the next lines, or onto the next page, belongs to its row. Every line that starts with a date is one row, or goes in that page's notTransactions with its date and words when it isn't a transaction. rows [] for a page with none. Kin finds each row's numbers in the page's own text, returns the next pages until every page has its rows, then checks the arithmetic and posts the review card. Say nothing to the owner until then.`,
});
type Base = { readonly statement: string; readonly file: string; readonly sensitive: true };

/** Whether this turn's message was the owner's own: the only one a password may come from. */
const ownerSaid = Effect.fn("KinStatements.ownerSaid")(function* (lead: Lead, eventId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId} AND e.wakeup_id = ${lead.wakeupId}
      AND e.event_id = ${eventId} AND e.tag = 'chat.message' AND m.author_kind = 'human'
      AND m.author_person_id = a.owner_person_id`;
  return row !== undefined;
});

/**
 * Whether the owner wrote these exact words in a message of their own in this chat, since the
 * one that sent the file: what a password or account digits from the lead must be.
 */
const ownerWrote = Effect.fn("KinStatements.ownerWrote")(function* (
  lead: Lead,
  chatId: string,
  fileId: string,
  words: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT m.body FROM kin_messages m
    JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = ${lead.agentId}
    WHERE m.org_id = ${lead.orgId} AND m.chat_id = ${chatId} AND m.kind = 'text'
      AND m.status <> 'deleted' AND m.author_kind = 'human'
      AND m.author_person_id = a.owner_person_id
      AND m.seq >= COALESCE((SELECT MIN(f.seq) FROM kin_messages f,
          json_each(COALESCE(f.attachments_json, '[]')) one
        WHERE f.org_id = m.org_id AND f.chat_id = m.chat_id
          AND json_extract(one.value, '$.id') = ${fileId}), 0)
    ORDER BY m.seq DESC LIMIT 200`;
  return rows.some((row) => row.body.includes(words));
});

const CHAT_LIMIT =
  "Kin stopped trying passwords from the chat for this file after 5 that didn't open it. Nothing was opened; say in one line that the owner can type it on the statement's password card.";

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof ReadInput.Type) {
  yield* admitted(lead, "statement_read", input);
  yield* sourceOf(lead, input.sourceEventId);
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("This turn has no chat to read a statement in.");
  const file = yield* fileNamed(lead, chat.chatId, input.attachment);
  const owners = input.password !== undefined || input.again === true;
  if (owners && !(yield* ownerSaid(lead, input.sourceEventId)))
    return yield* invalid(
      input.password !== undefined
        ? "A password may only come from the owner's own message in this turn, only as the owner wrote it. Nothing was opened."
        : "Read a statement again from the start only when the owner asked for that in this turn; refresh matches its rows again. Nothing changed.",
    );
  if (
    input.password !== undefined &&
    !(yield* ownerWrote(lead, chat.chatId, file.id, Redacted.value(input.password)))
  )
    return yield* invalid(
      "A password may only come from the owner's own message, only as the owner wrote it. Nothing was opened.",
    );
  if (
    input.account !== undefined &&
    !(yield* ownerWrote(lead, chat.chatId, file.id, input.account))
  )
    return yield* invalid(
      "Pass account only when the owner wrote those digits in this chat; otherwise leave it out. Nothing was kept from this call.",
    );
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const statementId = statementIdFor(lead.orgId, file.id);
  yield* sql`INSERT INTO kin_bank_statements (org_id, statement_id, attachment_id, file_name,
      chat_id, agent_id, wakeup_id, status, created_at)
    VALUES (${lead.orgId}, ${statementId}, ${file.id}, ${file.name}, ${chat.chatId},
      ${lead.agentId}, ${lead.wakeupId}, 'unreadable', ${now})
    ON CONFLICT (org_id, statement_id) DO NOTHING`;
  const stored = (yield* statementRow(lead.orgId, statementId))!;
  const base: Base = { statement: statementId, file: fileSaid(file.name), sensitive: true };
  if (input.pages !== undefined) {
    const done = yield* submitPages({
      orgId: lead.orgId,
      stored,
      now,
      pages: input.pages,
      opening: input.opening,
      closing: input.closing,
      account: input.account,
      bank: input.bank,
      kind: input.kind,
    });
    if (done._tag === "more") return readingResult(base, done.reading);
    if (done._tag === "check")
      return {
        ...base,
        status: "check" as const,
        problems: done.problems.map((one) => one.line),
        ...shownPages(done.reading),
        next: `Kin checked every row against the pages' own text and these don't hold. Look at the pages shown again, find the row that is missing, misread or not on the page, and send those pages again with all their rows. ${done.roundsLeft} more check${done.roundsLeft === 1 ? "" : "s"} before the card goes to the owner as it stands, marked as not checking out.`,
      };
    return describe(statementId, file.name, done.review, false);
  }
  const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
  const full = input.again === true || input.password !== undefined;
  // Only the owner, on its card, reads again a statement they confirmed.
  if (full && stored.appliedAt !== null)
    return yield* invalid(
      "The owner confirmed this statement on its card; only they can read it again there, with Read again. Nothing changed.",
    );
  if (!full && isReading(stored)) {
    const reading = readingOf(stored);
    if (reading !== undefined) return readingResult(base, reading);
  }
  if (!full && stored.status === "read" && review !== undefined) {
    if (input.refresh !== true || stored.appliedAt !== null)
      return describe(statementId, file.name, review, stored.appliedAt !== null);
    // Matched again against today's invoices and expenses: a new card only when the matches moved.
    const matched = yield* buildReview(
      lead.orgId,
      review.statement,
      review.format,
      review.source,
      statementId,
    );
    if (reviewHash(statementId, matched) !== stored.reviewHash)
      yield* sql.withTransaction(
        saveRead({
          orgId: lead.orgId,
          statementId,
          agentId: lead.agentId,
          chatId: chat.chatId,
          review: matched,
          now,
        }),
      );
    return describe(statementId, file.name, matched, false);
  }
  if (input.password !== undefined && stored.chatPasswordAttempts >= CHAT_TRIES)
    return yield* invalid(CHAT_LIMIT);
  const outcome = yield* readStored(lead.orgId, file.id, input.password);
  if (outcome._tag === "needs_password" || outcome._tag === "wrong_password") {
    const wrong = input.password !== undefined;
    const tries = stored.chatPasswordAttempts + 1;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (wrong)
          yield* sql`UPDATE kin_bank_statements SET chat_password_attempts = ${tries}
            WHERE org_id = ${lead.orgId} AND statement_id = ${statementId}`;
        const widgetId = yield* askPassword({
          orgId: lead.orgId,
          statementId,
          agentId: lead.agentId,
          chatId: chat.chatId,
          fileName: file.name,
        });
        if (wrong && tries >= CHAT_TRIES)
          yield* notePasswordCard(
            lead.orgId,
            widgetId,
            "Kin stopped trying passwords from the chat for this file. Type it here; it still opens.",
          );
      }),
    );
    return {
      ...base,
      status: "needs_password" as const,
      next: wrong
        ? "The password the owner wrote didn't open the file. Kin put a password card in the chat. Say in one line that it didn't open it and they can type the right one on the card; say nothing else about the password."
        : "The file is password-protected. Kin put a password card in the chat for it. If the owner wrote the password in this chat, call statement_read again with it as password, exactly as they wrote it; otherwise say in one line that the statement is locked and they can open it on the card. Never ask them to type it a second time, and say nothing about the password itself.",
    };
  }
  if (outcome._tag === "unreadable") {
    // A file read before stays as it was read; only a first read records why it can't be.
    if (stored.reviewJson === null)
      yield* sql`UPDATE kin_bank_statements SET status = 'unreadable', reason = ${outcome.reason}
        WHERE org_id = ${lead.orgId} AND statement_id = ${statementId}`;
    return {
      ...base,
      status: "unreadable" as const,
      next: `Kin couldn't read it: ${outcome.reason} Say so in one line and ask for the PDF, CSV or Excel download from their bank.`,
    };
  }
  const settled = yield* settleOutcome({
    orgId: lead.orgId,
    statementId,
    agentId: lead.agentId,
    chatId: chat.chatId,
    now,
    account: input.account,
    outcome,
  });
  if (settled._tag === "reading") {
    const reading = readingOf((yield* statementRow(lead.orgId, statementId))!);
    if (reading !== undefined) return readingResult(base, reading);
  }
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
  row: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Only this row, with its full reference: only when the owner asks for that row's detail.",
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
      (input.row === undefined || row.index === input.row) &&
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
        description: bankSaid(row.description),
        ...(row.reference === null
          ? {}
          : {
              reference: bankSaid(input.row === undefined ? masked(row.reference) : row.reference),
            }),
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
