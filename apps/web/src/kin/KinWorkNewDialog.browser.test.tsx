import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinWorkCreateInput,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// What `kin.work.create` was sent, and what the host's client search was asked.
const host = vi.hoisted(() => ({ created: [] as Array<unknown>, searched: [] as Array<string> }));

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
      // The host's clients by name, past the first page the form holds.
      workClients: command((input) => {
        const text = (input as { readonly text: string }).text;
        host.searched.push(text);
        const parties = [
          ...clients.map((client) => ({ key: client.key, name: client.title })),
          { key: "C-120", name: "Zephyr Kitchens" },
        ].filter((party) => party.name.toLowerCase().includes(text.toLowerCase()));
        return AsyncResult.success({ parties, total: parties.length, nextCursor: null, seq: 1 });
      }),
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
  host.searched = [];
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

  it("finds a client past the first page by asking the host, and the task gets it", async () => {
    setup();
    await using _screen = await render(<NewTask />);
    await userEvent.fill(page.getByLabelText("What needs doing"), "Book the kitchen audit");
    await userEvent.click(page.getByRole("combobox", { name: "Client" }));
    await userEvent.keyboard("zephyr");
    await userEvent.click(page.getByRole("option", { name: "Zephyr Kitchens" }));
    // One question for the whole word, not one per letter.
    expect(host.searched).toEqual(["zephyr"]);
    await userEvent.click(page.getByRole("button", { name: "Add task" }));
    await vi.waitFor(() =>
      expect(host.created).toEqual([
        expect.objectContaining({ title: "Book the kitchen audit", party: "C-120" }),
      ]),
    );
  });

  it("says plainly when the host knows no client by that name", async () => {
    setup();
    await using _screen = await render(<NewTask />);
    await userEvent.click(page.getByRole("combobox", { name: "Client" }));
    await userEvent.keyboard("nobody");
    await expect.element(page.getByText("No client named “nobody”")).toBeVisible();
  });
});
