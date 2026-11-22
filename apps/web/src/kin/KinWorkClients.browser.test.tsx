import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinPartyPage,
  type KinPartyRow,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  clients: [] as Array<unknown>,
  page: null as unknown,
  filters: [] as Array<unknown>,
  sees: false,
  marketing: { tags: [] as Array<string>, cameFrom: [] as Array<unknown> },
}));

vi.mock(import("./useKinWork"), async (importOriginal) => {
  const { KIN_CLIENTS_DEFAULT_FILTER } = await import("@t3tools/client-runtime/kin/kinWorkClients");
  const list = (records: ReadonlyArray<unknown>, filter: unknown) => ({
    state: {
      filter,
      records,
      total: records.length,
      more: false,
      seq: 1,
      loading: false,
      failed: null,
      refreshing: false,
      loadingMore: false,
      moreFailed: false,
      stale: false,
    },
    list: {
      setFilter: (next: unknown) => {
        state.filters.push(next);
      },
      refresh: () => {},
      loadMore: async () => {},
    },
  });
  return {
    ...(await importOriginal()),
    useKinClientsList: (() => list(state.clients, KIN_CLIENTS_DEFAULT_FILTER)) as never,
    useKinClientPage: (() => ({
      state: { _tag: "ready", value: state.page, stale: false },
      refresh: () => {},
    })) as never,
    useKinWorkHistory: (() => list([], { text: "" })) as never,
  };
});
// The page's other sections read the host on their own; these tests are about its first rows.
vi.mock(
  import("./KinAttention"),
  () =>
    ({
      KinAttentionSection: () => null,
      KinAttentionItem: () => null,
      KinAttentionHandled: () => null,
      KinAsideNote: () => null,
      kinAttentionNames: () => new Map(),
    }) as never,
);
vi.mock(import("./KinWorkPlaceLists"), () => ({ KinWorkPlaceLists: () => null }) as never);
vi.mock(import("./KinDocsList"), () => ({ KinDocsUnder: () => null }) as never);
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinSeesClients: () => state.sees,
}));
vi.mock(import("./KinMarketing"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinMarketing: () => state.marketing as never,
}));

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinWorkClientPage, KinWorkClientsList } from "./KinWorkClients";

const zoya = KinPersonId.make("zoya");
const names = { people: new Map([[zoya, "Zoya"]]), agents: new Map(), me: null, zone: "UTC" };
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const row = (key: string, name: string, more: Partial<KinPartyRow> = {}): KinPartyRow => ({
  recordId: KinRecordId.make(`r-${key}`),
  key: KinRecordKey.make(key),
  name,
  kind: "client",
  owner: { _tag: "person", personId: zoya },
  active: true,
  sensitive: false,
  weOwe: 0,
  theyOwe: 0,
  late: 0,
  overdue: 0,
  lastContactAt: null,
  next: null,
  rev: 1,
  ...more,
});

function setup(input: {
  readonly clients?: ReadonlyArray<KinPartyRow>;
  readonly page?: unknown;
  readonly sees?: boolean;
}) {
  state.clients = [...(input.clients ?? [])];
  state.page = input.page ?? null;
  state.filters = [];
  state.sees = input.sees ?? false;
  state.marketing = {
    tags: ["harbour", "clinics"],
    cameFrom: [
      { source: "campaign:P-3", label: "Harbour trade fair", campaign: true },
      { source: "Referral", label: "Referral", campaign: false },
    ],
  };
}

const clientsList = (onAdd: ((start: string) => void) | null = null) => (
  <AppAtomRegistryProvider>
    <KinWorkClientsList
      {...target}
      live={{ seq: 1 } as never}
      stale={false}
      directory={{ names } as never}
      onOpen={() => {}}
      onAdd={onAdd}
    />
  </AppAtomRegistryProvider>
);

