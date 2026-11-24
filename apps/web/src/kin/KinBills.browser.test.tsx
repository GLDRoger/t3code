import {
  kinBillsAddingStart,
  kinBillsStep,
  type KinBillsAdding,
  type KinBillsEvent,
} from "@t3tools/client-runtime/kin/kinBills";
import {
  EnvironmentId,
  KinOrgId,
  KinRecordKey,
  type KinBillBatchSummary,
  type KinBillRow,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  rows: [] as Array<unknown>,
  batch: null as unknown,
  act: null as unknown as (...args: Array<unknown>) => unknown,
  keepAll: null as unknown as (...args: Array<unknown>) => unknown,
}));

vi.mock(import("./useKinBills"), () => ({
  useKinBillBatches: (() => ({
    allowed: true,
    state: { _tag: "ready", value: { batches: [state.batch], bills: [] }, stale: false },
    refresh: () => {},
  })) as never,
  useKinBillBatch: (() => ({
    state: { _tag: "ready", value: { batches: [], bills: state.rows }, stale: false },
    rows: state.rows,
    batch: state.batch,
    refresh: () => {},
  })) as never,
  useKinBillActions: (() => ({
    allowed: true,
    busy: null,
    problem: null,
    kept: null,
    act: state.act,
    keepAll: state.keepAll,
  })) as never,
  // The dialog's own steps, as the shared hook keeps them; nothing is sent.
  useKinBillsAdd: (() => {
    const [held, set] = useState<KinBillsAdding<File>>(kinBillsAddingStart<File>);
    const step = (event: KinBillsEvent<File>) => set((was) => kinBillsStep(was, event));
    return {
      allowed: true,
      state: held,
      choose: (files: Extract<KinBillsEvent<File>, { _tag: "chose" }>["files"]) =>
        step({ _tag: "chose", files }),
      remove: (id: string) => step({ _tag: "removed", id }),
      send: async () => null,
    };
  }) as never,
}));

vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinLists: (() => ({
    state: { _tag: "ready", value: { lists: [] }, stale: false },
    refresh: () => {},
  })) as never,
  useKinHomeCurrency: (() => "INR") as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { KinAddBillsDialog, KinBillsPage } from "./KinBills";

// Invented company, people and payees only.
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("ambermill") };
const SHA = (n: number) => String(n).padStart(64, "0");
const file = (n: number) => ({
  attachmentId: `kin-chat-${n}`,
  name: `bill-${n}.jpg`,
  mimeType: "image/jpeg",
  chatId: "chat-1",
  messageId: "m-1",
});
const bill = (n: number, overrides: Partial<KinBillRow>) =>
  ({
    sha256: SHA(n),
    batchId: "b-1",
    file: file(n),
    read: {},
    addedAt: "2026-11-24T09:00:00.000Z",
    ...overrides,
  }) as KinBillRow;

function setup() {
  state.rows = [
    bill(1, {
      state: "read",
      read: { vendor: "Sample Cloud", amount: "49", currency: "USD" },
      expense: { key: KinRecordKey.make("EXP-4"), rev: 1, title: "Sample Cloud, Nov 2026" },
    }),
    bill(2, {
      state: "duplicate",
      read: { vendor: "Tidewater Freight", amount: "2350", currency: "INR" },
      duplicateOf: { key: KinRecordKey.make("EXP-2"), title: "Tidewater Freight, Nov 2026" },
    }),
    bill(3, { state: "unreadable", problem: "Couldn't read: amount, currency" }),
    bill(4, {
      state: "unreadable",
      read: { vendor: "Tidewater Freight", date: "2026-11-03", amount: "1180000", currency: "CAD" },
      problem: "The amount is far above the rest of Expenses: check it.",
      readClean: true,
    }),
  ];
  state.batch = {
    batchId: "b-1",
    addedBy: "rhea",
    addedAt: "2026-11-24T09:00:00.000Z",
    chatId: "chat-1",
    widgetId: "bills:b-1",
    bills: 3,
    states: { reading: 0, read: 1, kept: 0, dropped: 0, duplicate: 1, unreadable: 1 },
  } as unknown as KinBillBatchSummary;
  state.act = vi.fn();
  state.keepAll = vi.fn();
  return { act: state.act, keepAll: state.keepAll };
}

describe("bills added in bulk", () => {
  it("lists every chosen file, and says why one isn't a bill before anything uploads", async () => {
    await using screen = await render(
      <KinAddBillsDialog {...target} onReview={() => {}} onOpenKey={() => {}} onClose={() => {}} />,
    );
    await userEvent.upload(screen.getByLabelText("Photos or PDFs of bills"), [
      new File(["a"], "sample-cloud.jpg", { type: "image/jpeg" }),
      new File(["b"], "tidewater.pdf", { type: "application/pdf" }),
      new File(["c"], "notes.txt", { type: "text/plain" }),
    ]);
    const chosen = screen.getByRole("list", { name: "Chosen bills" });
    await expect.element(chosen.getByText("sample-cloud.jpg")).toBeVisible();
    await expect.element(chosen.getByText("tidewater.pdf")).toBeVisible();
    await expect.element(chosen.getByText("Only photos and PDFs are read as bills.")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add 2 bills" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    await expect.element(chosen.getByText("notes.txt")).not.toBeInTheDocument();
  });

  it("offers each bill what its state allows, and sends the tap that was made", async () => {
    const host = setup();
    const onOpenKey = vi.fn();
    await using screen = await render(
      <KinBillsPage {...target} batchId="b-1" onOpenKey={onOpenKey} onOpenBatch={() => {}} />,
    );
    await expect
      .element(
        screen.getByText("3 bills: 1 to keep, 1 looks like a duplicate, 1 couldn't be read."),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText("Looks like EXP-2 Tidewater Freight, Nov 2026"))
      .toBeVisible();
    await expect.element(screen.getByText("Couldn't read: amount, currency")).toBeVisible();
    // In the currency printed on it, never converted.
    await expect.element(screen.getByText("$49.00")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Keep: bill-1.jpg" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(1) }), "keep");
    await userEvent.click(screen.getByRole("button", { name: "Drop: bill-1.jpg" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(1) }), "drop");
    await userEvent.click(screen.getByRole("button", { name: "Edit: bill-1.jpg" }));
    expect(onOpenKey).toHaveBeenLastCalledWith("EXP-4");

    await userEvent.click(screen.getByRole("button", { name: "Add anyway: bill-2.jpg" }));
    expect(host.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: SHA(2) }),
      "addAnyway",
    );
    await userEvent.click(screen.getByRole("button", { name: "Open EXP-2: bill-2.jpg" }));
    expect(onOpenKey).toHaveBeenLastCalledWith("EXP-2");

    await userEvent.click(screen.getByRole("button", { name: "Read again: bill-3.jpg" }));
    expect(host.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: SHA(3) }),
      "readAgain",
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss: bill-3.jpg" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(3) }), "dismiss");
    await expect
      .element(screen.getByRole("button", { name: "Keep: bill-3.jpg" }))
      .not.toBeInTheDocument();
    // Read cleanly with a figure to check: typed by hand, since reading again reads the same.
    await expect.element(screen.getByText("CA$1,180,000.00")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Enter by hand: bill-4.jpg" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Read again: bill-4.jpg" }))
      .not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Keep all that read cleanly" }));
    expect(host.keepAll).toHaveBeenCalledOnce();
  });
});
