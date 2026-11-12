import {
  EnvironmentId,
  KinChatError,
  KinOrgId,
  KinWidgetId,
  type KinStatementReviewCard,
  type KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinCardView } from "./kinCardPresentation.ts";
import {
  KIN_STATEMENT_EMPTY_SELECTION,
  kinStatementActionsFor,
  kinStatementApplyInput,
  kinStatementConfirm,
  kinStatementFailureText,
  kinStatementOpenSuggestions,
  kinStatementPick,
  kinStatementRowNote,
  kinStatementSections,
  kinStatementSetAction,
  kinStatementToggle,
  kinStatementUseSuggestions,
  type KinStatementReviewView,
} from "./kinStatementPresentation.ts";

const orgId = KinOrgId.make("org");
const row = (index: number, direction: "debit" | "credit") => ({
  row: index,
  date: "2026-10-02",
  text: `Row ${index}`,
  amount: "₹1.00",
  direction,
});
const target = (option: number, key: string) => ({
  option,
  kind: "invoice" as const,
  key,
  label: `${key} · Retainer`,
});
const card: KinStatementReviewCard = {
  text: "Kin read a bank statement.",
  statementId: "st_1",
  hash: "h".repeat(32),
  title: "HDFC Bank ••4821",
  summary: [],
  balance: "adds_up",
  matched: [
    { ...row(0, "credit"), target: target(0, "INV-1") },
    { ...row(1, "credit"), target: target(0, "INV-2") },
  ],
  choose: [{ ...row(2, "credit"), options: [target(0, "INV-3"), target(1, "INV-4")] }],
  unmatched: [
    { ...row(3, "debit"), suggestion: "expense", vendor: "Zomato", category: "food" },
    { ...row(4, "debit"), suggestion: "expense", vendor: "AWS", category: "not a category" },
    { ...row(5, "credit"), suggestion: "transfer" },
    { ...row(6, "debit"), suggestion: "later" },
  ],
  recorded: 0,
  categories: ["food", "software"],
  status: "open",
};
const view: KinStatementReviewView = { orgId, card };

describe("statement review card", () => {
  it("confirms the ticked matches by default, and Kin's suggestions only when taken", () => {
    expect(kinStatementApplyInput(view, KIN_STATEMENT_EMPTY_SELECTION)).toEqual({
      orgId,
      statementId: "st_1",
      hash: card.hash,
      matched: [0, 1],
      chosen: [],
      actions: [],
    });
    expect(kinStatementConfirm(view, KIN_STATEMENT_EMPTY_SELECTION)).toEqual({
      count: 2,
      label: "Confirm all 2",
    });
    expect(kinStatementOpenSuggestions(card, KIN_STATEMENT_EMPTY_SELECTION)).toBe(3);
    expect(kinStatementRowNote(card.unmatched[0]!, "later")).toBe(
      "Kin suggests expense: Zomato, food",
    );
    expect(kinStatementRowNote(card.unmatched[0]!, "expense")).toBe("Zomato, food");

    let selection = kinStatementUseSuggestions(card, KIN_STATEMENT_EMPTY_SELECTION);
    expect(kinStatementOpenSuggestions(card, selection)).toBe(0);
    // A category the Expenses list doesn't have is left for the server's default.
    expect(kinStatementApplyInput(view, selection).actions).toEqual([
      { row: 3, action: "expense", vendor: "Zomato", category: "food" },
      { row: 4, action: "expense", vendor: "AWS" },
      { row: 5, action: "transfer" },
    ]);

    selection = kinStatementToggle(selection, 1);
    selection = kinStatementPick(selection, 2, 1);
    selection = kinStatementSetAction(selection, 3, "ignore");
    selection = kinStatementSetAction(selection, 5, "later");
    expect(kinStatementApplyInput(view, selection)).toMatchObject({
      matched: [0],
      chosen: [{ row: 2, option: 1 }],
      actions: [
        { row: 3, action: "ignore" },
        { row: 4, action: "expense", vendor: "AWS" },
      ],
    });
    expect(kinStatementConfirm(view, selection).label).toBe("Confirm 4");
    // Ticking again and picking the same candidate again undo those changes.
    selection = kinStatementPick(kinStatementToggle(selection, 1), 2, 1);
    expect(kinStatementApplyInput(view, selection)).toMatchObject({ matched: [0, 1], chosen: [] });
  });

  it("has nothing to confirm when nothing is chosen", () => {
    const none = { orgId, card: { ...card, matched: [] } };
    expect(kinStatementConfirm(none, KIN_STATEMENT_EMPTY_SELECTION)).toEqual({
      count: 0,
      label: "Nothing to confirm",
    });
  });

  it("never offers money in as a new expense", () => {
    expect(kinStatementActionsFor(card.unmatched[2]!)).not.toContain("expense");
    expect(kinStatementActionsFor(card.unmatched[0]!)).toContain("expense");
  });

  it("opens a long statement only where the owner must pick", () => {
    const long = {
      ...card,
      matched: Array.from({ length: 120 }, (_, index) => card.matched[index % 2]!),
    };
    expect(kinStatementSections(long).map((one) => [one.id, one.openAtFirst])).toEqual([
      ["matched", false],
      ["choose", true],
      ["unmatched", false],
    ]);
    expect(kinStatementSections(card).every((one) => one.openAtFirst)).toBe(true);
    expect(kinStatementSections({ ...card, status: "applied" })).toEqual([]);
  });

  it("draws both statement cards from their widgets, and anything else as its own words", () => {
    const widget = (type: string, state: unknown): KinWidget =>
      ({
        widgetId: KinWidgetId.make("w"),
        orgId,
        type,
        widgetClass: "native",
        state,
      }) as unknown as KinWidget;
    const host = EnvironmentId.make("env");
    expect(kinCardView(widget("statement_review", card), host, () => true).kind).toBe(
      "statement_review",
    );
    expect(
      kinCardView(
        widget("statement_password", {
          text: "Locked.",
          statementId: "st_1",
          fileName: "oct.pdf",
          status: "locked",
        }),
        host,
        () => true,
      ).kind,
    ).toBe("statement_password");
    expect(kinCardView(widget("statement_review", { text: "Broken" }), host, () => true)).toEqual({
      kind: "unknown",
      text: "Broken",
    });
  });

  it("shows the server's own words when it refuses", () => {
    expect(
      kinStatementFailureText(
        new KinChatError({ reason: "conflict", message: "Something changed." }),
      ),
    ).toBe("Something changed.");
    expect(kinStatementFailureText(new Error("socket"))).toBe("Couldn't send that. Try again.");
  });
});
