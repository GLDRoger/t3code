import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinRecordId,
  KinRecordKey,
  type KinListDefinition,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { kinInvoiceView } from "@t3tools/client-runtime/kin/kinInvoices";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: what each money command was sent, and a refusal Issue answers with when set.
const host = vi.hoisted(() => ({
  sent: [] as Array<{ readonly command: string; readonly input: unknown }>,
  refuse: null as string | null,
}));

vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinHostConnected: () => true,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const command = (name: string, answer: (input: unknown) => unknown) => ({
    label: `test:${name}`,
    permissionAtom: () => allowed,
    run: commandRun(async (_registry: unknown, { input }: { readonly input: unknown }) => {
      host.sent.push({ command: name, input });
      return answer(input);
    }),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      docRender: command("docRender", () => AsyncResult.success({})),
      makeReceipt: command("makeReceipt", () => AsyncResult.success({})),
      workVoid: command("workVoid", () => AsyncResult.success({})),
      workUnvoid: command("workUnvoid", () => AsyncResult.success({})),
      workNextNumber: command("workNextNumber", () => AsyncResult.success({ number: "AM-0042" })),
      workIssue: command("workIssue", () =>
        host.refuse === null
          ? AsyncResult.success({ number: "AM-0042", problems: [] })
          : AsyncResult.failure(
              Cause.fail(new Refused({ reason: "not_allowed", message: host.refuse })),
            ),
      ),
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinInvoiceActions, KinMoneyActionNotice } from "./KinInvoice";
import { useKinMoneyActions } from "./useKinMoney";

// Ambermill, invented: a draft invoice to an invented client.
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const key = KinRecordKey.make("INV-8");
const def = {
  list: KinListId.make("invoices"),
  states: ["open", "waiting", "done", "dropped"],
  numbering: { prefix: "AM", series: "running", width: 4 },
} as unknown as KinListDefinition;
const draft = kinInvoiceView(
  {
    recordId: KinRecordId.make("rec-inv"),
    orgId: target.orgId,
    key,
    title: "Website build",
    state: "open",
    confirmed: true,
    list: def.list,
    amount: { minor: 1_250_00, currency: "EUR" },
    balance: { minor: 1_250_00, currency: "EUR" },
    received: { minor: 0, currency: "EUR" },
    party: { recordId: KinRecordId.make("rec-c3"), key: "C-3", title: "Lumen Grove" },
    fields: {},
    links: [],
    payments: [],
    changes: [],
    notes: "",
  } as unknown as KinRecordDetail,
  def,
  new Date("2026-11-20T10:00:00Z"),
);

function setup(refuse: string | null) {
  host.sent = [];
  host.refuse = refuse;
}

function Actions() {
  const actions = useKinMoneyActions(target);
  return (
    <>
      <KinInvoiceActions
        {...target}
        itemKey={key}
        invoice={draft}
        def={def}
        actions={actions}
        party={null}
        busy={false}
        onMake={() => {}}
      />
      <KinMoneyActionNotice actions={actions} />
    </>
  );
}

const screen = () => (
  <AppAtomRegistryProvider>
    <Actions />
  </AppAtomRegistryProvider>
);

describe("issuing an invoice", () => {
  it("asks first with the total, the client and the number the host will give, then issues once", async () => {
    setup(null);
    await using _screen = await render(screen());

    await userEvent.click(page.getByRole("button", { name: "Issue" }));
    const ask = page.getByRole("alertdialog");
    await expect.element(ask.getByText(/It will be AM-0042\./)).toBeVisible();
    await expect.element(ask.getByText("Total €1,250 to Lumen Grove.")).toBeVisible();
    expect(host.sent).toEqual([{ command: "workNextNumber", input: { orgId: target.orgId, key } }]);

    await userEvent.dblClick(ask.getByRole("button", { name: "Issue" }));
    await expect.element(page.getByText("Issued as AM-0042.")).toBeVisible();
    expect(host.sent.filter((one) => one.command === "workIssue")).toEqual([
      { command: "workIssue", input: { orgId: target.orgId, key } },
    ]);
  });

  it("shows the host's refusal in the person's words", async () => {
    setup("Only the owner can issue invoices here.");
    await using _screen = await render(screen());

    await userEvent.click(page.getByRole("button", { name: "Issue" }));
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Issue" }));
    await expect.element(page.getByText("Only the owner can issue invoices here.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Issue" })).toBeEnabled();
  });
});