describe("the Clients list", () => {
  it("marks a prospect, says when nothing is next, and keeps a late client's Late", async () => {
    setup({
      clients: [
        row("C-1", "Fennick & Daughters", { prospect: true, source: "Harbour trade fair" }),
        row("C-2", "Orbit Dental", {
          weOwe: 1,
          late: 1,
          next: {
            key: KinRecordKey.make("W-9"),
            title: "Reminder texts copy",
            dueAt: null,
            dueAllDay: true,
            late: true,
          },
        }),
      ],
    });
    await using _screen = await render(clientsList());
    const prospect = page.getByRole("button", { name: /^Fennick & Daughters/ });
    await expect
      .element(prospect.getByText("Prospect", { exact: true }))
      .toHaveClass(/text-primary/);
    expect(prospect.element().textContent).toContain("Prospect · Zoya");
    const none = prospect.getByText("No next step · from Harbour trade fair");
    await expect.element(none).toHaveClass(/text-warning-foreground/);
    const late = page.getByRole("button", { name: /^Orbit Dental/ });
    expect(late.element().textContent).toContain("Late: Reminder texts copy");
    await expect.element(late.getByText("Late", { exact: true })).toBeVisible();
    expect(late.getByText(/No next step/).elements()).toHaveLength(0);
  });

  it("filters by where they came from, a campaign among them, and by tag", async () => {
    setup({ clients: [row("C-1", "Brightwater Clinics", { prospect: true })], sees: true });
    await using _screen = await render(clientsList());
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("menuitem", { name: /^Came from/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /Harbour trade fair/ }));
    expect(state.filters.at(-1)).toMatchObject({ cameFrom: "campaign:P-3" });
    await userEvent.click(page.getByRole("button", { name: "Filter" }));
    await userEvent.click(page.getByRole("menuitem", { name: /^Tag/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "clinics" }));
    expect(state.filters.at(-1)).toMatchObject({ tag: "clinics" });
    await expect.element(page.getByRole("button", { name: "Export list" })).toBeVisible();
  });

  it("offers a prospect, not an import, when there are none yet", async () => {
    setup({});
    const onAdd = vi.fn();
    await using _screen = await render(clientsList(onAdd));
    await expect.element(page.getByText("No clients or prospects yet")).toBeVisible();
    expect(page.getByRole("button", { name: /Import/ }).elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Add a prospect" }));
    expect(onAdd).toHaveBeenCalledWith("prospect");
  });
});

const clientPage = (party: Partial<KinPartyPage["party"]>, can?: KinPartyPage["can"]) => ({
  party: {
    ...row("C-7", "Brightwater Clinics"),
    notes: "",
    terms: null,
    address: null,
    gstin: null,
    placeOfSupply: null,
    sensitiveFields: [],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    closedAt: null,
    seq: 1,
    ...party,
  },
  weOwe: { records: [], total: 0 },
  theyOwe: { records: [], total: 0 },
  projects: [],
  contacts: [],
  touches: [],
  seq: 1,
  ...(can === undefined ? {} : { can }),
});

const clientScreen = (onAddTask: (() => void) | null, onOpenTask = vi.fn()) => (
  <AppAtomRegistryProvider>
    <KinWorkClientPage
      {...target}
      clientKey={KinRecordKey.make("C-7")}
      directory={{ names } as never}
      changes={
        {
          state: { pending: {}, answers: {}, edit: null, notice: null },
          changes: { run: async () => {} },
        } as never
      }
      choices={{ clients: [], projects: [] } as never}
      canChangeTasks
      onOpenTask={onOpenTask}
      onOpenClient={() => {}}
      onOpenProject={() => {}}
      onOpenDoc={() => {}}
      onSeeAll={() => {}}
      onAddTask={onAddTask}
      onOpenList={() => {}}
    />
  </AppAtomRegistryProvider>
);

