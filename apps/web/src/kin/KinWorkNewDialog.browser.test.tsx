import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinWorkCreateInput,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// What `kin.work.create` was sent.
const host = vi.hoisted(() => ({ created: [] as Array<unknown> }));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (answer: (input: unknown) => unknown) => ({
    label: "test",
    permissionAtom: () => allowed,
    run: async (_registry: unknown, { input }: { readonly input: unknown }) => answer(input),
  });
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      workCreate: command((input) => {
        host.created.push(input);
        return AsyncResult.success({ key: "W-1" });
      }),
      workAssign: command(() => AsyncResult.success({})),
    } as never,
  };
});

import { KIN_WORK_NO_DRAFT, KIN_WORK_TITLE_TOO_LONG } from "@t3tools/client-runtime/kin/kinWork";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinWorkNewDialog } from "./KinWorkNewDialog";

// Ambermill, invented: owner Rhea, and enough clients that finding one is typing, not scrolling.
const rhea = KinPersonId.make("ambermill-rhea");
const clients = [
  "Orbit Dental",
  "Northgate Bakery",
  "Lumen Grove Clinics",
  "Cedar Labs",
  "Kestrel Freight",
  "Harbour Optics",
  "Saffron Kitchens",
  "Juniper Legal",
  "Marigold Schools",
  "Tidewater Marine",
].map((title, index) => ({ key: KinRecordKey.make(`C-${index + 1}`), title }));

function setup() {
  host.created = [];
}

function NewTask() {
  return (
    <AppAtomRegistryProvider>
      <KinWorkNewDialog
        environmentId={EnvironmentId.make("env-1")}
        orgId={KinOrgId.make("ambermill")}
        directory={
          {
            orgs: null,
            people: null,
            joined: null,
            invited: [],
            names: { people: new Map([[rhea, "Rhea"]]), agents: new Map(), me: rhea, zone: "UTC" },
          } as never
        }
        choices={{ clients, projects: [], doneProjects: [], projectClients: new Map() }}
        start={KIN_WORK_NO_DRAFT}
        onAdded={() => {}}
        onClose={() => {}}
      />
    </AppAtomRegistryProvider>
  );
}

describe("New task on the web", () => {
  it("keeps a long pasted title whole, counts it, and refuses it on Save", async () => {
    setup();
    await using _screen = await render(<NewTask />);
    const title = page.getByLabelText("What needs doing");
    const long = `Reconcile the Lumen Grove invoices ${"line by line ".repeat(21)}`.trim();
    expect(long.length).toBeGreaterThan(280);
    // One insert, as a paste lands: a cut-off field would keep only its first 280.
    await userEvent.fill(title, long);
    await expect.element(title).toHaveValue(long);
    await expect.element(page.getByText(`${long.length} of 280`)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add task" }));
    await expect.element(page.getByText(KIN_WORK_TITLE_TOO_LONG)).toBeVisible();
    expect(host.created).toEqual([]);
  });

  it("finds a client by typing part of its name, and a client alone owes nothing", async () => {
    setup();
    await using _screen = await render(<NewTask />);
    await userEvent.fill(page.getByLabelText("What needs doing"), "Send the revised quote");
    await userEvent.click(page.getByRole("combobox", { name: "Client" }));
    await userEvent.keyboard("kestr");
    await expect.element(page.getByRole("option", { name: "Kestrel Freight" })).toBeVisible();
    await expect
      .element(page.getByRole("option", { name: "Orbit Dental" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("option", { name: "Kestrel Freight" }));
    // K187: neither side is pressed, and the task stays a task.
    await expect
      .element(page.getByRole("button", { name: "We owe it" }))
      .toHaveAttribute("aria-pressed", "false");
    await userEvent.click(page.getByRole("button", { name: "Add task" }));
    await vi.waitFor(() =>
      expect(host.created).toEqual([
        expect.objectContaining({ title: "Send the revised quote", party: "C-5" }),
      ]),
    );
    expect(host.created[0]).not.toHaveProperty("category");
    expect((host.created[0] as KinWorkCreateInput).side).toBeUndefined();
  });
});
