import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { parseAmount } from "../money.ts";
import type { Review } from "./statementCard.ts";
import type { FileOutcome, StatementPage } from "./statementFiles.ts";
import { type Problem, proveStatement } from "./statementProof.ts";
import {
  attachmentBytes,
  buildReview,
  readWith,
  saveRead,
  type StatementRow as StoredStatement,
  tryKeptPasswords,
} from "./statementReview.ts";
import type { Statement, StatementFacts, StatementRow } from "./statementTable.ts";

/**
 * The model reads, the server proves. A PDF whose table Kin reads and proves goes straight to its
 * review card; any other PDF's pages wait for the statement's lead, which gives their rows back a
 * batch of pages at a time. Kin checks the rows with arithmetic and sends the lead back to the
 * pages that break it, a bounded number of times, before the owner sees the card either way.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** Times Kin's check sends the lead back before the card goes to the owner as it stands. */
const PROOF_ROUNDS = 3;
// About 10k tokens of page text per answer: a few dense pages, so a year's statement is batches.
const BATCH_CHARACTERS = 40_000;
const MAX_ROWS = 20_000;

type StoredPages = {
  readonly pages: ReadonlyArray<{ readonly text: string; readonly dated: number | null }>;
  readonly facts: StatementFacts | null;
};
type DraftRow = Omit<StatementRow, "index" | "foreign">;
type Draft = {
  readonly pages: ReadonlyArray<readonly [number, ReadonlyArray<DraftRow>]>;
  readonly opening: number | null;
  readonly closing: number | null;
};
const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const decodeJson = Schema.decodeUnknownOption(Json);
const pagesOf = (stored: Pick<StoredStatement, "pagesJson">) =>
  stored.pagesJson === null
    ? undefined
    : Option.getOrUndefined(decodeJson(stored.pagesJson) as Option.Option<StoredPages>);
const draftOf = (stored: Pick<StoredStatement, "draftJson">): Draft =>
  (stored.draftJson === null
    ? undefined
    : Option.getOrUndefined(decodeJson(stored.draftJson) as Option.Option<Draft>)) ?? {
    pages: [],
    opening: null,
    closing: null,
  };

/** Whether a statement waits on its lead to read its rows. */
export const isReading = (stored: Pick<StoredStatement, "status" | "pagesJson">) =>
  stored.status === "scanned" && stored.pagesJson !== null;

/** The stored file, read with this password or one kept for its account. */
export const readStored = Effect.fn("KinStatements.readStored")(function* (
  orgId: KinOrgId,
  attachmentId: string,
  password?: Redacted.Redacted<string>,
) {
  const bytes = yield* attachmentBytes(attachmentId);
  const outcome = yield* readWith(bytes, password);
  if (outcome._tag === "needs_password" && password === undefined)
    return (yield* tryKeptPasswords(orgId, bytes)) ?? outcome;
  return outcome;
});

/** Kin's own table read of a PDF, only when it proves out and counts every dated line. */
const provenTable = (statement: Statement, pages: ReadonlyArray<StatementPage>) => {
  const proof = proveStatement({
    kind: statement.kind,
    currency: statement.currency,
    opening: statement.openingMinor,
    closing: statement.closingMinor,
    from: statement.from,
    to: statement.to,
    pages: [{ page: 1, rows: statement.rows, dated: null }],
  });
  const dated = pages.reduce((sum, page) => sum + page.dated, 0);
  return proof.check.status === "adds_up" && statement.rows.length === dated
    ? { ...statement, check: proof.check }
    : undefined;
};

export type Settled =
  | { readonly _tag: "card"; readonly review: Review }
  | { readonly _tag: "reading"; readonly pages: number; readonly scanned: boolean };