describe("a client's page", () => {
  it("opens a prospect on where it came from, who looks after it and that nothing is next", async () => {
    setup({ page: clientPage({ prospect: true, source: "Harbour trade fair" }) });
    const onAddTask = vi.fn();
    await using _screen = await render(clientScreen(onAddTask));
    await expect.element(page.getByText("Prospect · from Harbour trade fair")).toBeVisible();
    await expect.element(page.getByText(/^Looked after by\s*Zoya$/)).toBeVisible();
    await expect.element(page.getByText("No next step")).toHaveClass(/text-warning-foreground/);
    await userEvent.click(page.getByRole("button", { name: "Add one" }));
    expect(onAddTask).toHaveBeenCalledWith(
      expect.objectContaining({ party: { key: "C-7", title: "Brightwater Clinics" } }),
    );
  });

  it("shows the soonest thing owed as the next step, and opens it", async () => {
    const next = {
      key: KinRecordKey.make("W-44"),
      title: "Call Ingrid about the pilot",
      dueAt: null,
      dueAllDay: true,
      late: false,
    };
    setup({ page: clientPage({ next, weOwe: 1 }) });
    const onOpenTask = vi.fn();
    await using _screen = await render(clientScreen(null, onOpenTask));
    await userEvent.click(page.getByRole("button", { name: /^Call Ingrid about the pilot/ }));
    expect(onOpenTask).toHaveBeenCalledWith("W-44");
    expect(page.getByText("No next step").elements()).toHaveLength(0);
  });

  it("marks promises with where they were made, and puts the contract's dates under the name", async () => {
    const promise = (key: string, title: string, side: "ours" | "theirs", from?: object) => ({
      recordId: KinRecordId.make(`r-${key}`),
      orgId: target.orgId,
      key: KinRecordKey.make(key),
      title,
      state: "open",
      waitingOn: null,
      owner: { _tag: "person", personId: zoya },
      category: from === undefined ? "task" : "obligation",
      side,
      dueAt: null,
      dueAllDay: false,
      late: false,
      confirmed: true,
      sensitive: false,
      working: false,
      pullRequest: null,
      rev: 1,
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
      closedAt: null,
      ...(from === undefined ? {} : { from }),
    });
    setup({
      page: {
        ...clientPage({ weOwe: 2, theyOwe: 1 }),
        weOwe: {
          records: [
            promise("W-1", "Send the revised quote", "ours", {
              kind: "note",
              note: "At the site visit",
            }),
            promise("W-2", "Book the training day", "ours"),
          ],
          total: 2,
        },
        theyOwe: {
          records: [promise("W-3", "Signed order form", "theirs", { kind: "mail" })],
          total: 1,
        },
        contract: { project: "P-1", renewsOn: "2027-03-01", noticeBy: "2026-12-31", soon: true },
      },
    });
    await using _screen = await render(clientScreen(null));
    await expect
      .element(page.getByText("Renews 1 Mar · notice by 31 Dec"))
      .toHaveClass(/text-warning-foreground/);
    expect(page.getByText("Promised", { exact: true }).elements()).toHaveLength(2);
    await expect.element(page.getByText("At the site visit")).toBeVisible();
    await expect.element(page.getByText("From a mail")).toBeVisible();
  });

  it("has no contract line for a client with no renewal", async () => {
    setup({ page: clientPage({}) });
    await using _screen = await render(clientScreen(null));
    await expect.element(page.getByText("Brightwater Clinics").first()).toBeVisible();
    expect(page.getByText(/^Renews /).elements()).toHaveLength(0);
  });

  it("keeps terms, Keep private and closing from a teammate the host says may only edit", async () => {
    setup({
      page: clientPage(
        { prospect: true, notes: "Prefers mornings" },
        { edit: true, log: true, owner: false },
      ),
    });
    await using _screen = await render(clientScreen(null));
    await expect.element(page.getByRole("button", { name: "Edit" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "More" }));
    await expect.element(page.getByRole("menuitem", { name: "Make it a client" })).toBeVisible();
    expect(page.getByRole("menuitem", { name: "Close client" }).elements()).toHaveLength(0);
    expect(page.getByText("Keep private").elements()).toHaveLength(0);
    expect(page.getByText("Terms", { exact: true }).elements()).toHaveLength(0);
  });
});
