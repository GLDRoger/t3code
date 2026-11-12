import {
  KIN_STATEMENT_CARD_ROWS,
  KIN_STATEMENT_PASSWORD_CARD,
  KinChatError,
  KIN_STATEMENT_REVIEW_CARD,
  KinStatementPasswordCard,
  KinStatementReviewCard,
  type KinOrgId,
  type KinStatementApplyInput,
  type KinStatementRowChoice,
  type KinStatementRowsInput,
  type KinStatementRowsResult,
  type KinStatementSection,
  type KinStatementSelectChange,
  type KinStatementSelection,
  type KinStatementTarget,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KIN_SEND_FAILED_TEXT } from "./kinDeferralPresentation.ts";

/**
 * A statement's two cards. The owner's ticks and picks live on the server, keyed to the review
 * they were made on, so Confirm applies them whole, rows this device never loaded included. A
 * tap shows at once and is sent in order; the server's reply is the card from then on.
 */

export interface KinStatementReviewView {
  readonly orgId: KinOrgId;
  readonly card: KinStatementReviewCard;
}
export interface KinStatementPasswordView {
  readonly orgId: KinOrgId;
  readonly card: KinStatementPasswordCard;
}

const isKinChatError = Schema.is(KinChatError);
const decodeReview = Schema.decodeUnknownOption(KinStatementReviewCard);
const decodePassword = Schema.decodeUnknownOption(KinStatementPasswordCard);

export function kinStatementReviewView(widget: KinWidget): KinStatementReviewView | null {
  if (widget.type !== KIN_STATEMENT_REVIEW_CARD) return null;
  const card = decodeReview(widget.state);
  return Option.isSome(card) ? { orgId: widget.orgId, card: card.value } : null;
}

export function kinStatementPasswordView(widget: KinWidget): KinStatementPasswordView | null {
  if (widget.type !== KIN_STATEMENT_PASSWORD_CARD) return null;
  const card = decodePassword(widget.state);
  return Option.isSome(card) ? { orgId: widget.orgId, card: card.value } : null;
}

type ReviewCard = KinStatementReviewCard;
type MatchedRow = ReviewCard["matched"][number];
type ChooseRow = ReviewCard["choose"][number];
type UnmatchedRow = ReviewCard["unmatched"][number];
export type { KinStatementRowChoice, KinStatementSelection };

/** A card from before selections were kept on the server starts from Kin's proposal. */
export const kinStatementSelectionOf = (card: ReviewCard): KinStatementSelection =>
  card.selection ?? {
    revision: 0,
    ticked: card.heldBack === undefined ? "all" : "none",
    except: [],
    picks: [],
    suggestions: false,
    actions: [],
  };

/** The newer of two copies of one card: a reply to a tap can arrive before the card's push. */
export const kinStatementNewer = (card: ReviewCard, reply: ReviewCard | null): ReviewCard =>
  reply !== null &&
  reply.hash === card.hash &&
  kinStatementSelectionOf(reply).revision > kinStatementSelectionOf(card).revision
    ? reply
    : card;

/** What a tap does, shown before the server answers; the server's reply then replaces it. */
export function kinStatementChange(
  selection: KinStatementSelection,
  change: KinStatementSelectChange,
  suggested?: (row: number) => KinStatementRowChoice | undefined,
): KinStatementSelection {
  switch (change._tag) {
    case "tick": {
      const except = selection.except.filter((row) => row !== change.row);
      return {
        ...selection,
        except: (selection.ticked === "all") === change.ticked ? except : [...except, change.row],
      };
    }
    case "tickAll":
      return { ...selection, ticked: change.ticked ? "all" : "none", except: [] };
    case "pick": {
      const picks = selection.picks.filter((one) => one.row !== change.row);
      return {
        ...selection,
        picks:
          change.option === null ? picks : [...picks, { row: change.row, option: change.option }],
      };
    }
    case "action":
      return {
        ...selection,
        actions: [
          ...selection.actions.filter((one) => one.row !== change.row),
          { row: change.row, action: change.action },
        ],
      };
    case "suggestions":
      return {
        ...selection,
        suggestions: true,
        actions: selection.actions.filter((one) => suggested?.(one.row) === "later"),
      };
  }
}

export const kinStatementTicked = (selection: KinStatementSelection, row: number) =>
  (selection.ticked === "all") !== selection.except.includes(row);

export const kinStatementPickOf = (selection: KinStatementSelection, row: number) =>
  selection.picks.find((one) => one.row === row)?.option;

export const kinStatementActionOf = (
  selection: KinStatementSelection,
  row: UnmatchedRow,
): KinStatementRowChoice =>
  selection.actions.find((one) => one.row === row.row)?.action ??
  (selection.suggestions ? row.suggestion : "later");

/** The other row an entry is already picked for: one entry answers one row. */
export function kinStatementTakenBy(
  rows: ReadonlyArray<ChooseRow>,
  selection: KinStatementSelection,
  row: number,
  target: KinStatementTarget,
): ChooseRow | undefined {
  return rows.find((other) => {
    if (other.row === row) return false;
    const picked = other.options[kinStatementPickOf(selection, other.row) ?? -1];
    return picked?.kind === target.kind && picked.key === target.key;
  });
}

