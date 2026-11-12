// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous review hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_STATEMENT_CARD_ROWS,
  type KinStatementReviewCard,
  type KinStatementSection,
  type KinStatementSelectChange,
  type KinStatementSelection,
  type KinStatementTarget,
} from "@t3tools/contracts";

import { formatMoney } from "../money.ts";
import type { KnownRow } from "./bankList.ts";
import type { Candidate, RowMatch } from "./statementMatch.ts";
import type { Statement } from "./statementTable.ts";

/**
 * A statement's review card and the owner's selection on it. The card carries the first rows
 * of each section and the counts; the selection lives on the server, so Confirm applies exactly
 * what the owner chose, rows the device never loaded included.
 */

export type Review = {
  readonly statement: Statement;
  readonly format: string | null;
  readonly source: "file" | "agent";
  readonly known: ReadonlyMap<number, KnownRow>;
  /** Every row not already explained in Bank transactions. */
  readonly matches: ReadonlyMap<number, RowMatch>;
};

const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
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

export const STATEMENT_REVIEW_TEXT =
  "Kin read a bank statement and matched its rows. Review and confirm them on its card.";

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

/**
 * Rows this statement already recorded and an undo kept, such as a payment with a receipt: shown
 * with what holds them, never applied again. By row, from `heldRows`.
 */
export type Held = ReadonlyMap<number, string>;
const NONE: Held = new Map();

/** The rows of one section, in statement order. */
const sectionRows = (review: Review, section: KinStatementSection) =>
  [...review.matches.entries()]
    .filter(([, match]) => match.group === section)
    .toSorted(([left], [right]) => left - right);

/** One page of a section as the card shows it. */
export const rowsOf = (
  review: Review,
  section: KinStatementSection,
  offset: number,
  limit: number,
  held: Held = NONE,
) => {
  const { statement } = review;
  const currency = statement.currency;
  const all = sectionRows(review, section);
  const shown = (index: number) => {
    const row = statement.rows[index]!;
    const recorded = held.get(index);
    return {
      row: index,
      date: row.date,
      text: clamp(row.description, 120),
      amount: money(row.amountMinor, currency),
      direction: row.direction,
      ...(recorded === undefined ? {} : { recorded: clamp(recorded, 200) }),
    };
  };
  const page = all.slice(offset, offset + limit);
  return {
    total: all.length,
    matched:
      section === "matched"
        ? page.map(([index, match]) => ({
            ...shown(index),
            target: target(match.candidates[0]!, 0, currency),
          }))
        : [],
    choose:
      section === "choose"
        ? page.map(([index, match]) => ({
            ...shown(index),
            options: match.candidates.map((one, option) => target(one, option, currency)),
          }))
        : [],
    unmatched:
      section === "unmatched"
        ? page.map(([index, match]) => ({
            ...shown(index),
            suggestion: match.suggestion.action,
            ...(match.suggestion.why === undefined
              ? {}
              : { why: clamp(match.suggestion.why, 200) }),
            ...(match.suggestion.vendor === undefined
              ? {}
              : { vendor: clamp(match.suggestion.vendor, 120) }),
            ...(match.suggestion.category === undefined
              ? {}
              : { category: match.suggestion.category }),
          }))
        : [],
  };
};

/** Binds a confirm to this exact review: each row as read, its entries and how its money fits them. */
export const reviewHash = (statementId: string, review: Review) => {
  const fit = (one: Candidate) => [one.recordId, one.fit, one.tdsMinor ?? null];
  return hash(
    JSON.stringify({
      statementId,
      rows: [...review.matches.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([index, match]) => {
          const row = review.statement.rows[index];
          return [
            index,
            row?.date ?? null,
            row?.amountMinor ?? null,
            row?.direction ?? null,
            match.group,
            match.candidates.map(fit),
          ];
        }),
      recorded: review.statement.rows.length - review.matches.size,
    }),
  ).slice(0, 32);
};

/** Why no match starts ticked, when the rows themselves may be wrong. */
const heldBackWhy = (review: Review) =>
  review.source === "agent"
    ? "Nothing is ticked: Kin read these rows from images of a scan. Check each against the statement, then tick it."
    : review.statement.check.status === "off"
      ? "Nothing is ticked: the statement doesn't add up, so a row may be misread. Check each, then tick it."
      : review.statement.check.status === "unchecked"
        ? "Nothing is ticked: the statement gives no balances to check its rows against. Check each, then tick it."
        : undefined;

export const defaultSelection = (review: Review): KinStatementSelection => ({
  revision: 0,
  ticked: heldBackWhy(review) === undefined ? "all" : "none",
  except: [],
  picks: [],
  suggestions: false,
  actions: [],
});

export type Decision = {
  readonly row: number;
  readonly option?: number;
  readonly action?: {
    readonly action: "expense" | "transfer" | "ignore";
    readonly vendor?: string;
    readonly category?: string;
  };
};

