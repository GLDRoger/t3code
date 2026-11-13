import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { parseAmount } from "../money.ts";
import type { Review } from "./statementCard.ts";
import type { FileOutcome, StatementPage } from "./statementFiles.ts";
import {
  bindRows,
  datedLinesOf,
  isHeaderLine,
  type NotRow,
  type Problem,
  pagesFor,
  printed,
  proveStatement,
  type ReadRow,
} from "./statementProof.ts";
import {
  attachmentBytes,
  buildReview,
  readWith,
  reviewOf,
  saveRead,
  type StatementRow as StoredStatement,
  tryKeptPasswords,
} from "./statementReview.ts";
import type { Statement, StatementFacts } from "./statementTable.ts";

/**
 * The model reads, the server proves. A PDF whose table Kin reads and ties to its text goes
 * straight to its review card; any other PDF's pages wait for the statement's lead, which gives
 * their rows back a batch of pages at a time. Kin ties each row to its page's text, checks the
 * arithmetic, and sends the lead back to the pages that break it a bounded number of times.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** Times Kin's check sends the lead back before the card goes to the owner as it stands. */
const PROOF_ROUNDS = 3;
// About 10k tokens of page text per answer: a few dense pages, so a year's statement is batches.
const BATCH_CHARACTERS = 40_000;
const MAX_ROWS = 20_000;
const SCAN =
  "These rows were read from images of a scan: the file has no text to check them against, so check the amounts.";

