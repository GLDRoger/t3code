import {
  EnvironmentId,
  formatKinWhen,
  KinOrgId,
  KinPersonId,
  type KinImportApplied,
  type KinImportCheck,
  type KinImportRuns,
  type KinImportUndone,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  runs: null as unknown,
  check: null as unknown as (...args: Array<unknown>) => unknown,
  apply: null as unknown as (...args: Array<unknown>) => unknown,
  undo: null as unknown as (...args: Array<unknown>) => unknown,
}));

vi.mock(import("./useKinImport"), () => ({
  useKinImportRuns: (() => ({
    state: { _tag: "ready", value: state.runs, stale: false },
    refresh: () => {},
  })) as never,
  useKinImportSend: (() => ({
    check: async (input: unknown) => ({ ok: true, value: state.check(input) }),
    apply: async (input: unknown) => ({ ok: true, value: state.apply(input) }),
    undo: async (batch: unknown) => ({ ok: true, value: state.undo(batch) }),
  })) as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { KinImportView } from "./KinImport";

// Invented company and clients only.
const rhea = KinPersonId.make("rhea");
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const names = { people: new Map([[rhea, "Rhea"]]), agents: new Map(), me: rhea, zone: "UTC" };

const proposal: KinImportCheck = {
  batch: "fabc",
  rows: 3,
  columns: [
    { header: "Company", sample: "Invented Kestrel Freight", target: "client.name" },
    { header: "Fax", sample: "Met at stand B12", target: "skip" },
  ],
  mapping: { columns: ["client.name", "skip"] },
  asks: { currency: false, dateFormat: false, dateExamples: [] },
  checked: false,
  will: { prospects: 0, clients: 0, contacts: 0, deals: 0 },
  matched: 0,
  matches: [],
  decide: [],
  stages: [],
  companyStages: [],
  homeCurrency: "EUR",
  ownersUnknown: 0,
  leftOut: [],
  more: 0,
  notImported: [],
  ready: false,
};
const checked: KinImportCheck = {
  ...proposal,
  mapping: { columns: ["client.name", "client.notes"] },
  checked: true,
  will: { prospects: 1, clients: 1, contacts: 0, deals: 0 },
  matched: 1,
  matches: [
    {
      source: "r2",
      name: "Invented Kestrel Freight",
      key: "C-1",
      existing: "Invented Kestrel Freight",
      by: "name",
      detail: "the same name",
      decision: "same",
      kept: [],
    },
  ],
  decide: [
    {
      source: "r3",
      name: "Invented Lumen Grove (Oslo)",
      rows: 1,
      candidates: [{ key: "C-2", name: "Invented Lumen Grove" }],
      decision: null,
    },
  ],
};
const applied: KinImportApplied = {
  batch: "fabc",
  added: { prospects: 1, clients: 1, contacts: 0, deals: 0 },
  matched: 1,
  filled: 0,
  leftOut: [],
  more: 0,
  noticed: { noNextStep: 0, datesPassed: 0 },
};
const undone: KinImportUndone = {
  batch: "fabc",
  removed: { clients: 2, contacts: 0, deals: 0, other: 0 },
  restored: 0,
  kept: [],
};

function setup() {
  state.runs = {
    runs: [
      {
        batch: "fold",
        file: "old-crm-companies.csv",
        by: rhea,
        at: "2026-11-12T09:00:00.000Z",
        added: { clients: 214, contacts: 61, deals: 0, other: 0 },
        undone: null,
      },
    ],
  } satisfies KinImportRuns;
  state.check = vi.fn((input: unknown) =>
    (input as { readonly mapping?: unknown }).mapping === undefined ? proposal : checked,
  );
  state.apply = vi.fn(() => applied);
  state.undo = vi.fn(() => undone);
  return { check: state.check, apply: state.apply, undo: state.undo };
}

const pick = async (trigger: string, option: string) => {
  await userEvent.click(page.getByRole("combobox", { name: trigger }));
  await userEvent.click(page.getByRole("option", { name: option }));
};

describe("KinImportView", () => {
  it("picks a file, changes a column, decides a close name, imports, and undoes", async () => {
    const host = setup();
    await using screen = await render(
      <KinImportView {...target} directory={names as never} onOpenDeals={() => {}} />,
    );
    await expect
      .element(
        screen.getByText(
          `old-crm-companies.csv · Rhea · ${formatKinWhen(Date.parse("2026-11-12T09:00:00.000Z"), "date")} · 214 clients and 61 contacts`,
        ),
      )
      .toBeVisible();

    const file = new File(["Company,Fax\nInvented Kestrel Freight,x\n"], "old-crm.csv", {
      type: "text/csv",
    });
    await userEvent.upload(screen.getByLabelText("Choose a file"), file);
    await expect.element(screen.getByText("old-crm.csv · 3 rows")).toBeVisible();
    expect(host.check).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ mapping: expect.anything() }),
    );

    await pick("Fax Goes to", "Notes");
    await userEvent.click(screen.getByRole("button", { name: "Check 3 rows" }));
    expect(host.check).toHaveBeenLastCalledWith(
      expect.objectContaining({ mapping: { columns: ["client.name", "client.notes"] } }),
    );
    await expect.element(screen.getByText("What will happen")).toBeVisible();
    const importButton = screen.getByRole("button", { name: "Import", exact: true });
    await expect.element(importButton).toBeDisabled();

    await pick("Invented Lumen Grove (Oslo) Decide", "A new one");
    await expect.element(importButton).toBeEnabled();
    await userEvent.click(importButton);
    expect(host.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        batch: "fabc",
        decisions: { clients: { r3: "new" } },
        mapping: { columns: ["client.name", "client.notes"] },
      }),
    );
    await expect
      .element(screen.getByText("1 prospect and 1 client are in Kin. 1 matched what you had."))
      .toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Undo this import" }));
    expect(host.undo).toHaveBeenCalledWith("fabc");
    await expect.element(screen.getByText("Removed 2 clients.")).toBeVisible();
  });
});