/** What Confirm records for a selection, row by row in statement order; held rows never. */
export const decisionsOf = (
  review: Review,
  selection: KinStatementSelection,
  held: Held = NONE,
) => {
  const except = new Set(selection.except);
  const picks = new Map(selection.picks.map((one) => [one.row, one.option]));
  const actions = new Map(selection.actions.map((one) => [one.row, one.action]));
  const decisions: Array<Decision> = [];
  for (const [row, match] of [...review.matches.entries()].toSorted(
    ([left], [right]) => left - right,
  )) {
    if (held.has(row)) continue;
    if (match.group === "matched") {
      if ((selection.ticked === "all") !== except.has(row)) decisions.push({ row, option: 0 });
    } else if (match.group === "choose") {
      const option = picks.get(row);
      if (option !== undefined) decisions.push({ row, option });
    } else {
      const suggested = selection.suggestions ? match.suggestion.action : "later";
      const action = actions.get(row) ?? suggested;
      if (action !== "later")
        decisions.push({
          row,
          action: {
            action,
            ...(action === "expense" && match.suggestion.vendor !== undefined
              ? { vendor: match.suggestion.vendor }
              : {}),
            ...(action === "expense" && match.suggestion.category !== undefined
              ? { category: match.suggestion.category }
              : {}),
          },
        });
    }
  }
  return decisions;
};

const chosenCounts = (review: Review, selection: KinStatementSelection, held: Held) => {
  const counts = { matched: 0, choose: 0, unmatched: 0 };
  for (const decision of decisionsOf(review, selection, held))
    counts[review.matches.get(decision.row)!.group] += 1;
  return counts;
};

/** The selection after one change on the card, or why the change can't be made. */
export const changeSelection = (
  review: Review,
  selection: KinStatementSelection,
  change: KinStatementSelectChange,
  held: Held = NONE,
): KinStatementSelection | string => {
  const match = "row" in change ? review.matches.get(change.row) : undefined;
  if ("row" in change && held.has(change.row))
    return "That row is already recorded from this statement; undo it first to change it.";
  const next = { ...selection, revision: selection.revision + 1 };
  switch (change._tag) {
    case "tick": {
      if (match?.group !== "matched") return "That row isn't one of this card's matches.";
      const except = new Set(selection.except);
      if ((selection.ticked === "all") === change.ticked) except.delete(change.row);
      else except.add(change.row);
      return { ...next, except: [...except].toSorted((left, right) => left - right) };
    }
    case "tickAll":
      return { ...next, ticked: change.ticked ? "all" : "none", except: [] };
    case "pick": {
      if (match?.group !== "choose") return "That row has no matches to pick from.";
      const picks = selection.picks.filter((one) => one.row !== change.row);
      if (change.option === null) return { ...next, picks };
      const candidate = match.candidates[change.option];
      if (candidate === undefined) return "That match isn't one of this row's.";
      const other = selection.picks.find(
        (one) =>
          one.row !== change.row &&
          review.matches.get(one.row)?.candidates[one.option]?.recordId === candidate.recordId,
      );
      if (other !== undefined) {
        const row = review.statement.rows[other.row]!;
        return `${candidate.key} is already picked for the ${shortDay(row.date)} row of ${money(row.amountMinor, review.statement.currency)}. One entry answers one row.`;
      }
      return {
        ...next,
        picks: [...picks, { row: change.row, option: change.option }].toSorted(
          (left, right) => left.row - right.row,
        ),
      };
    }
    case "action": {
      if (match?.group !== "unmatched") return "That row isn't one Kin left unmatched.";
      if (change.action === "expense" && review.statement.rows[change.row]?.direction !== "debit")
        return "Only money out can be recorded as an expense.";
      return {
        ...next,
        actions: [
          ...selection.actions.filter((one) => one.row !== change.row),
          { row: change.row, action: change.action },
        ].toSorted((left, right) => left.row - right.row),
      };
    }
    case "suggestions":
      // Taking Kin's suggestions replaces the owner's own choice on each row Kin suggests for.
      return {
        ...next,
        suggestions: true,
        actions: selection.actions.filter(
          (one) => review.matches.get(one.row)?.suggestion.action === "later",
        ),
      };
  }
};

/** The review card: its first rows, its counts and the owner's selection so far. */
export const reviewCard = (
  statementId: string,
  review: Review,
  categories: ReadonlyArray<string>,
  selection: KinStatementSelection = defaultSelection(review),
  held: Held = NONE,
): KinStatementReviewCard => {
  const { statement } = review;
  const currency = statement.currency;
  const page = (section: KinStatementSection) =>
    rowsOf(review, section, 0, KIN_STATEMENT_CARD_ROWS, held);
  const matched = page("matched");
  const choose = page("choose");
  const unmatched = page("unmatched");
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
  const heldBack = heldBackWhy(review);
  return {
    text: STATEMENT_REVIEW_TEXT,
    statementId,
    hash: reviewHash(statementId, review),
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
      ...(held.size === 0
        ? []
        : [
            `${held.size} row${held.size === 1 ? " is" : "s are"} already recorded from this statement and stay${held.size === 1 ? "s" : ""} as ${held.size === 1 ? "it is" : "they are"}.`,
          ]),
      ...(review.source === "agent"
        ? ["Kin read these rows from images of a scanned statement: check them against it."]
        : []),
    ].map((line) => clamp(line, 300)),
    balance: statement.check.status,
    ...(review.source === "agent" ? { readByAgent: true as const } : {}),
    matched: matched.matched,
    choose: choose.choose,
    unmatched: unmatched.unmatched,
    counts: { matched: matched.total, choose: choose.total, unmatched: unmatched.total },
    selection,
    chosen: chosenCounts(review, selection, held),
    ...(heldBack === undefined ? {} : { heldBack }),
    recorded,
    categories: [...categories],
    status: "open",
  };
};
