// @effect-diagnostics globalDate:off - Fixtures read a batch's day against a fixed now.
import {
  parseKinMoney,
  type KinAttachment,
  type KinBillBatchSummary,
  type KinBillRow,
  type KinBillsAddResult,
  type KinRecordKey,
  type KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_BILLS,
  kinBillBatchCardView,
  kinBillExpenseStart,
  kinBillFileRefusal,
  kinBillRowView,
  kinBillsAddingStart,
  kinBillsButton,
  kinBillsEntry,
  kinBillsKeptAll,
  kinBillsOutcome,
  kinBillsSend,
  kinBillsStep,
  type KinBillsAdding,
  type KinBillsEvent,
} from "./kinBills.ts";

const SHA = (n: number) => String(n).padStart(64, "0");

const row = (overrides: Partial<KinBillRow> = {}): KinBillRow =>
  ({
    sha256: SHA(1),
    batchId: "b-1",
    file: {
      attachmentId: "kin-chat-1",
      name: "sample-cloud.jpg",
      mimeType: "image/jpeg",
      chatId: "chat-1",
      messageId: "m-1",
    },
    state: "read",
    read: {},
    expense: { key: "EXP-4", rev: 2, title: "Sample Cloud, Nov 2026" },
    addedAt: "2026-11-24T09:00:00.000Z",
    ...overrides,
  }) as KinBillRow;

describe("a bill on the review list", () => {
  it("says its state and offers what that state allows", () => {
    const cases: ReadonlyArray<[Partial<KinBillRow>, string, ReadonlyArray<string>]> = [
      [{ state: "reading", expense: undefined }, "Reading…", []],
      [{ state: "read" }, "Read", ["keep", "edit", "drop"]],
      [{ state: "kept" }, "Kept", ["openExpense"]],
      [{ state: "dropped" }, "Dropped", ["openExpense"]],
      [
        { state: "duplicate", expense: undefined, duplicateOf: { key: "EXP-2", title: "Fuel" } },
        "Looks like EXP-2 Fuel",
        ["addAnyway", "dismiss", "openDuplicate"],
      ],
      [
        { state: "unreadable", expense: undefined, problem: "Couldn't read: amount" },
        "Couldn't read this one",
        ["byHand", "readAgain", "dismiss"],
      ],
    ];
    for (const [overrides, label, actions] of cases) {
      const view = kinBillRowView(row(overrides));
      expect(view.label).toBe(label);
      expect(view.actions).toEqual(actions);
    }
    // The host's own sentence, as it wrote it; Read again only where reading again can change it.
    const unread: ReadonlyArray<[string, boolean, ReadonlyArray<string>]> = [
      [
        "Kin can't read this kind of photo: add it as a JPEG or PNG.",
        false,
        ["byHand", "readAgain", "dismiss"],
      ],
      [
        "Couldn't read: currency. Finance: No currency printed.",
        false,
        ["byHand", "readAgain", "dismiss"],
      ],
      ["Finance: The photo is blurred.", false, ["byHand", "readAgain", "dismiss"]],
      ["The amount is far above the rest of Expenses: check it.", true, ["byHand", "dismiss"]],
      ["The date is after today: check it.", true, ["byHand", "dismiss"]],
      ["The date is more than ten years back: check it.", true, ["byHand", "dismiss"]],
    ];
    for (const [problem, readClean, actions] of unread) {
      const view = kinBillRowView(
        row({
          state: "unreadable",
          expense: undefined,
          problem,
          ...(readClean ? { readClean } : {}),
        }),
      );
      expect([view.problem, view.actions]).toEqual([problem, actions]);
    }
    expect(kinBillRowView(row({ state: "unreadable", problem: "It is for 0" })).problem).toBe(
      "It is for 0",
    );
    // A problem shows only on a bill that couldn't be read.
    expect(kinBillRowView(row({ state: "read", problem: "old" })).problem).toBeNull();
  });

  it("leaves every blank the reader left empty, and shows money in its own currency", () => {
    const view = kinBillRowView(
      row({ read: { vendor: "Tidewater Freight", amount: "1250", currency: "USD" } }),
    );
    expect(view.fields.map((field) => [field.key, field.value])).toEqual([
      ["vendor", "Tidewater Freight"],
      ["date", null],
      ["amount", "$1,250.00"],
      ["tax", null],
      ["category", null],
      ["number", null],
    ]);
    const money = (read: KinBillRow["read"]) =>
      kinBillRowView(row({ read }))
        .fields.filter((field) => field.key === "amount" || field.key === "tax")
        .map((field) => field.value);
    // Plain numbers in the bill's own currency, whatever the company's, through the one formatter.
    expect(money({ amount: "1200.50", tax: "60.03", currency: "CAD" })).toEqual([
      "CA$1,200.50",
      "CA$60.03",
    ]);
    expect(money({ amount: "1200", tax: "180", currency: "PKR" })).toEqual([
      "PKR\u00a01,200",
      "PKR\u00a0180",
    ]);
    expect(money({ amount: "-500", currency: "EUR" })).toEqual(["−€500.00", null]);
    // No currency printed: the figure as read, no currency guessed.
    expect(money({ amount: "4999" })).toEqual(["4999", null]);
    // A figure the host couldn't read in its currency stays as read, never converted.
    expect(money({ amount: "1200.50", currency: "PKR" })).toEqual(["1200.50 PKR", null]);
    expect(money({ amount: "€20", currency: "INR" })).toEqual(["€20 INR", null]);
    expect(money({ amount: "  " })).toEqual([null, null]);
  });

  it("carries why Keep all left it", () => {
    const skipped = new Map([[SHA(1), "Already kept."]]);
    expect(kinBillRowView(row(), { skipped }).skipped).toBe("Already kept.");
    expect(kinBillRowView(row({ sha256: SHA(2) }), { skipped }).skipped).toBeNull();
  });
});

