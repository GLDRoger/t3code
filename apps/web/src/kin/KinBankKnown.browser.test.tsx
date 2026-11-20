import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinRecordId,
  type KinCash,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { kinInvoiceView } from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_BANK } from "@t3tools/client-runtime/kin/kinLists";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  cash: null as unknown,
  asked: [] as Array<string>,
}));

vi.mock(import("./useKinMoneyAnswers"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinCash: (() => ({
    state: { _tag: "ready", value: state.cash, stale: false },
    refresh: () => {},
  })) as never,
}));
vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAskAgent: (() => ({
    name: "Finance",
    ask: (message: string) => state.asked.push(message),
  })) as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinInvoiceFigures, KinInvoicePayments } from "./KinInvoice";
import { KinCashSection } from "./KinMoneyAnswers";

// Invented company, bank and amounts only.
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const now = new Date("2026-11-20T10:00:00Z");
const inr = (minor: number) => ({ minor, currency: "INR" });
const cash = (through: string | null): KinCash => ({
  asOf: "2026-11-20T10:00:00.000Z",
  today: "2026-11-20",
  timeZone: "UTC",
  known: true,
  accounts: [
    {
      label: "Invented Bank Account ••1234",
      kind: "account",
      balance: inr(4_00_000_00),
      on: "2026-10-31",
      ageDays: 20,
      stale: true,
      check: "adds_up",
      cannotTellApart: false,
      newerRead: null,
    },
  ],
  notOfRecord: [],
  byCurrency: [],
  bankKnown: { through },
});

function setup(value: KinCash) {
  state.cash = value;
  state.asked = [];
}

describe("Money says how far Kin sees the bank", () => {
  it("names the day, and the upload is one tap into the chat where statements are sent", async () => {
    const known = cash("2026-10-31");
    setup({
      ...known,
      bankKnown: {
        through: "2026-10-31",
        alerts: [
          {
            account: "Invented Bank Account ••1234",
            currency: "INR",
            since: "2026-10-31",
            seenThrough: "2026-11-18",
            in: 6,
            out: 14,
            balance: { minor: 4_10_000_00, on: "2026-11-18", estimate: true },
          },
        ],
      },
    });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinCashSection {...target} seq={1} rates={null} />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Bank known to Oct 31")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Since Oct 31, from bank alerts: 6 in, 14 out. About ₹4,10,000.00 on Nov 18.",
        ),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: KIN_BANK.upload }));
    expect(state.asked).toEqual([KIN_BANK.uploadMessage]);
  });

  it("says Kin can't see the bank when only a card's statement is confirmed", async () => {
    const card = cash(null);
    setup({ ...card, accounts: card.accounts.map((one) => ({ ...one, kind: "card" as const })) });
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinCashSection {...target} seq={1} rates={null} />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText(KIN_BANK.unseen)).toBeVisible();
  });
});

const invoice = (patch: Partial<KinRecordDetail>) =>
  ({
    recordId: KinRecordId.make("rec-inv"),
    orgId: target.orgId,
    key: "INV-8",
    title: "Website build",
    state: "waiting",
    list: KinListId.make("invoices"),
    amount: inr(95_000_00),
    balance: inr(95_000_00),
    received: inr(0),
    fields: {},
    links: [],
    payments: [],
    changes: [],
    notes: "",
    bankKnown: { through: "2026-10-31" },
    ...patch,
  }) as unknown as KinRecordDetail;

describe("an invoice's page", () => {
  it("reads as not recorded as paid, and each payment says where it came from", async () => {
    const names = { people: new Map([["rhea", "Rhea"]]), agents: new Map() };
    const unpaid = kinInvoiceView(invoice({}), null, now, names);
    const part = kinInvoiceView(
      invoice({
        balance: inr(45_000_00),
        received: inr(50_000_00),
        payments: [
          {
            paymentId: "p1",
            amount: inr(30_000_00),
            paidOn: "2026-10-12",
            note: "",
            recordedAt: "2026-10-12T00:00:00.000Z",
            voidedAt: null,
            source: { _tag: "statement" },
          },
          {
            paymentId: "p2",
            amount: inr(20_000_00),
            paidOn: "2026-11-18",
            note: "",
            recordedAt: "2026-11-18T00:00:00.000Z",
            voidedAt: null,
            source: { _tag: "person", personId: "rhea" },
          },
        ] as never,
      }),
      null,
      now,
      names,
    );
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinInvoiceFigures invoice={unpaid} />
        <KinInvoiceFigures invoice={part} />
        <KinInvoicePayments
          {...target}
          itemKey={"INV-8" as never}
          invoice={part}
          actions={{ busy: false, makeReceipt: async () => undefined } as never}
          canPay={false}
          busy={false}
          onTakeBack={() => {}}
          onOpenDoc={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByText("Not recorded as paid. Bank known to Oct 31."))
      .toBeVisible();
    await expect
      .element(page.getByText("The rest isn't recorded as paid. Bank known to Oct 31."))
      .toBeVisible();
    await expect.element(page.getByText(/from the bank statement$/)).toBeVisible();
    await expect.element(page.getByText(/recorded by Rhea$/)).toBeVisible();
  });
});
