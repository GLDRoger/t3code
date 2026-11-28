import {
  kinBillsAddingStart,
  kinBillsStep,
  type KinBillsAdding,
  type KinBillsEvent,
} from "@t3tools/client-runtime/kin/kinBills";
import {
  EnvironmentId,
  type KinAttachment,
  KinOrgId,
  KinRecordKey,
  type KinBillBatchSummary,
  type KinBillRow,
} from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  uploaded: vi.fn<(file: File) => void>(),
  rows: [] as Array<unknown>,
  batch: null as unknown,
  act: null as unknown as (...args: Array<unknown>) => unknown,
  keepAll: null as unknown as (...args: Array<unknown>) => unknown,
  readUnreadAgain: null as unknown as (...args: Array<unknown>) => unknown,
  fix: null as unknown as (...args: Array<unknown>) => Promise<boolean>,
}));

vi.mock(import("../lib/attachmentUploadQueue"), () => ({
  startAttachmentUpload: ({ image }) => {
    if (image.file !== null) state.uploaded(image.file);
  },
  awaitAttachmentUploads: async () => {},
  getUploadedAttachments: ({ images }) => [...images],
  readAttachmentUpload: () => undefined,
  releaseAttachmentUpload: () => {},
}));

vi.mock(import("../assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrls: (_environmentId, resources) =>
    resources.map(
      () => "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    ),
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
    readUnreadAgain: state.readUnreadAgain,
  })) as never,
  useKinBillFix: (() => ({ busy: false, problem: null, save: state.fix })) as never,
  // The dialog's own steps, as the shared hook keeps them; nothing is sent.
  useKinBillsAdd: ((
    _target: unknown,
    upload: (file: File, name: string) => Promise<KinAttachment>,
  ) => {
    const [held, set] = useState<KinBillsAdding<File>>(kinBillsAddingStart<File>);
    const step = (event: KinBillsEvent<File>) => set((was) => kinBillsStep(was, event));
    return {
      allowed: true,
      state: held,
      choose: (files: Extract<KinBillsEvent<File>, { _tag: "chose" }>["files"]) =>
        step({ _tag: "chose", files }),
      remove: (id: string) => step({ _tag: "removed", id }),
      send: async () => {
        for (const file of held.files.filter((file) => file.upload._tag === "waiting")) {
          await upload(file.source, file.name);
        }
        return null;
      },
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
      read: { vendor: "Tidewater Freight", amount: "2350", currency: "INR", currencyAssumed: true },
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
  state.readUnreadAgain = vi.fn();
  state.fix = vi.fn(async () => true);
  return {
    act: state.act,
    keepAll: state.keepAll,
    readUnreadAgain: state.readUnreadAgain,
    fix: state.fix,
  };
}

describe("bills added in bulk", () => {
  it("uploads the original phone photo while chat still caps the same file", async () => {
    state.uploaded.mockClear();
    const canvas = new OffscreenCanvas(4032, 3024);
    canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
    const original = new File([await canvas.convertToBlob({ type: "image/jpeg" })], "page.jpg", {
      type: "image/jpeg",
    });
    await using screen = await render(
      <KinAddBillsDialog {...target} onReview={() => {}} onOpenKey={() => {}} onClose={() => {}} />,
    );
    await userEvent.upload(screen.getByLabelText("Photos or PDFs of bills"), original);
    await userEvent.click(screen.getByRole("button", { name: "Add 1 bill" }));
    await vi.waitFor(() => expect(state.uploaded).toHaveBeenCalledOnce());
    expect(state.uploaded.mock.calls[0]![0].size).toBe(original.size);
    expect(new Uint8Array(await state.uploaded.mock.calls[0]![0].arrayBuffer())).toEqual(
      new Uint8Array(await original.arrayBuffer()),
    );
    const { prepareImageForAttachment } = await import("../lib/imageCompression");
    expect(await prepareImageForAttachment(original, 10 * 1024 * 1024)).toMatchObject({
      ok: true,
      recompressed: true,
      imageSize: { width: 2000, height: 1500 },
    });
  });

  it.each([
    { limit: "pixels", width: 8000, height: 6500, trailingBytes: 0, expected: [7844, 6373] },
    {
      limit: "bytes",
      width: 4032,
      height: 3024,
      trailingBytes: 12 * 1024 * 1024,
      expected: [3312, 2484],
    },
  ])(
    "fits a bill over the $limit ceiling without applying the chat edge",
    async ({ width, height, trailingBytes, expected }) => {
      state.uploaded.mockClear();
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext("2d")!.fillRect(0, 0, width, height);
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg" });
      const original = new File(
        [jpeg, new Uint8Array(Math.max(0, trailingBytes - jpeg.size))],
        "large-bill.jpg",
        { type: "image/jpeg" },
      );
      await using screen = await render(
        <KinAddBillsDialog
          {...target}
          onReview={() => {}}
          onOpenKey={() => {}}
          onClose={() => {}}
        />,
      );
      await userEvent.upload(screen.getByLabelText("Photos or PDFs of bills"), original);
      await userEvent.click(screen.getByRole("button", { name: "Add 1 bill" }));
      await vi.waitFor(() => expect(state.uploaded).toHaveBeenCalledOnce());
      const sent = state.uploaded.mock.calls[0]![0];
      expect(sent.size).toBeLessThanOrEqual(10 * 1024 * 1024);
      const bitmap = await createImageBitmap(sent);
      try {
        expect([bitmap.width, bitmap.height]).toEqual(expected);
      } finally {
        bitmap.close();
      }
    },
  );

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
      <AppAtomRegistryProvider>
        <KinBillsPage {...target} batchId="b-1" onOpenKey={onOpenKey} onOpenBatch={() => {}} />
      </AppAtomRegistryProvider>,
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
    // No currency printed on it: the row says which one Kin took.
    await expect.element(screen.getByText("No currency printed: read as INR")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open bill-1.jpg" }));
    await userEvent.click(page.getByRole("button", { name: "Back, close image preview" }));

    await userEvent.click(screen.getByRole("button", { name: "Keep: Sample Cloud, $49.00" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(1) }), "keep");
    await userEvent.click(screen.getByRole("button", { name: "Drop: Sample Cloud, $49.00" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(1) }), "drop");
    await userEvent.click(screen.getByRole("button", { name: "Edit: Sample Cloud, $49.00" }));
    expect(onOpenKey).toHaveBeenLastCalledWith("EXP-4");

    await userEvent.click(
      screen.getByRole("button", { name: /^Add anyway: Tidewater Freight, \S+2,350\.00$/ }),
    );
    expect(host.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: SHA(2) }),
      "addAnyway",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /^Open EXP-2: Tidewater Freight, \S+2,350\.00$/ }),
    );
    expect(onOpenKey).toHaveBeenLastCalledWith("EXP-2");

    await userEvent.click(screen.getByRole("button", { name: "Read again: Bill 3" }));
    expect(host.act).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: SHA(3) }),
      "readAgain",
    );
    await userEvent.click(screen.getByRole("button", { name: "Dismiss: Bill 3" }));
    expect(host.act).toHaveBeenLastCalledWith(expect.objectContaining({ key: SHA(3) }), "dismiss");
    await expect
      .element(screen.getByRole("button", { name: "Keep: Bill 3" }))
      .not.toBeInTheDocument();
    // Read cleanly with a figure to check: fixed in place, since reading again reads the same.
    await expect.element(screen.getByText("CA$1,180,000.00")).toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Fix and keep: Tidewater Freight, CA$1,180,000.00" }),
      )
      .toBeVisible();
    // Nothing read off it at all: entered by hand.
    await expect
      .element(screen.getByRole("button", { name: "Enter by hand: Bill 3" }))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("button", { name: "Read again: Tidewater Freight, CA$1,180,000.00" }),
      )
      .not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Keep all that read cleanly" }));
    expect(host.keepAll).toHaveBeenCalledOnce();
    // The one row reading again can change is asked for, and the button says how many.
    await userEvent.click(screen.getByRole("button", { name: "Read the unread one again" }));
    expect(host.readUnreadAgain).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: SHA(3) }),
    ]);
  });

  it("fixes a bill not read cleanly in place, every figure read filled in, and keeps it", async () => {
    const host = setup();
    state.rows = [
      bill(5, {
        state: "unreadable",
        problem: "Couldn't read: date",
        read: {
          vendor: "Harbor Cafe",
          amount: "1200",
          currency: "USD",
          tax: "60",
          number: "HC-12",
        },
      }),
    ];
    await using screen = await render(
      <AppAtomRegistryProvider>
        <KinBillsPage {...target} batchId="b-1" onOpenKey={() => {}} onOpenBatch={() => {}} />
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText("Needs its date")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Enter by hand: Harbor Cafe, $1,200.00" }))
      .not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Fix and keep: Harbor Cafe, $1,200.00" }),
    );
    const dialog = page.getByRole("dialog", { name: "Fix and keep" });
    // The form opens on the one figure the person still has to read off it.
    await expect.element(dialog.getByLabelText(/^Date ?Needed$/)).toHaveFocus();
    await expect.element(dialog.getByText("Still needed: date.")).toBeVisible();
    // The bill itself is on the form, and opens whole without leaving it.
    await userEvent.click(dialog.getByRole("button", { name: "Open bill-5.jpg" }));
    await userEvent.click(page.getByRole("button", { name: "Back, close image preview" }));
    await expect.element(dialog.getByLabelText("Who was paid")).toHaveValue("Harbor Cafe");
    await expect.element(dialog.getByLabelText("Amount")).toHaveValue("1200");
    await expect.element(dialog.getByLabelText("Tax")).toHaveValue("60");
    await expect.element(dialog.getByLabelText("Bill number")).toHaveValue("HC-12");
    // In the currency read off the bill, not the company's.
    await expect.element(dialog.getByText(/USD/)).toBeVisible();
    // The one figure missing is marked as needed, and keeping waits for it.
    await expect.element(dialog.getByLabelText(/^Date ?Needed$/)).toHaveValue("");
    await userEvent.click(dialog.getByRole("button", { name: "Keep" }));
    await expect.element(dialog.getByText("Enter the date.")).toBeVisible();
    // Beside the date it is about, not at the top of the form.
    const dateField = dialog
      .getByLabelText(/^Date ?Needed$/)
      .element()
      .closest("div");
    expect(dateField?.textContent).toContain("Enter the date.");
    expect(dateField?.textContent).not.toContain("Who was paid");
    expect(host.fix).not.toHaveBeenCalled();
    await userEvent.fill(dialog.getByLabelText(/^Date ?Needed$/), "2026-11-06");
    await userEvent.click(dialog.getByRole("button", { name: "Keep" }));
    expect(host.fix).toHaveBeenCalledWith(SHA(5), {
      vendor: "Harbor Cafe",
      date: "2026-11-06",
      amount: "1200.00",
      currency: "USD",
      tax: "60.00",
      number: "HC-12",
    });
    await expect
      .element(page.getByRole("dialog", { name: "Fix and keep" }))
      .not.toBeInTheDocument();
  });

  it("heads a row Reading… only while it is read, and counts only bills whose read landed", async () => {
    setup();
    const reading = bill(6, { state: "reading", read: { vendor: "Inkspot Cloud", amount: "49" } });
    state.rows = [
      reading,
      bill(7, { state: "unreadable", problem: "Finance: The photo is blurred." }),
    ];
    state.batch = {
      ...(state.batch as KinBillBatchSummary),
      bills: 2,
      states: { reading: 1, read: 0, kept: 0, dropped: 0, duplicate: 0, unreadable: 1 },
    };
    const page_ = () => (
      <AppAtomRegistryProvider>
        <KinBillsPage {...target} batchId="b-1" onOpenKey={() => {}} onOpenBatch={() => {}} />
      </AppAtomRegistryProvider>
    );
    await using screen = await render(page_());
    await expect.element(screen.getByText("Reading…")).toBeVisible();
    await expect
      .element(screen.getByText("1 bill so far: 1 couldn't be read. 1 more being read."))
      .toBeVisible();
    // Its read lands: the row says what it is at once, and the count only grows.
    state.rows = [
      { ...reading, state: "unreadable", problem: "Couldn't read: date" },
      state.rows[1]!,
    ];
    state.batch = {
      ...(state.batch as KinBillBatchSummary),
      states: { reading: 0, read: 0, kept: 0, dropped: 0, duplicate: 0, unreadable: 2 },
    };
    await screen.rerender(page_());
    await expect.element(screen.getByText("Reading…")).not.toBeInTheDocument();
    await expect.element(screen.getByText("2 bills: 2 couldn't be read.")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Read the 2 unread again" }))
      .toBeVisible();
  });
});
