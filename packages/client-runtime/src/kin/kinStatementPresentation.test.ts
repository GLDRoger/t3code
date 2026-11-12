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
  kinStatementActionOf,
  kinStatementAnswered,
  kinStatementLoaded,
  kinStatementLocal,
  kinStatementQueue,
  kinStatementShown,
  kinStatementActionsFor,
  kinStatementApplyInput,
  kinStatementChange,
  kinStatementConfirm,
  kinStatementFailureText,
  kinStatementNewer,
  kinStatementOpenSuggestions,
  kinStatementRowNote,
  kinStatementSections,
  kinStatementSelectionOf,
  kinStatementStatusLines,
  kinStatementSuggestionsLeft,
  kinStatementTakenBy,
  kinStatementTicked,
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
  it("shows each tap at once the way the server will keep it", () => {
    let selection = kinStatementSelectionOf(card);
    expect(kinStatementConfirm(card)).toEqual({ count: 2, label: "Confirm all 2" });
    expect(kinStatementOpenSuggestions(card.unmatched, selection)).toBe(3);
    expect(kinStatementRowNote(card.unmatched[0]!, "later")).toBe(
      "Kin suggests expense: Zomato, food",
    );
    expect(kinStatementRowNote(card.unmatched[0]!, "expense")).toBe("Zomato, food");

    const suggested = (row: number) => card.unmatched.find((one) => one.row === row)?.suggestion;
    selection = kinStatementChange(
      selection,
      { _tag: "action", row: 3, action: "ignore" },
      suggested,
    );
    selection = kinStatementChange(
      selection,
      { _tag: "action", row: 6, action: "ignore" },
      suggested,
    );
    // Kin's suggestions replace the owner's choice where Kin suggests; elsewhere it stays.
    selection = kinStatementChange(selection, { _tag: "suggestions" }, suggested);
    expect(card.unmatched.map((one) => kinStatementActionOf(selection, one))).toEqual([
      "expense",
      "expense",
      "transfer",
      "ignore",
    ]);
    expect(kinStatementSuggestionsLeft(card, card.unmatched, selection)).toBe(false);

    selection = kinStatementChange(selection, { _tag: "tick", row: 1, ticked: false });
    expect([0, 1].map((row) => kinStatementTicked(selection, row))).toEqual([true, false]);
    expect(kinStatementConfirm({ ...card, selection }).label).toBe("Confirm 5");
    selection = kinStatementChange(selection, { _tag: "tickAll", ticked: false });
    selection = kinStatementChange(selection, { _tag: "tick", row: 0, ticked: true });
    expect([0, 1].map((row) => kinStatementTicked(selection, row))).toEqual([true, false]);
    expect(kinStatementApplyInput(view, { ...selection, revision: 7 })).toEqual({
      orgId,
      statementId: "st_1",
      hash: card.hash,
      revision: 7,
    });
  });

  it("starts with nothing ticked when Kin holds the matches back", () => {
    const held = { ...card, heldBack: "Nothing is ticked: Kin read these rows from a scan." };
    expect(kinStatementConfirm(held)).toEqual({
      count: 0,
      label: "Nothing to confirm",
    });
  });

  it("counts a long card from the server, rows it never sent included", () => {
    const selection = { ...kinStatementSelectionOf(card), revision: 3 };
    const long = {
      ...card,
      counts: { matched: 400, choose: 1, unmatched: 900 },
      chosen: { matched: 400, choose: 0, unmatched: 0 },
      selection,
    };
    expect(kinStatementConfirm(long).label).toBe("Confirm all 400");
    // 900 rows not loaded may still take a suggestion.
    expect(kinStatementSuggestionsLeft(long, [], selection)).toBe(true);
    // The reply to a tap wins until a push as new as it arrives.
    const reply = { ...long, selection: { ...selection, revision: 4 } };
    expect(kinStatementNewer(long, reply)).toBe(reply);
    expect(kinStatementNewer(reply, long)).toBe(reply);
    expect(kinStatementNewer({ ...long, hash: "x".repeat(32) }, reply).hash).toBe("x".repeat(32));
  });

  it("keeps taps in order until the server answers, then shows its card", () => {
    const start = { ...card, selection: { ...kinStatementSelectionOf(card), revision: 1 } };
    let local = kinStatementLocal(card.hash);
    local = kinStatementQueue(local, card.hash, { _tag: "tick", row: 0, ticked: false });
    local = kinStatementQueue(local, card.hash, { _tag: "pick", row: 2, option: 1 });
    let shown = kinStatementShown(start, local);
    expect([shown.sending, kinStatementTicked(shown.selection, 0)]).toEqual([true, false]);
    expect(shown.selection.picks).toEqual([{ row: 2, option: 1 }]);

    // The first answer, then its push, then a refusal of the second: the pick goes back.
    const answered = {
      ...start,
      selection: { ...start.selection, revision: 2, ticked: "all" as const, except: [0] },
    };
    local = kinStatementAnswered(local, card.hash, answered);
    expect(kinStatementShown(start, local).card).toBe(answered);
    expect(kinStatementShown(answered, local).selection.picks).toHaveLength(1);
    local = kinStatementAnswered(local, card.hash, null);
    shown = kinStatementShown(answered, local);
    expect([shown.sending, shown.selection.picks, shown.selection.except]).toEqual([
      false,
      [],
      [0],
    ]);

    // Rows read later join the card's own, and a new read of the statement drops them.
    local = kinStatementLoaded(local, card.hash, {
      total: 3,
      matched: [{ ...row(9, "credit"), target: target(0, "INV-9") }],
      choose: [],
      unmatched: [],
    });
    expect(kinStatementShown(answered, local).rows.matched.map((one) => one.row)).toEqual([
      0, 1, 9,
    ]);
    const reread = { ...card, hash: "r".repeat(32) };
    expect(kinStatementShown(reread, local).rows.matched).toHaveLength(2);
  });

  it("won't offer an entry already picked for another row", () => {
    const twice = [
      { ...row(2, "credit"), options: [target(0, "INV-3"), target(1, "INV-4")] },
      { ...row(7, "credit"), options: [target(0, "INV-3"), target(1, "INV-5")] },
    ];
    const selection = kinStatementChange(kinStatementSelectionOf(card), {
      _tag: "pick",
      row: 2,
      option: 0,
    });
    expect(kinStatementTakenBy(twice, selection, 7, twice[1]!.options[0]!)?.row).toBe(2);
    expect(kinStatementTakenBy(twice, selection, 7, twice[1]!.options[1]!)).toBeUndefined();
    expect(kinStatementTakenBy(twice, selection, 2, twice[0]!.options[0]!)).toBeUndefined();
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
    expect(kinStatementSections({ ...card, status: "replaced" })).toEqual([]);
    expect(kinStatementStatusLines({ ...card, status: "replaced" })).toHaveLength(1);
    expect(
      kinStatementStatusLines({
        ...card,
        status: "undone",
        result: ["Undone: 2 changes.", "1 left"],
      }),
    ).toEqual(["Undone: 2 changes.", "1 left"]);
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