describe("the files an add takes", () => {
  it("takes photos and PDFs and says why for anything else, before uploading", () => {
    expect(kinBillFileRefusal({ name: "a.jpg", mimeType: "image/jpeg" })).toBeNull();
    expect(kinBillFileRefusal({ name: "a.heic", mimeType: "image/heic" })).toBeNull();
    expect(kinBillFileRefusal({ name: "bill.PDF", mimeType: "application/pdf" })).toBeNull();
    expect(kinBillFileRefusal({ name: "bill.pdf", mimeType: "" })).toBeNull();
    expect(kinBillFileRefusal({ name: "rates.xlsx", mimeType: "" })).toBe(KIN_BILLS.notABill);
    expect(kinBillFileRefusal({ name: "notes.txt", mimeType: "text/plain" })).toBe(
      KIN_BILLS.notABill,
    );
  });

  it("refuses past a hundred, one by one", () => {
    const files = Array.from({ length: 101 }, (_, n) => ({
      id: `f${n}`,
      name: `${n}.jpg`,
      mimeType: "image/jpeg",
      source: n,
    }));
    const state = kinBillsStep(kinBillsAddingStart<number>(), { _tag: "chose", files });
    expect(state.files.at(-1)?.upload).toEqual({ _tag: "refused", reason: KIN_BILLS.tooMany });
    expect(kinBillsButton(state).count).toBe(100);
  });
});

const attachment = (id: string): KinAttachment => ({
  type: "image",
  id,
  name: `${id}.jpg`,
  mimeType: "image/jpeg",
  sizeBytes: 10,
});

const answered = (added: ReadonlyArray<string>): KinBillsAddResult => ({
  batchId: "b-1",
  chatId: "chat-1" as KinBillsAddResult["chatId"],
  widgetId: "bills:b-1" as KinBillsAddResult["widgetId"],
  added: added.map((name, n) => ({ name, sha256: SHA(n) })),
  already: [],
  refused: [],
});

/** A dialog's state held the way the hook holds it, for `kinBillsSend` to drive. */
function harness(names: ReadonlyArray<string>) {
  let state: KinBillsAdding<string> = kinBillsStep(kinBillsAddingStart<string>(), {
    _tag: "chose",
    files: names.map((name) => ({ id: name, name, mimeType: "image/jpeg", source: name })),
  });
  let ids = 0;
  return {
    state: () => state,
    dispatch: (event: KinBillsEvent<string>) => {
      state = kinBillsStep(state, event);
    },
    newId: () => `request-${++ids}`,
  };
}

