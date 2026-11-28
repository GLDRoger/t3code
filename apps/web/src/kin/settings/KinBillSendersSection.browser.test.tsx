import type { KinBillSendersResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { kinBillSenderSinceDefault } from "@t3tools/client-runtime/kin/kinBillSenders";
import { kinNow } from "@t3tools/client-runtime/kin/kinNow";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { KinBillSendersSection } from "./KinBillSendersSection";

type Row = KinBillSendersResult["rows"][number];

const host = vi.hoisted(() => ({
  rows: [] as Array<Row>,
  calls: [] as Array<string>,
  refuse: null as string | null,
  /** Answers the read-since call that is waiting, as the host does after its search. */
  finish: null as null | ((text: string, older: boolean) => void),
  show: () => {},
}));

vi.mock(import("../useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinHostConnected: () => true,
  useKinGate: () => null,
}));

vi.mock(import("../kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { appAtomRegistry: registry } = await import("../../rpc/atomRegistry");
  const { KinChatError } = await import("@t3tools/contracts");
  const read = A.make(() => R.success({ rows: [...host.rows] })).pipe(A.keepAlive);
  const granted = A.make("granted" as const);
  const allowed = A.make(true);
  host.show = () => registry.refresh(read);
  const command = <C extends object>(real: C, name: string, state: Row["state"] | null) => ({
    ...real,
    permissionAtom: () => allowed,
    run: async (
      _registry: unknown,
      { input }: { readonly input: { readonly address: string } },
    ) => {
      host.calls.push(`${name}:${input.address}`);
      if (host.refuse !== null)
        return R.failure(
          Cause.fail(new KinChatError({ reason: "not_allowed", message: host.refuse })),
        );
      host.rows = host.rows.flatMap((row) =>
        row.address !== input.address
          ? [row]
          : state === null
            ? []
            : [{ ...row, state, decidedBy: "Rhea", decidedAt: Date.UTC(2026, 10, 27) }],
      );
      return R.success(undefined);
    },
  });
  // Spread through a type parameter, as `command` is, so the fake keeps the real command's type.
  const waiting = <C extends object>(real: C, fake: object) => ({ ...real, ...fake });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      billSenders: () => read,
      billSendersList: { ...real.kinClient.billSendersList, permissionStateAtom: () => granted },
      billSendersApprove: command(real.kinClient.billSendersApprove, "approve", "approved"),
      billSendersDecline: command(real.kinClient.billSendersDecline, "decline", "declined"),
      billSendersRemove: command(real.kinClient.billSendersRemove, "remove", null),
      billSendersAdd: command(real.kinClient.billSendersAdd, "add", "approved"),
      billSendersReadSince: waiting(real.kinClient.billSendersReadSince, {
        permissionAtom: () => allowed,
        run: (
          _registry: unknown,
          { input }: { readonly input: { readonly address: string; readonly since: string } },
        ) => {
          host.calls.push(`readSince:${input.address}:${input.since}`);
          return new Promise((resolve) => {
            host.finish = (text, older) => {
              host.finish = null;
              resolve(R.success({ queued: 200, older, text }));
            };
          });
        },
      }),
    },
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { run: (registry: unknown, input: unknown) => Promise<unknown> }) =>
    (input: unknown) =>
      command.run(null, input),
}));

const row = (overrides: Partial<Row>): Row => ({
  address: "billing@inkspot.example",
  name: "Inkspot Cloud",
  state: "waiting",
  seenCount: 3,
  firstSeenAt: Date.UTC(2026, 10, 20),
  lastSeenAt: Date.UTC(2026, 10, 24),
  decidedAt: null,
  decidedBy: null,
  askedInChat: true,
  ...overrides,
});

function setup() {
  host.rows = [
    row({}),
    row({
      address: "bills@harborpower.example",
      name: "Harbor Power",
      seenCount: 5,
      state: "approved",
      decidedBy: "Meera",
      decidedAt: Date.UTC(2026, 10, 22),
    }),
  ];
  host.calls.length = 0;
  host.refuse = null;
  host.finish = null;
  host.show();
}

const section = () => (
  <AppAtomRegistryProvider>
    <KinBillSendersSection environmentId={"env-1" as never} orgId={"org-1" as never} />
  </AppAtomRegistryProvider>
);

describe("Settings → Billing senders", () => {
  it("approves a waiting sender only through its question, and shows the host's refusal", async () => {
    setup();
    await using _screen = await render(section());
    const waiting = page.getByRole("heading", { name: "Waiting for an answer" });
    await expect.element(waiting).toBeVisible();
    await expect.element(page.getByText(/^3 mails seen, the newest on /)).toBeVisible();
    expect(page.getByText("Inkspot Cloud").elements()).toHaveLength(0);

    const approve = page.getByRole("button", { name: "Approve: billing@inkspot.example" });
    await userEvent.click(approve);
    const ask = page.getByRole("alertdialog");
    await expect.element(ask.getByText("Read bills from billing@inkspot.example?")).toBeVisible();
    await expect
      .element(
        ask.getByText(
          "Kin will read bills this address sends to the company's mailboxes and suggest them as expenses for you to keep. Approving also reads the mail Kin held from it in the last 30 days.",
        ),
      )
      .toBeVisible();
    await userEvent.click(ask.getByRole("button", { name: "Cancel" }));
    expect(host.calls).toEqual([]);

    await userEvent.click(approve);
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Approve" }));
    expect(host.calls).toEqual(["approve:billing@inkspot.example"]);
    await expect.element(waiting).not.toBeInTheDocument();
    await expect.element(page.getByText(/^Approved by Rhea on /)).toBeVisible();

    host.refuse = "Only an owner or co-owner can manage billing senders.";
    await userEvent.click(page.getByRole("button", { name: "Remove: bills@harborpower.example" }));
    await expect
      .element(page.getByText("Stop reading bills from bills@harborpower.example?"))
      .toBeVisible();
    await userEvent.click(page.getByRole("alertdialog").getByRole("button", { name: "Remove" }));
    await expect.element(page.getByRole("alert").getByText(host.refuse)).toBeVisible();
    expect(host.calls).toEqual([
      "approve:billing@inkspot.example",
      "remove:bills@harborpower.example",
    ]);
    await expect.element(page.getByText(/^Approved by Meera on /)).toBeVisible();
  });

  it("reads an approved sender's mail since a day: working while it runs, then the host's sentence", async () => {
    setup();
    await using _screen = await render(section());
    const open = page.getByRole("button", {
      name: "Read this sender's bills since… bills@harborpower.example",
    });
    await userEvent.click(open);
    const since = page.getByLabelText("Since");
    const day = kinBillSenderSinceDefault(kinNow());
    await expect.element(since).toHaveValue(day);
    await userEvent.click(page.getByRole("button", { name: "Read bills" }));

    const working = page.getByRole("button", {
      name: "Looking through mail… bills@harborpower.example",
    });
    await expect.element(working).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Remove: bills@harborpower.example" }))
      .toBeEnabled();
    expect(host.calls).toEqual([`readSince:bills@harborpower.example:${day}`]);

    const text =
      "Kin is reading 200 mails from bills@harborpower.example since 1 Oct. There are older mails. Run this again to read the next 200.";
    host.finish?.(text, true);
    await expect.element(page.getByRole("status").getByText(text)).toBeVisible();
    await expect.element(open).toBeEnabled();
    expect(host.calls).toHaveLength(1);

    await userEvent.click(open);
    await expect.element(page.getByLabelText("Since")).toHaveValue(day);
  });
});
