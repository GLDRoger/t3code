import {
  KIN_STATEMENT_PASSWORD_CARD,
  KinChatError,
  KIN_STATEMENT_REVIEW_CARD,
  KinStatementPasswordCard,
  KinStatementReviewCard,
  type KinOrgId,
  type KinStatementAction,
  type KinStatementApplyInput,
  type KinStatementTarget,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KIN_SEND_FAILED_TEXT } from "./kinDeferralPresentation.ts";

/**
 * A statement's two cards. The review card holds the owner's ticks and picks on the device until
 * Confirm, which sends exactly the rows the card showed; the server refuses any other set.
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

export type KinStatementRowChoice = KinStatementAction | "later";

/** What the owner changed on the card; everything else is what Kin proposed. */
export interface KinStatementSelection {
  /** Matched rows the owner unticked: they stay unexplained for later. */
  readonly unticked: ReadonlySet<number>;
  /** Rows with several candidates: the one picked, by index. Unpicked rows wait for later. */
  readonly picks: ReadonlyMap<number, number>;
  /** Unmatched rows whose action the owner changed from Kin's suggestion. */
  readonly actions: ReadonlyMap<number, KinStatementRowChoice>;
}

export const KIN_STATEMENT_EMPTY_SELECTION: KinStatementSelection = {
  unticked: new Set(),
  picks: new Map(),
  actions: new Map(),
};

export const kinStatementToggle = (
  selection: KinStatementSelection,
  row: number,
): KinStatementSelection => {
  const unticked = new Set(selection.unticked);
  if (unticked.has(row)) unticked.delete(row);
  else unticked.add(row);
  return { ...selection, unticked };
};

/** Picking the picked candidate again unpicks it. */
export const kinStatementPick = (
  selection: KinStatementSelection,
  row: number,
  option: number,
): KinStatementSelection => {
  const picks = new Map(selection.picks);
  if (picks.get(row) === option) picks.delete(row);
  else picks.set(row, option);
  return { ...selection, picks };
};

export const kinStatementSetAction = (
  selection: KinStatementSelection,
  row: number,
  action: KinStatementRowChoice,
): KinStatementSelection => ({
  ...selection,
  actions: new Map(selection.actions).set(row, action),
});

export const kinStatementActionOf = (
  selection: KinStatementSelection,
  row: KinStatementReviewCard["unmatched"][number],
): KinStatementRowChoice => selection.actions.get(row.row) ?? row.suggestion;

/** The apply request for what the card shows with the owner's changes. */
export function kinStatementApplyInput(
  view: KinStatementReviewView,
  selection: KinStatementSelection,
): KinStatementApplyInput {
  const { card } = view;
  return {
    orgId: view.orgId,
    statementId: card.statementId,
    hash: card.hash,
    matched: card.matched.filter((one) => !selection.unticked.has(one.row)).map((one) => one.row),
    chosen: card.choose.flatMap((one) => {
      const option = selection.picks.get(one.row);
      return option === undefined || one.options[option] === undefined
        ? []
        : [{ row: one.row, option }];
    }),
    actions: card.unmatched.flatMap((one) => {
      const action = kinStatementActionOf(selection, one);
      if (action === "later") return [];
      return [
        {
          row: one.row,
          action,
          ...(action === "expense" && one.vendor !== undefined ? { vendor: one.vendor } : {}),
          ...(action === "expense" &&
          one.category !== undefined &&
          card.categories.includes(one.category)
            ? { category: one.category }
            : {}),
        },
      ];
    }),
  };
}

/** How many rows Confirm records, and its label: "Confirm all 14" when nothing was held back. */
export function kinStatementConfirm(
  view: KinStatementReviewView,
  selection: KinStatementSelection,
): { readonly count: number; readonly label: string } {
  const input = kinStatementApplyInput(view, selection);
  const count = input.matched.length + input.chosen.length + input.actions.length;
  const all =
    selection.unticked.size === 0 &&
    input.chosen.length === view.card.choose.length &&
    input.actions.length === view.card.unmatched.length;
  return {
    count,
    label: count === 0 ? "Nothing to confirm" : all ? `Confirm all ${count}` : `Confirm ${count}`,
  };
}

export const KIN_STATEMENT_ACTION_LABELS: Record<KinStatementRowChoice, string> = {
  expense: "Expense",
  transfer: "Transfer",
  ignore: "Ignore",
  later: "Later",
};
/** The actions a row offers: money in is never a new expense. */
export const kinStatementActionsFor = (
  row: KinStatementReviewCard["unmatched"][number],
): ReadonlyArray<KinStatementRowChoice> =>
  row.direction === "debit"
    ? ["expense", "transfer", "ignore", "later"]
    : ["transfer", "ignore", "later"];

export type KinStatementSectionId = "matched" | "choose" | "unmatched";
export const KIN_STATEMENT_SECTION_TITLES: Record<KinStatementSectionId, string> = {
  matched: "Matched",
  choose: "Pick a match",
  unmatched: "Not matched",
};
/** Rows a section shows at once; the rest arrive a page at a time, never all 300 in one render. */
export const KIN_STATEMENT_PAGE = 25;

/** The sections a card shows, with what needs the owner open first. */
export function kinStatementSections(card: KinStatementReviewCard): ReadonlyArray<{
  readonly id: KinStatementSectionId;
  readonly count: number;
  readonly openAtFirst: boolean;
}> {
  const sections = [
    { id: "matched" as const, count: card.matched.length },
    { id: "choose" as const, count: card.choose.length },
    { id: "unmatched" as const, count: card.unmatched.length },
  ].filter((one) => one.count > 0);
  return sections.map((one) => ({
    ...one,
    // A short card is read whole; a long one opens only where the owner must decide.
    openAtFirst:
      card.matched.length + card.choose.length + card.unmatched.length <= 8 || one.id === "choose",
  }));
}

export const kinStatementTargetLine = (target: KinStatementTarget) =>
  target.note === undefined ? target.label : `${target.label}, ${target.note.toLowerCase()}`;

export function kinStatementStatusLines(card: KinStatementReviewCard): ReadonlyArray<string> {
  if (card.status === "applied")
    return [
      ...(card.result ?? []),
      ...(card.unexplained === undefined || card.unexplained === 0
        ? []
        : [
            `${card.unexplained} row${card.unexplained === 1 ? " is" : "s are"} still unexplained in Bank transactions.`,
          ]),
    ];
  if (card.status === "undone")
    return ["Undone: nothing from this statement is recorded. Confirm again when it's right."];
  return [];
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
  }
};

export const kinStatementNeedsPassword = (card: KinStatementPasswordCard) =>
  card.status === "locked" || card.status === "wrong";

/** Why the server refused, in its own words, which statements write for the owner. */
export const kinStatementFailureText = (cause: unknown): string =>
  isKinChatError(cause) && cause.message.trim() !== ""
    ? cause.message.slice(0, 300)
    : KIN_SEND_FAILED_TEXT;
