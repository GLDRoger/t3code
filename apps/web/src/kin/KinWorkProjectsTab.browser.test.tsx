import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinProjectRow,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ projects: [] as Array<unknown> }));

vi.mock(import("./useKinWork"), async (importOriginal) => {
  const { KIN_PROJECTS_DEFAULT_FILTER } =
    await import("@t3tools/client-runtime/kin/kinWorkClients");
  return {
    ...(await importOriginal()),
    useKinProjectsList: (() => ({
      state: {
        filter: KIN_PROJECTS_DEFAULT_FILTER,
        records: state.projects,
        total: state.projects.length,
        more: false,
        seq: 1,
        loading: false,
        failed: null,
        refreshing: false,
        loadingMore: false,
        moreFailed: false,
        stale: false,
      },
      list: { setFilter: () => {}, refresh: () => {}, loadMore: async () => {} },
    })) as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinWorkProjectsTab } from "./KinWorkClients";

const meera = KinPersonId.make("meera");
const project = (key: string, name: string, party: readonly [string, string] | null) =>
  ({
    recordId: KinRecordId.make(`r-${key}`),
    key: KinRecordKey.make(key),
    name,
    party:
      party === null
        ? null
        : {
            recordId: KinRecordId.make(`r-${party[0]}`),
            key: KinRecordKey.make(party[0]),
            title: party[1],
          },
    owner: { _tag: "person", personId: meera },
    state: "open",
    targetAt: null,
    targetAllDay: true,
    open: 6,
    late: 0,
    health: "on_track",
    sensitive: false,
    sensitiveInherited: false,
    rev: 1,
  }) satisfies KinProjectRow;

function setup(projects: ReadonlyArray<KinProjectRow>) {
  state.projects = [...projects];
}

describe("the Projects tab", () => {
  it("lists projects under their client, then those not for a client, and a row opens its project", async () => {
    setup([
      project("P-1", "Shopfront refresh", ["C-1", "Pinecrest"]),
      project("P-2", "Stock audit", ["C-2", "Ambermill Foods"]),
      project("P-3", "Office move", null),
    ]);
    const onOpenProject = vi.fn();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinWorkProjectsTab
          environmentId={EnvironmentId.make("env-1")}
          orgId={KinOrgId.make("org-1")}
          live={{ seq: 1 } as never}
          stale={false}
          directory={
            {
              names: {
                people: new Map([[meera, "Meera"]]),
                agents: new Map(),
                me: null,
                zone: null,
              },
            } as never
          }
          onOpenClient={() => {}}
          onOpenProject={onOpenProject}
          onAdd={null}
        />
      </AppAtomRegistryProvider>,
    );
    const headings = page.getByRole("heading", { level: 2 });
    await expect.element(headings.nth(2)).toHaveTextContent("Not for a client");
    expect(headings.elements().map((heading) => heading.textContent)).toEqual([
      "Ambermill Foods",
      "Pinecrest",
      "Not for a client",
    ]);
    await expect.element(page.getByText("Meera · 6 open").first()).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /^Office move/ }));
    expect(onOpenProject).toHaveBeenCalledWith("P-3");
  });
});
