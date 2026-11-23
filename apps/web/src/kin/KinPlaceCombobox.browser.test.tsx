import {
  EnvironmentId,
  KinListId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  type KinListDefinition,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// What the host was asked by name, and every filter the list was given.
const host = vi.hoisted(() => ({
  searched: [] as Array<string>,
  filters: [] as Array<{ readonly party: unknown; readonly noParty: boolean }>,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (answer: (input: unknown) => unknown) => ({
    label: "test",
    permissionAtom: () => allowed,
    run: async (_registry: unknown, { input }: { readonly input: unknown }) => answer(input),
  });
  const named = (input: unknown, rows: ReadonlyArray<readonly [string, string]>) => {
    const text = (input as { readonly text: string }).text.toLowerCase();
    host.searched.push(text);
    return rows
      .filter(([, name]) => name.toLowerCase().includes(text))
      .map(([key, name]) => ({ key, name }));
  };
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      // Past the first page each picker holds: only the host's search finds these.
      workClients: command((input) => {
        const parties = named(input, [
          ["C-1", "Orbit Dental"],
          ["C-120", "Zephyr Kitchens"],
        ]);
        return AsyncResult.success({ parties, total: parties.length, nextCursor: null, seq: 1 });
      }),
      workProjects: command((input) => {
        const projects = named(input, [
          ["P-1", "Bakery refit"],
          ["P-140", "Zephyr kitchen audit"],
        ]);
        return AsyncResult.success({ projects, total: projects.length, nextCursor: null, seq: 1 });
      }),
    } as never,
  };
});

vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWorkChoices: (() => ({
    clients: [{ key: "C-1", title: "Orbit Dental" }],
    projects: [{ key: "P-1", title: "Bakery refit" }],
    doneProjects: [],
    projectClients: new Map(),
  })) as never,
}));

vi.mock(import("./useKinMoney"), async (importOriginal) => {
  const { useState } = await import("react");
  return {
    ...(await importOriginal()),
    useKinLists: (() => ({
      state: { _tag: "ready", value: { lists: [jobs] } },
      refresh: () => {},
    })) as never,
    useKinListContext: (() => ({ names: names(), refs: new Map(), now: new Date(0) })) as never,
    useKinListEntries: ((_target: unknown, _list: unknown, initial: KinListFilter) => {
      const [filter, setFilter] = useState(initial);
      return {
        state: {
          filter,
          records: [],
          total: 0,
          more: false,
          seq: 1,
          loading: false,
          failed: null,
          refreshing: false,
          loadingMore: false,
          moreFailed: false,
          stale: false,
        },
        entries: {
          setFilter: (next: KinListFilter) => {
            host.filters.push(next);
            setFilter(next);
          },
          refresh: () => {},
          loadMore: async () => {},
        },
        totals: null,
      };
    }) as never,
  };
});

import { KIN_LIST_DEFAULT_FILTER, type KinListFilter } from "@t3tools/client-runtime/kin/kinLists";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinBudgetDialog } from "./KinMoneyAnswers";
import { KinProjectDialog } from "./KinWorkForms";
import { KinTaskPlaceMenu } from "./KinWorkItemSheet";
import { KinWorkListPage } from "./KinWorkLists";

// Ambermill, invented: owner Rhea.
const rhea = KinPersonId.make("ambermill-rhea");
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("ambermill") };
const names = () => ({
  people: new Map([[rhea, "Rhea"]]),
  agents: new Map(),
  me: rhea,
  zone: "UTC",
});
const jobs = {
  list: KinListId.make("jobs"),
  name: "Jobs",
  prefix: "JOB",
  builtIn: false,
  states: ["open", "done", "dropped"],
  stateLabels: {},
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: false,
  amount: false,
  currency: "INR",
  archivedAt: null,
  rev: 1,
  open: 0,
} as unknown as KinListDefinition;

function setup() {
  host.searched = [];
  host.filters = [];
}