/** How many rows a section has, loaded or not. */
export const kinStatementTotal = (card: ReviewCard, section: KinStatementSection) =>
  card.counts?.[section] ?? card[section].length;

/** Unmatched rows shown where Kin suggests something other than what the card now says; never a recorded one. */
export const kinStatementOpenSuggestions = (
  rows: ReadonlyArray<UnmatchedRow>,
  selection: KinStatementSelection,
) =>
  rows.filter(
    (one) =>
      one.recorded === undefined &&
      one.suggestion !== "later" &&
      kinStatementActionOf(selection, one) !== one.suggestion,
  ).length;

/** Whether "Use Kin's suggestions" still changes anything, rows not loaded yet included. */
export const kinStatementSuggestionsLeft = (
  card: ReviewCard,
  rows: ReadonlyArray<UnmatchedRow>,
  selection: KinStatementSelection,
) =>
  kinStatementOpenSuggestions(rows, selection) > 0 ||
  (!selection.suggestions && kinStatementTotal(card, "unmatched") > rows.length);

type Loaded = {
  readonly matched: ReadonlyArray<MatchedRow>;
  readonly choose: ReadonlyArray<ChooseRow>;
  readonly unmatched: ReadonlyArray<UnmatchedRow>;
};

/** What one device holds of a review card: taps not answered yet, the last reply, more rows. */
export interface KinStatementLocal {
  readonly hash: string;
  readonly reply: ReviewCard | null;
  readonly queued: ReadonlyArray<KinStatementSelectChange>;
  readonly more: Loaded;
}

export const kinStatementLocal = (hash: string): KinStatementLocal => ({
  hash,
  reply: null,
  queued: [],
  more: { matched: [], choose: [], unmatched: [] },
});

/**
 * The card as this device shows it. Every change is absolute (tick this row, pick that), so one
 * applied both by a push and by the queue lands the same; a new read starts over.
 */
export function kinStatementShown(card: ReviewCard, held: KinStatementLocal) {
  const local = held.hash === card.hash ? held : kinStatementLocal(card.hash);
  const shown = kinStatementNewer(card, local.reply);
  const rows: Loaded = {
    matched: [...shown.matched, ...local.more.matched],
    choose: [...shown.choose, ...local.more.choose],
    unmatched: [...shown.unmatched, ...local.more.unmatched],
  };
  const suggested = (row: number) => rows.unmatched.find((one) => one.row === row)?.suggestion;
  const selection = local.queued.reduce(
    (sum, change) => kinStatementChange(sum, change, suggested),
    kinStatementSelectionOf(shown),
  );
  return { card: shown, rows, selection, sending: local.queued.length > 0 };
}

export const kinStatementQueue = (
  local: KinStatementLocal,
  hash: string,
  change: KinStatementSelectChange,
): KinStatementLocal => {
  const held = local.hash === hash ? local : kinStatementLocal(hash);
  return { ...held, queued: [...held.queued, change] };
};

/** The server answered the oldest tap: its card, or nothing when it refused. */
export const kinStatementAnswered = (
  local: KinStatementLocal,
  hash: string,
  reply: ReviewCard | null,
): KinStatementLocal =>
  local.hash !== hash
    ? local
    : {
        ...local,
        queued: local.queued.slice(1),
        reply:
          reply !== null && kinStatementNewer(reply, local.reply) === reply ? reply : local.reply,
      };

export const kinStatementLoaded = (
  local: KinStatementLocal,
  hash: string,
  page: KinStatementRowsResult,
): KinStatementLocal => {
  const held = local.hash === hash ? local : kinStatementLocal(hash);
  return {
    ...held,
    more: {
      matched: [...held.more.matched, ...page.matched],
      choose: [...held.more.choose, ...page.choose],
      unmatched: [...held.more.unmatched, ...page.unmatched],
    },
  };
};

/** The apply request for the selection as the owner last saw it. */
export const kinStatementApplyInput = (
  view: KinStatementReviewView,
  selection: KinStatementSelection,
): KinStatementApplyInput => ({
  orgId: view.orgId,
  statementId: view.card.statementId,
  hash: view.card.hash,
  revision: selection.revision,
});

/** The next page of a section, after the rows this device has. */
export const kinStatementRowsInput = (
  view: KinStatementReviewView,
  section: KinStatementSection,
  offset: number,
): KinStatementRowsInput => ({
  orgId: view.orgId,
  statementId: view.card.statementId,
  hash: view.card.hash,
  section,
  offset,
  limit: KIN_STATEMENT_CARD_ROWS,
});

/**
 * How many rows Confirm records, and its label: "Confirm all 14" while every match is ticked.
 * Always the server's count: while a tap is on its way, Confirm waits rather than guess.
 */