describe("adding bills", () => {
  it("goes on past a file that fails to upload, and adds the rest in one request", async () => {
    const held = harness(["a", "b", "c"]);
    const sent: Array<{ ids: ReadonlyArray<string>; requestId: string }> = [];
    const result = await kinBillsSend({
      ...held,
      upload: async (source) => {
        if (source === "b") throw new Error("The connection dropped.");
        return attachment(source);
      },
      add: async (attachments, requestId) => {
        sent.push({ ids: attachments.map((one) => one.id), requestId });
        return { ok: true, value: answered(["a", "c"]) };
      },
    });
    expect(result?.batchId).toBe("b-1");
    expect(sent).toEqual([{ ids: ["a", "c"], requestId: "request-1" }]);
    expect(held.state().files.map((file) => file.upload._tag)).toEqual([
      "added",
      "failed",
      "added",
    ]);
    expect(held.state().files[1]?.upload).toEqual({
      _tag: "failed",
      problem: "The connection dropped.",
    });
    // The one left is the button's; with a file that didn't go in, the dialog stays open.
    expect(kinBillsButton(held.state())).toMatchObject({ count: 1, label: "Add 1 bill" });
    expect(kinBillsOutcome(held.state())).toMatchObject({ review: "b-1", close: false });
  });

  it("sends a retried add with the same request id, and new files with a new one", async () => {
    const held = harness(["a", "b"]);
    const sent: Array<string> = [];
    const answers = [
      { ok: false as const, problem: "Couldn't reach Kin." },
      { ok: true as const, value: answered(["a", "b"]) },
    ];
    const run = () =>
      kinBillsSend({
        ...held,
        upload: async (source) => attachment(source),
        add: async (_attachments, requestId) => {
          sent.push(requestId);
          return answers.shift() ?? { ok: false, problem: "none" };
        },
      });
    await run();
    expect(held.state().problem).toBe("Couldn't reach Kin.");
    expect(kinBillsButton(held.state())).toMatchObject({ count: 2, disabled: false });
    await run();
    expect(sent).toEqual(["request-1", "request-1"]);
    expect(kinBillsOutcome(held.state())).toEqual({
      review: "b-1",
      close: true,
      lines: [],
      dropped: [],
    });

    held.dispatch({
      _tag: "chose",
      files: [{ id: "c", name: "c", mimeType: "image/jpeg", source: "c" }],
    });
    answers.push({ ok: true, value: answered(["c"]) });
    await run();
    expect(sent.at(-1)).not.toBe("request-1");
  });

  it("stays open to say what was already added or refused", () => {
    const state = kinBillsStep(harness(["a"]).state(), {
      _tag: "added",
      result: {
        ...answered([]),
        already: [{ name: "a.jpg", sha256: SHA(3) }],
        refused: [{ name: "b.txt", reason: "Only photos and PDFs are read as bills." }],
      },
    });
    expect(kinBillsOutcome(state)).toEqual({
      review: null,
      close: false,
      lines: ["Already added before: a.jpg.", "b.txt: Only photos and PDFs are read as bills."],
      dropped: [],
    });
  });

  it("says which file's expense was dropped, with that expense, and offers it no other add", async () => {
    const held = harness(["a", "b"]);
    await kinBillsSend({
      ...held,
      upload: async (source) => attachment(source),
      add: async () => ({
        ok: true,
        value: {
          ...answered([]),
          already: [
            { name: "a.jpg", sha256: SHA(3), expense: "EXP-4" as KinRecordKey },
            { name: "b.jpg", sha256: SHA(4), expense: "EXP-5" as KinRecordKey, dropped: true },
          ],
        },
      }),
    });
    expect(kinBillsOutcome(held.state())).toEqual({
      review: null,
      close: false,
      lines: ["Already added before: a.jpg."],
      dropped: [
        {
          key: SHA(4),
          text: "b.jpg was added before, and its expense was dropped.",
          expense: "EXP-5",
        },
      ],
    });
    expect(kinBillsButton(held.state())).toMatchObject({ count: 0, disabled: true });
  });

  it("takes the host's answer as it is when it cuts a long name, matching nothing by name", async () => {
    const long = `${"Tidewater Freight invoice ".repeat(10)}.jpg`;
    const held = harness([long, "b"]);
    await kinBillsSend({
      ...held,
      upload: async (source) => attachment(source === long ? "long" : source),
      add: async () => ({
        ok: true,
        value: {
          ...answered(["b"]),
          already: [{ name: long.slice(0, 200), sha256: SHA(9) }],
        },
      }),
    });
    expect(held.state().files.map((file) => [file.name, file.upload._tag])).toEqual([
      [long, "added"],
      ["b", "added"],
    ]);
    expect(kinBillsOutcome(held.state())?.lines).toEqual([
      `Already added before: ${long.slice(0, 200)}.`,
    ]);
  });
});