describe("A picker past the first page", () => {
  it("files a new project under a client only the host's search finds", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinProjectDialog
          {...target}
          editing={null}
          party={null}
          choices={{
            clients: [{ key: KinRecordKey.make("C-1"), title: "Orbit Dental" }],
            projects: [],
            doneProjects: [],
            projectClients: new Map(),
          }}
          onSaved={() => {}}
          onOpenExisting={() => {}}
          onClose={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    const client = page.getByRole("combobox", { name: "Client" });
    await userEvent.click(client);
    await userEvent.keyboard("zephyr");
    await userEvent.click(page.getByRole("option", { name: "Zephyr Kitchens" }));
    expect(host.searched).toEqual(["zephyr"]);
    await expect.element(client).toHaveValue("Zephyr Kitchens");
  });

  it("filters a list to a client only the host's search finds, and to no client", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinWorkListPage
          {...target}
          list={jobs.list}
          live={{ seq: 1 } as never}
          stale={false}
          directory={{ names: names() } as never}
          initial={KIN_LIST_DEFAULT_FILTER}
          openKey={null}
          onOpenKey={() => {}}
          onGone={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    const client = page.getByRole("combobox", { name: "Client" });
    await userEvent.click(client);
    await userEvent.keyboard("zephyr");
    await userEvent.click(page.getByRole("option", { name: "Zephyr Kitchens" }));
    await expect.element(client).toHaveValue("Zephyr Kitchens");
    expect(host.filters.at(-1)).toMatchObject({
      party: { key: "C-120", title: "Zephyr Kitchens" },
      noParty: false,
    });
    await userEvent.click(client);
    await userEvent.click(page.getByRole("option", { name: "No client" }));
    await expect.element(client).toHaveValue("No client");
    expect(host.filters.at(-1)).toMatchObject({ party: null, noParty: true });
    // Every client again is a row of its own, not only the clear button.
    await userEvent.click(client);
    await userEvent.click(page.getByRole("option", { name: "Any client" }));
    expect(host.filters.at(-1)).toMatchObject({ party: null, noParty: false });
  });

  it("sets a budget on a project only the host's search finds", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinBudgetDialog
          {...target}
          seq={null}
          rates={null}
          expenses={null}
          budget={null}
          onClose={() => {}}
        />
      </AppAtomRegistryProvider>,
    );
    const project = page.getByRole("combobox", { name: "Project" });
    await userEvent.click(project);
    await userEvent.keyboard("zephyr");
    await userEvent.click(page.getByRole("option", { name: "Zephyr kitchen audit" }));
    expect(host.searched).toEqual(["zephyr"]);
    await expect.element(project).toHaveValue("Zephyr kitchen audit");
    await userEvent.click(project);
    await userEvent.click(page.getByRole("option", { name: "Every project" }));
    await expect.element(project).toHaveValue("");
  });

  it("moves an existing task to a client found by typing, from the keyboard", async () => {
    setup();
    const picked: Array<unknown> = [];
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinTaskPlaceMenu
          target={target}
          noun="client"
          label="Client"
          value={{ key: KinRecordKey.make("C-1"), title: "Orbit Dental" }}
          choices={[{ key: KinRecordKey.make("C-1"), title: "Orbit Dental" }]}
          saving={false}
          onPick={(value) => picked.push(value)}
          onOpen={null}
        />
      </AppAtomRegistryProvider>,
    );
    const menu = page.getByRole("button", { name: "Client: Orbit Dental. Change" });
    await userEvent.click(menu);
    const find = page.getByRole("textbox", { name: "Find a client" });
    await expect.element(find).toHaveFocus();
    await userEvent.keyboard("zzzwombat");
    await expect.element(page.getByText("No client named “zzzwombat”")).toBeVisible();
    await userEvent.clear(find);
    await userEvent.keyboard("zephyr");
    await expect.element(page.getByRole("menuitem", { name: "Zephyr Kitchens" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual([{ key: "C-120", title: "Zephyr Kitchens" }]);
    await expect.element(find).not.toBeInTheDocument();

    await userEvent.click(menu);
    await userEvent.keyboard("zephyr");
    await expect.element(page.getByRole("menuitem", { name: "Zephyr Kitchens" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(picked).toHaveLength(2);
    await userEvent.click(menu);
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("textbox", { name: "Find a client" }))
      .not.toBeInTheDocument();
  });
});