export function kinStatementConfirm(card: ReviewCard): {
  readonly count: number;
  readonly label: string;
} {
  const selection = kinStatementSelectionOf(card);
  // A card from before counts were kept carries every row, so its own lists count it.
  const chosen = card.chosen ?? {
    matched: card.matched.filter((one) => kinStatementTicked(selection, one.row)).length,
    choose: card.choose.filter((one) => kinStatementPickOf(selection, one.row) !== undefined)
      .length,
    unmatched: card.unmatched.filter((one) => kinStatementActionOf(selection, one) !== "later")
      .length,
  };
  const count = chosen.matched + chosen.choose + chosen.unmatched;
  return {
    count,
    label:
      count === 0
        ? "Nothing to confirm"
        : kinStatementAllTicked(card, selection)
          ? `Confirm all ${count}`
          : `Confirm ${count}`,
  };
}

/** Matched rows ticked now: what "Tick all" and "Untick all" decide between. */
export const kinStatementAllTicked = (card: ReviewCard, selection: KinStatementSelection) =>
  selection.ticked === "all" &&
  selection.except.length === 0 &&
  kinStatementTotal(card, "matched") > 0;

export const KIN_STATEMENT_ACTION_LABELS: Record<KinStatementRowChoice, string> = {
  expense: "Expense",
  transfer: "Transfer",
  ignore: "Ignore",
  later: "Later",
};
/** The line under an unmatched row: what its new expense says, or what Kin suggests and why. */
export function kinStatementRowNote(
  row: KinStatementReviewCard["unmatched"][number],
  action: KinStatementRowChoice,
): string | null {
  const expense = [row.vendor, row.category].filter((part) => part !== undefined).join(", ");
  if (action === "expense") return expense === "" ? null : expense;
  if (row.suggestion !== "later" && action !== row.suggestion) {
    const what = KIN_STATEMENT_ACTION_LABELS[row.suggestion].toLowerCase();
    const detail = row.suggestion === "expense" ? expense : (row.why ?? "");
    return detail === "" ? `Kin suggests ${what}` : `Kin suggests ${what}: ${detail}`;
  }
  return row.why ?? null;
}

/** The actions a row offers: money in is never a new expense. */
export const kinStatementActionsFor = (
  row: KinStatementReviewCard["unmatched"][number],
): ReadonlyArray<KinStatementRowChoice> =>
  row.direction === "debit"
    ? ["expense", "transfer", "ignore", "later"]
    : ["transfer", "ignore", "later"];

export type KinStatementSectionId = KinStatementSection;
export const KIN_STATEMENT_SECTION_TITLES: Record<KinStatementSectionId, string> = {
  matched: "Matched",
  choose: "Pick a match",
  unmatched: "Not matched",
};
/** Rows a section shows at once; the rest arrive a page at a time, never all 300 in one render. */
export const KIN_STATEMENT_PAGE = 25;

/**
 * The sections a card shows, with what needs the owner open first. An applied or replaced card
 * shows what it says, not rows to decide again.
 */
export function kinStatementSections(card: KinStatementReviewCard): ReadonlyArray<{
  readonly id: KinStatementSectionId;
  readonly count: number;
  readonly openAtFirst: boolean;
}> {
  if (card.status === "applied" || card.status === "replaced") return [];
  const sections = (["matched", "choose", "unmatched"] as const)
    .map((id) => ({ id, count: kinStatementTotal(card, id) }))
    .filter((one) => one.count > 0);
  const total = sections.reduce((sum, one) => sum + one.count, 0);
  return sections.map((one) => ({
    ...one,
    // A short card is read whole; a long one opens only where the owner must decide.
    openAtFirst: total <= 8 || one.id === "choose",
  }));
}

export const kinStatementTargetLine = (target: KinStatementTarget) =>
  target.note === undefined ? target.label : `${target.label}, ${target.note.toLowerCase()}`;

export function kinStatementStatusLines(card: KinStatementReviewCard): ReadonlyArray<string> {
  switch (card.status) {
    case "applied":
      return card.result ?? [];
    case "undone":
      return (
        card.result ?? [
          "Undone: nothing from this statement is recorded. Confirm again when it's right.",
        ]
      );
    case "replaced":
      return ["Kin read this statement again: its newer card replaces this one."];
    case "open":
      return [];
  }
}

export const kinStatementPasswordLines = (
  card: KinStatementPasswordCard,
): ReadonlyArray<string> => {
  switch (card.status) {
    case "locked":
      return [`${card.fileName} is password-protected. The password goes to Kin only.`];
    case "wrong":
      return ["That password didn't open it. Try again."];
    case "opened":
      return [
        `Opened ${card.fileName}. Its review card follows.`,
        ...(card.remembered === undefined
          ? []
          : [`Kin keeps the password for ${card.remembered}.`]),
      ];
    case "unreadable":
      return [card.detail ?? `Kin opened ${card.fileName} but couldn't read it.`];
    case "limit":
      return ["Too many wrong passwords for this file. Send the statement again to try once more."];
  }
};

export const kinStatementNeedsPassword = (card: KinStatementPasswordCard) =>
  card.status === "locked" || card.status === "wrong";

/** Why the server refused, in its own words, which statements write for the owner. */
export const kinStatementFailureText = (cause: unknown): string =>
  isKinChatError(cause) && cause.message.trim() !== ""
    ? cause.message.slice(0, 300)
    : KIN_SEND_FAILED_TEXT;