describe("a batch", () => {
  const summary = (
    batchId: string,
    addedAt: string,
    states: Partial<KinBillBatchSummary["states"]>,
  ): KinBillBatchSummary =>
    ({
      batchId,
      addedBy: "p-rhea",
      addedAt,
      chatId: "chat-1",
      widgetId: `bills:${batchId}`,
      bills: 4,
      states: {
        reading: 0,
        read: 0,
        kept: 0,
        dropped: 0,
        duplicate: 0,
        unreadable: 0,
        ...states,
      },
    }) as KinBillBatchSummary;
  const now = new Date("2026-11-24T12:00:00");

  it("is reached from Expenses only once there is one, straight when there is only one", () => {
    expect(kinBillsEntry([], now)).toBeNull();
    const one = summary("b-1", "2026-11-24T09:00:00", { read: 2, kept: 1, duplicate: 1 });
    expect(kinBillsEntry([one], now)).toEqual({
      batchId: "b-1",
      // The day as the reader's locale writes it, without the year this year.
      label: expect.stringMatching(/^Bills added on (24 Nov|Nov 24)$/),
      detail: "4 bills: 2 to keep, 1 looks like a duplicate, 1 kept.",
    });
    const older = summary("b-0", "2025-03-02T09:00:00", { read: 1, unreadable: 3 });
    expect(kinBillsEntry([one, older], now)).toEqual({
      batchId: null,
      label: "Bills added",
      detail: expect.stringMatching(/^Newest on (24 Nov|Nov 24) · 3 to keep$/),
    });
  });

  it("says how many Keep all kept, and why each other one wasn't", () => {
    expect(kinBillsKeptAll({ kept: ["EXP-1", "EXP-2"], skipped: [] }).said).toBe(
      "Kept 2 expenses.",
    );
    const some = kinBillsKeptAll({
      kept: ["EXP-1"],
      skipped: [{ sha256: SHA(5), key: "EXP-9", why: "Already kept." }],
    });
    expect(some.said).toBe("Kept 1 expense. 1 wasn't: why is on each.");
    expect(some.skipped.get(SHA(5))).toBe("Already kept.");
  });

  it("draws its card with the host's sentence and a count while Kin reads", () => {
    const card = (state: Record<string, unknown>) =>
      ({
        orgId: "org",
        type: "bill_batch",
        state: {
          text: "Reading 12 bills: 4 done.",
          batchId: "b-1",
          total: 12,
          done: 4,
          counts: { read: 3, duplicate: 1, unreadable: 0, already: 0 },
          addedBy: "p-rhea",
          ...state,
        },
      }) as unknown as KinWidget;
    expect(kinBillBatchCardView(card({ status: "reading" }))).toEqual({
      orgId: "org",
      batchId: "b-1",
      text: "Reading 12 bills: 4 done.",
      reading: true,
      progress: "4 of 12",
    });
    expect(kinBillBatchCardView(card({ status: "done", done: 12 }))?.progress).toBeNull();
    // Held by the reader's daily limit: the host's sentence says so, and no count looks alive.
    const paused =
      "Reading 12 bills: 4 done. Paused until 00:00: today's limit for Finance is used up.";
    expect(
      kinBillBatchCardView(
        card({ status: "reading", text: paused, pausedUntil: "2026-11-25T00:00:00.000Z" }),
      ),
    ).toMatchObject({ text: paused, reading: true, progress: null });
    // Reading goes on: the field is gone and the count is back.
    expect(kinBillBatchCardView(card({ status: "reading" }))?.progress).toBe("4 of 12");
  });
});

describe("a bill typed by hand", () => {
  it("starts the form with its file and what was read, an amount only in the home currency", () => {
    const unread = row({
      state: "unreadable",
      read: { vendor: "Sample Cloud", date: "2026-11-02", amount: "49.00", category: "Software" },
    });
    expect(kinBillExpenseStart(unread, "INR", ["software", "travel"])).toEqual({
      receipt: "kin-chat-1",
      vendor: "Sample Cloud",
      paidOn: "2026-11-02",
      category: "software",
    });
    const home = row({ read: { amount: "2350.75", currency: "INR" } });
    const start = kinBillExpenseStart(home, "INR", []);
    expect(start).toEqual({ receipt: "kin-chat-1", amount: "2350.75" });
    // The form reads the plain number back in the company's currency.
    expect(parseKinMoney(start.amount ?? "", "INR")).toEqual({
      money: { minor: 235075, currency: "INR" },
    });
    expect(
      kinBillExpenseStart(row({ read: { amount: "1200.50", currency: "CAD" } }), "INR", []),
    ).toEqual({ receipt: "kin-chat-1" });
  });
});