type StoredPages = {
  readonly pages: ReadonlyArray<{ readonly text: string; readonly dated: number | null }>;
  readonly facts: StatementFacts | null;
};
/** A page's rows as the lead gave them, with the dated lines it says aren't transactions. */
type DraftPage = readonly [
  page: number,
  rows: ReadonlyArray<ReadRow>,
  others?: ReadonlyArray<NotRow>,
  part?: number,
];
type Draft = {
  readonly pages: ReadonlyArray<DraftPage>;
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

/** The account digits and period Kin read for a statement, from its review or its pages. */
export const factsOf = (
  stored: Pick<StoredStatement, "account" | "reviewJson" | "pagesJson">,
): {
  readonly account: string | null;
  readonly from: string | null;
  readonly to: string | null;
} => {
  const read = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson)?.statement;
  const facts = read ?? pagesOf(stored)?.facts ?? undefined;
  return {
    account: facts?.account ?? stored.account,
    from: facts?.from ?? null,
    to: facts?.to ?? null,
  };
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

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");
const currencyOf = (texts: ReadonlyArray<string>) =>
  /\bcurrency\s*:?\s*([A-Z]{3})\b/.exec(texts.join("\n"))?.[1] ?? "INR";
const NO_BALANCES =
  "Each row is printed on its page, but the statement prints no running balance beside its rows, so Kin couldn't prove each one.";

/**
 * Kin's own table read of a PDF, tied to the pages' text as a lead's rows are: proven when every
 * row and its balance are printed there, unchecked when no balances are, undefined when it fails.
 */
export const provenTable = (statement: Statement, pages: ReadonlyArray<StatementPage>) => {
  const texts = pages.map((page) => page.text);
  const bound = bindRows({
    kind: statement.kind,
    currency: statement.currency,
    opening: statement.openingMinor,
    texts,
    pages: pagesFor(texts, statement.rows),
  });
  const balanced = bound.pages.every((page) => page.rows.every((row) => row.balanceMinor !== null));
  const proof = proveStatement({
    kind: statement.kind,
    currency: statement.currency,
    opening: statement.openingMinor,
    closing: statement.closingMinor,
    from: statement.from,
    to: statement.to,
    pages: bound.pages,
    bound: {
      problems: bound.problems,
      unproven: balanced ? bound.unproven : [NO_BALANCES, ...bound.unproven],
    },
  });
  return proof.check.status === "off"
    ? undefined
    : { ...statement, rows: bound.pages.flatMap((page) => page.rows), check: proof.check };
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
      const review = yield* buildReview(
        input.orgId,
        ready,
        outcome.format,
        "file",
        input.statementId,
      );
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

/** A page's text in parts that fit one answer, split between lines. */
const partsOf = (text: string) => {
  if (text.length <= BATCH_CHARACTERS) return [text];
  const parts: Array<string> = [];
  let part: Array<string> = [];
  let size = 0;
  for (const line of text.split("\n")) {
    if (part.length > 0 && size + line.length + 1 > BATCH_CHARACTERS) {
      parts.push(part.join("\n"));
      part = [];
      size = 0;
    }
    part.push(line);
    size += line.length + 1;
  }
  parts.push(part.join("\n"));
  return parts;
};

export type PageText = {
  readonly page: number;
  /** From 1, when a long page comes in parts. */
  readonly part: number;
  readonly parts: number;
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

const partKey = (page: number, part: number) => `${page}:${part}`;
const donePages = (stored: StoredPages, draft: Draft) => {
  const done = new Set(draft.pages.map(([page, , , part]) => partKey(page, part ?? 1)));
  return stored.pages.flatMap((one, at) =>
    partsOf(one.text).every((_, part) => done.has(partKey(at + 1, part + 1))) ? [at + 1] : [],
  );
};

/** The next pages, or parts of pages, the lead hasn't given rows for: as many as fit one answer. */
export const readingFor = (
  stored: StoredPages,
  draft: Draft,
  only?: ReadonlyArray<number>,
): Reading => {
  const done = new Set(draft.pages.map(([page, , , part]) => partKey(page, part ?? 1)));
  const units = stored.pages.flatMap((one, at) => {
    const parts = partsOf(one.text);
    return parts.map((text, part) => ({
      page: at + 1,
      part: part + 1,
      parts: parts.length,
      text,
      datedLines: datedLinesOf(text),
    }));
  });
  const wanted = units.filter((unit) =>
    only === undefined ? !done.has(partKey(unit.page, unit.part)) : only.includes(unit.page),
  );
  const batch: Array<PageText> = [];
  let size = 0;
  for (const unit of wanted) {
    if (batch.length > 0 && size + unit.text.length > BATCH_CHARACTERS) break;
    batch.push(unit);
    size += unit.text.length;
  }
  const header = headerOf(stored);
  return {
    total: stored.pages.length,
    read: donePages(stored, draft).length,
    scanned: stored.facts === null && stored.pages.every((page) => page.text === ""),
    pages: batch,
    ...(header === undefined || batch.some((one) => one.text.split("\n").includes(header.line))
      ? {}
      : { header }),
  };
};
const headerOf = (stored: StoredPages) => {
  for (const [at, page] of stored.pages.entries())
    for (const line of page.text.split("\n")) if (isHeaderLine(line)) return { page: at + 1, line };
  return undefined;
};

/** Where a statement the lead is reading stands: the next pages to read. */
export const readingOf = (stored: Pick<StoredStatement, "pagesJson" | "draftJson">) => {
  const pages = pagesOf(stored);
  return pages === undefined ? undefined : readingFor(pages, draftOf(stored));
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
 * Rows the lead read, a page or part at a time; one given again replaces it. Once every page has
 * its rows, Kin ties them to the text and proves them: a failure goes back to the lead with where,
 * until the rounds run out.
 */
export const submitPages = Effect.fn("KinStatements.submitPages")(function* (input: {
  readonly orgId: KinOrgId;
  readonly stored: StoredStatement;
  readonly now: number;
  readonly pages: ReadonlyArray<{
    readonly page: number;
    readonly part?: number | undefined;
    readonly rows: ReadonlyArray<RowInput>;
    readonly notTransactions?: ReadonlyArray<NotRow> | undefined;
  }>;
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
  const given = new Map(draft.pages.map((one) => [partKey(one[0], one[3] ?? 1), one]));
  for (const one of input.pages) {
    if (one.page > stored.pages.length)
      return yield* invalid(
        `There is no page ${one.page}: the statement has ${stored.pages.length}. Nothing was kept from this call.`,
      );
    const parts = partsOf(stored.pages[one.page - 1]!.text).length;
    if ((parts > 1 && one.part === undefined) || (one.part ?? 1) > parts)
      return yield* invalid(
        `Page ${one.page} comes in ${parts} part${parts === 1 ? "" : "s"}: send each part's rows with its part number. Nothing was kept from this call.`,
      );
    const rows: Array<ReadRow> = [];
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
    const part = parts > 1 ? one.part : undefined;
    const entry: DraftPage =
      part === undefined
        ? [one.page, rows, one.notTransactions ?? []]
        : [one.page, rows, one.notTransactions ?? [], part];
    given.set(partKey(one.page, part ?? 1), entry);
  }
  const money = (text: string | undefined, kept: number | null) => {
    if (text === undefined) return kept;
    const minor = minorOf(text);
    return typeof minor === "number" ? (negativeBalance(text) ? -minor : minor) : kept;
  };
  const next: Draft = {
    pages: [...given.values()].toSorted(
      (left, right) => left[0] - right[0] || (left[3] ?? 1) - (right[3] ?? 1),
    ),
    opening: money(input.opening, draft.opening),
    closing: money(input.closing, draft.closing),
  };
  const total = next.pages.reduce((sum, [, rows]) => sum + rows.length, 0);
  if (total > MAX_ROWS) return yield* invalid(`A statement holds at most ${MAX_ROWS} rows here.`);
  yield* sql`UPDATE kin_bank_statements SET draft_json = ${yield* encodeJson(next)}
    WHERE org_id = ${input.orgId} AND statement_id = ${input.stored.statementId}`;
  if (donePages(stored, next).length < stored.pages.length)
    return { _tag: "more", reading: readingFor(stored, next) } satisfies Submitted;

  const facts = stored.facts;
  const texts = stored.pages.map((page) => page.text);
  const scanned = texts.every((text) => text === "");
  const all = texts.join("\n");
  // What the page's text says outranks what was read from it; what only the lead says must be in it.
  const textKind =
    facts?.kind === "card"
      ? ("card" as const)
      : /statement of account|\b(?:account|a\/c)\s*(?:no|number)\b|savings account|current account/i.test(
            all,
          )
        ? ("account" as const)
        : undefined;
  const kind = textKind ?? input.kind ?? "account";
  const currency = currencyOf(texts);
  const opening = facts?.openingMinor ?? next.opening;
  const closing = facts?.closingMinor ?? next.closing;
  const unproven: Array<string> = [];
  const fixed: Array<Problem> = [];
  if (!scanned) {
    if (textKind === undefined)
      unproven.push("Kin couldn't tell from the text whether this is a bank account or a card.");
    else if (input.kind !== undefined && input.kind !== textKind)
      fixed.push({
        page: null,
        row: null,
        line: `The statement's text reads as a ${textKind === "card" ? "card" : "bank account"} statement, not a ${input.kind === "card" ? "card" : "bank account"}'s: read it as one.`,
      });
    for (const [which, value, own] of [
      ["opening", next.opening, facts?.openingMinor ?? null],
      ["closing", next.closing, facts?.closingMinor ?? null],
    ] as const)
      if (own === null && value !== null && !printed(texts, value))
        unproven.push(`The ${which} balance you gave isn't printed in the statement's text.`);
  }
  let index = 0;
  const pages = stored.pages.map((_, at) => {
    const parts = next.pages.filter(([page]) => page === at + 1);
    return {
      page: at + 1,
      rows: parts.flatMap(([, rows]) => rows),
      notRows: parts.flatMap(([, , others]) => others ?? []),
    };
  });
  const bound = scanned
    ? {
        pages: pages.map((page) => ({
          page: page.page,
          rows: page.rows.map((row) => ({ ...row, index: index++, foreign: null })),
        })),
        problems: [],
        unproven: [SCAN],
      }
    : bindRows({ kind, currency, opening, texts, pages });
  const proof = proveStatement({
    kind,
    currency,
    opening,
    closing,
    from: facts?.from ?? null,
    to: facts?.to ?? null,
    pages: bound.pages,
    bound: { problems: [...fixed, ...bound.problems], unproven: [...unproven, ...bound.unproven] },
  });
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
      reading: readingFor(
        stored,
        next,
        flagged.length === 0 ? stored.pages.map((_, at) => at + 1) : flagged,
      ),
      roundsLeft: PROOF_ROUNDS - rounds,
    } satisfies Submitted;
  }
  const rows = bound.pages.flatMap((page) => page.rows);
  const days = rows.map((row) => row.date).toSorted();
  const bank =
    facts?.bank ??
    (input.bank !== undefined && squash(all).includes(squash(input.bank)) ? input.bank : null);
  const statement: Statement = {
    kind,
    bank,
    account: facts?.account ?? input.account ?? null,
    currency,
    from: facts?.from ?? days[0] ?? null,
    to: facts?.to ?? days.at(-1) ?? null,
    openingMinor: opening,
    closingMinor: closing,
    rows,
    check: proof.check,
  };
  const review = yield* buildReview(
    input.orgId,
    statement,
    scanned ? "scan" : "pdf",
    "agent",
    input.stored.statementId,
  );
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
