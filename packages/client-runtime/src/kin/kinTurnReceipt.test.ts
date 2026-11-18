import {
  KinAgentId,
  type KinMessageLink,
  type KinTurnChange,
  type KinTurnChanges,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinTurnReceiptLine, kinTurnReceiptRows, kinTurnReceiptTarget } from "./kinTurnReceipt.ts";

// Invented entries only.
const item = (key: string, seq: number, extra: Partial<KinTurnChange> = {}): KinTurnChange => ({
  key,
  title: `Invented ${key}`,
  what: "created",
  change: { agentId: KinAgentId.make("finance"), seq },
  undoable: true,
  undone: false,
  ...extra,
});
const turn = (items: ReadonlyArray<KinTurnChange>, count = items.length): KinTurnChanges => ({
  count,
  items,
  more: count - items.length,
});

describe("a turn's receipt", () => {
  it.each([
    ["an older host", undefined, null],
    ["nothing changed", turn([]), null],
    ["one entry", turn([item("W-25", 1)]), "Changed W-25"],
    ["one entry twice", turn([item("W-25", 1), item("W-25", 2)]), "Changed W-25"],
    ["two entries", turn([item("W-25", 1), item("W-26", 2)]), "Changed W-25 and W-26"],
    [
      "three entries",
      turn([item("W-25", 1), item("W-26", 2), item("W-27", 3)]),
      "Changed W-25, W-26 and 1 more",
    ],
    [
      "more than it lists",
      turn(
        [1, 2, 3, 4, 5].map((seq) => item(`W-${seq}`, seq)),
        7,
      ),
      "Changed W-1, W-2 and 5 more",
    ],
  ])("%s", (_name, receipt, line) => {
    expect(kinTurnReceiptLine(receipt)).toBe(line);
  });

  it("lists each change with whether it can still be put back", () => {
    const receipt = turn(
      [
        item("W-25", 1),
        item("W-26", 2, { what: "given to Finance", undoable: false, undone: true }),
        item("W-27", 3, { what: "notes changed", undoable: false }),
      ],
      5,
    );
    const { rows, more } = kinTurnReceiptRows(receipt);
    expect(rows.map((row) => [row.key, row.what, row.undo])).toEqual([
      ["W-25", "created", "undo"],
      ["W-26", "given to Finance", "undone"],
      ["W-27", "notes changed", "none"],
    ]);
    expect(rows[0]!.change).toEqual({ agentId: "finance", seq: 1 });
    expect(more).toBe("2 more changes");
    expect(kinTurnReceiptRows(turn([item("W-1", 1)], 2)).more).toBe("1 more change");
    expect(kinTurnReceiptRows(undefined)).toEqual({ rows: [], more: null });
  });

  it.each([
    ["the change's own kind", "client", "client"],
    ["the reply's link, from an older host", undefined, "project"],
  ] as const)("opens as %s", (_name, kind, opens) => {
    const links: ReadonlyArray<KinMessageLink> = [
      { text: "C-1", to: { _tag: "record", key: "C-1", kind: "project" }, note: null },
    ];
    expect(kinTurnReceiptTarget(item("C-1", 1, kind === undefined ? {} : { kind }), links)).toEqual(
      { _tag: "record", key: "C-1", kind: opens },
    );
  });

  it("opens an entry nothing names in the task sheet", () => {
    expect(kinTurnReceiptTarget(item("C-1", 1), undefined)).toEqual({
      _tag: "record",
      key: "C-1",
      kind: "task",
    });
  });
});