/** What an opened file becomes: a proven read's review card, or pages for the lead to read. */
export const settleOutcome = Effect.fn("KinStatements.settle")(function* (input: {
  readonly orgId: KinOrgId;
  readonly statementId: string;
  readonly agentId: string;
  readonly chatId: string;
  readonly now: number;
  readonly account?: string | undefined;
  readonly outcome: Extract<FileOutcome, { readonly _tag: "read" | "pages" | "scanned" }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { outcome } = input;
  if (outcome._tag === "read") {
    const statement =
      outcome.statement.account === null && input.account !== undefined
        ? { ...outcome.statement, account: input.account }
        : outcome.statement;
    const ready = outcome.pages === undefined ? statement : provenTable(statement, outcome.pages);
    if (ready !== undefined) {
      const review = yield* buildReview(input.orgId, ready, outcome.format, "file");
      yield* sql.withTransaction(saveRead({ ...input, review }));
      return { _tag: "card", review } satisfies Settled;
    }
  }
  const stored: StoredPages =
    outcome._tag === "scanned"
      ? {
          pages: Array.from({ length: outcome.pages }, () => ({ text: "", dated: null })),
          facts: null,
        }
      : outcome._tag === "pages"
        ? { pages: outcome.pages, facts: outcome.facts }
        : {
            pages: outcome.pages ?? [],
            facts: {
              kind: outcome.statement.kind,
              bank: outcome.statement.bank,
              account: outcome.statement.account ?? input.account ?? null,
              from: outcome.statement.from,
              to: outcome.statement.to,
              openingMinor: outcome.statement.openingMinor,
              closingMinor: outcome.statement.closingMinor,
            },
          };
  yield* sql`UPDATE kin_bank_statements SET status = 'scanned', reason = NULL,
      pages_json = ${yield* encodeJson(stored)}, draft_json = NULL, proof_rounds = 0
    WHERE org_id = ${input.orgId} AND statement_id = ${input.statementId}`;
  return {
    _tag: "reading",
    pages: stored.pages.length,
    scanned: outcome._tag === "scanned",
  } satisfies Settled;
});

/** The next pages the lead hasn't given rows for, as many as fit one answer. */
const nextBatch = (stored: StoredPages, draft: Draft, only?: ReadonlyArray<number>) => {
  const done = new Set(draft.pages.map(([page]) => page));
  const wanted =
    only ?? stored.pages.flatMap((_, index) => (done.has(index + 1) ? [] : [index + 1]));
  const batch: Array<number> = [];
  let size = 0;
  for (const page of wanted) {
    const length = stored.pages[page - 1]?.text.length ?? 0;
    if (batch.length > 0 && size + length > BATCH_CHARACTERS) break;
    batch.push(page);
    size += length;
  }
  return batch;
};

export type PageText = {
  readonly page: number;
  readonly text: string;
  readonly datedLines: number | null;
};
export type Reading = {
  readonly total: number;
  readonly read: number;
  readonly scanned: boolean;
  readonly pages: ReadonlyArray<PageText>;
  /** The table's column header, from a page this batch doesn't hold: banks print it once. */
  readonly header?: { readonly page: number; readonly line: string };
};
/** The first line naming a date, the narration and an amount: the columns the rows sit under. */
const headerOf = (stored: StoredPages) => {
  for (const [at, page] of stored.pages.entries())
    for (const line of page.text.split("\n"))
      if (
        /\bdate\b/i.test(line) &&
        /narration|description|particular|detail/i.test(line) &&
        /withdrawal|debit|deposit|credit|amount/i.test(line)
      )
        return { page: at + 1, line };
  return undefined;
};
const reading = (stored: StoredPages, draft: Draft, only?: ReadonlyArray<number>): Reading => {
  const pages = nextBatch(stored, draft, only);
  const header = headerOf(stored);
  return {
    total: stored.pages.length,
    read: draft.pages.length,
    scanned: stored.facts === null && stored.pages.every((page) => page.text === ""),
    pages: pages.map((page) => ({
      page,
      text: stored.pages[page - 1]!.text,
      datedLines: stored.pages[page - 1]!.dated,
    })),
    ...(header === undefined || pages.includes(header.page) ? {} : { header }),
  };
};

/** Where a statement the lead is reading stands: the next pages to read. */
export const readingOf = (stored: Pick<StoredStatement, "pagesJson" | "draftJson">) => {
  const pages = pagesOf(stored);
  return pages === undefined ? undefined : reading(pages, draftOf(stored));
};

export type RowInput = {
  readonly date: string;
  readonly description: string;
  readonly amount: string;
  readonly direction: "debit" | "credit";
  readonly reference?: string | undefined;
  readonly balance?: string | undefined;
};
const minorOf = (text: string) => {
  const parsed = parseAmount(text.replace(/\b(cr|dr)\b\.?|^\s*-|[()]/gi, ""), "INR");
  return "error" in parsed ? parsed.error : parsed.money.minor;
};
const negativeBalance = (text: string) => /^\s*[-(]/.test(text);

export type Submitted =
  | { readonly _tag: "more"; readonly reading: Reading }
  | {
      readonly _tag: "check";
      readonly problems: ReadonlyArray<Problem>;
      readonly reading: Reading;
      readonly roundsLeft: number;
    }
  | { readonly _tag: "card"; readonly review: Review; readonly problems: ReadonlyArray<Problem> };

/**
 * Rows the lead read, a page at a time; a page given again replaces it. Once every page has its
 * rows, Kin proves them: a failure goes back to the lead with where, until the rounds run out.
 */
export const submitPages = Effect.fn("KinStatements.submitPages")(function* (input: {
  readonly orgId: KinOrgId;
  readonly stored: StoredStatement;
  readonly now: number;
  readonly pages: ReadonlyArray<{ readonly page: number; readonly rows: ReadonlyArray<RowInput> }>;
  readonly opening?: string | undefined;
  readonly closing?: string | undefined;
  readonly account?: string | undefined;
  readonly bank?: string | undefined;
  readonly kind?: "account" | "card" | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const stored = pagesOf(input.stored);
  if (stored === undefined || input.stored.status !== "scanned")
    return yield* invalid(
      "Pass pages only while Kin says this statement waits for you to read it; call statement_read without them first.",
    );
  const draft = draftOf(input.stored);
  const pages = new Map(draft.pages);
  for (const one of input.pages) {
    if (one.page > stored.pages.length)
      return yield* invalid(
        `There is no page ${one.page}: the statement has ${stored.pages.length}. Nothing was kept from this call.`,
      );
    const rows: Array<DraftRow> = [];
    for (const [at, row] of one.rows.entries()) {
      const amount = minorOf(row.amount);
      const where = `Page ${one.page}, row ${at + 1}`;
      if (typeof amount !== "number")
        return yield* invalid(`${where}: ${amount.message} Nothing was kept from this call.`);
      const balance = row.balance === undefined ? null : minorOf(row.balance);
      if (balance !== null && typeof balance !== "number")
        return yield* invalid(`${where}: ${balance.message} Nothing was kept from this call.`);
      rows.push({
        date: row.date,
        description: row.description,
        reference: row.reference === undefined || row.reference === "" ? null : row.reference,
        amountMinor: amount,
        direction: row.direction,
        balanceMinor:
          balance === null ? null : negativeBalance(row.balance ?? "") ? -balance : balance,
      });
    }
    pages.set(one.page, rows);
  }
  const money = (text: string | undefined, kept: number | null) => {
    if (text === undefined) return kept;
    const minor = minorOf(text);
    return typeof minor === "number" ? (negativeBalance(text) ? -minor : minor) : kept;
  };
  const next: Draft = {
    pages: [...pages].toSorted(([left], [right]) => left - right),
    opening: money(input.opening, draft.opening),
    closing: money(input.closing, draft.closing),
  };
  const total = next.pages.reduce((sum, [, rows]) => sum + rows.length, 0);
  if (total > MAX_ROWS) return yield* invalid(`A statement holds at most ${MAX_ROWS} rows here.`);
  yield* sql`UPDATE kin_bank_statements SET draft_json = ${yield* encodeJson(next)}
    WHERE org_id = ${input.orgId} AND statement_id = ${input.stored.statementId}`;
  if (next.pages.length < stored.pages.length)
    return { _tag: "more", reading: reading(stored, next) } satisfies Submitted;

  const facts = stored.facts;
  const kind = input.kind ?? facts?.kind ?? "account";
  const opening = facts?.openingMinor ?? next.opening;
  const closing = facts?.closingMinor ?? next.closing;
  let index = 0;
  const proofPages = next.pages.map(([page, rows]) => ({
    page,
    rows: rows.map((row) => ({ ...row, index: index++, foreign: null })),
    dated: stored.pages[page - 1]?.dated ?? null,
  }));
  const rows = proofPages.flatMap((page) => page.rows);
  const proof = proveStatement({
    kind,
    currency: "INR",
    opening,
    closing,
    from: facts?.from ?? null,
    to: facts?.to ?? null,
    pages: proofPages,
  });
  // What the page's text says outranks what was read from it.
  const disagree = [
    ...(facts?.openingMinor != null && next.opening !== null && next.opening !== facts.openingMinor
      ? ["opening"]
      : []),
    ...(facts?.closingMinor != null && next.closing !== null && next.closing !== facts.closingMinor
      ? ["closing"]
      : []),
  ].map((which): Problem => ({
    page: null,
    row: null,
    line: `The ${which} balance you sent isn't the one Kin reads in the statement's text; Kin used the statement's.`,
  }));
  const problems = [...proof.problems, ...disagree];
  const rounds = input.stored.proofRounds + 1;
  if (proof.problems.length > 0 && rounds < PROOF_ROUNDS) {
    yield* sql`UPDATE kin_bank_statements SET proof_rounds = ${rounds}
      WHERE org_id = ${input.orgId} AND statement_id = ${input.stored.statementId}`;
    const flagged = [
      ...new Set(problems.flatMap((one) => (one.page === null ? [] : [one.page]))),
    ].toSorted((left, right) => left - right);
    return {
      _tag: "check",
      problems,
      reading: reading(
        stored,
        next,
        flagged.length === 0 ? stored.pages.map((_, at) => at + 1) : flagged,
      ),
      roundsLeft: PROOF_ROUNDS - rounds,
    } satisfies Submitted;
  }
  const days = rows.map((row) => row.date).toSorted();
  const statement: Statement = {
    kind,
    bank: input.bank ?? facts?.bank ?? null,
    account: facts?.account ?? input.account ?? null,
    currency: "INR",
    from: facts?.from ?? days[0] ?? null,
    to: facts?.to ?? days.at(-1) ?? null,
    openingMinor: opening,
    closingMinor: closing,
    rows,
    check: proof.check,
  };
  const scanned = facts === null && stored.pages.every((page) => page.text === "");
  const review = yield* buildReview(input.orgId, statement, scanned ? "scan" : "pdf", "agent");
  yield* sql.withTransaction(
    saveRead({
      orgId: input.orgId,
      statementId: input.stored.statementId,
      agentId: input.stored.agentId,
      chatId: input.stored.chatId,
      review,
      now: input.now,
    }),
  );
  return { _tag: "card", review, problems } satisfies Submitted;
});
