import { EnvironmentId, KinOrgId, KinRecordId, KinRecordKey } from "@t3tools/contracts";
import type { KinSearchState } from "@t3tools/client-runtime/kin/kinDocs";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({ search: null as unknown }));

vi.mock(import("./useKinDocs"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinSearch: (() => ({
    state: state.search,
    search: { setText: () => {}, setClosed: () => {}, retry: () => {} },
  })) as never,
}));
vi.mock(import("./useKinShell"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinShell: (() => null) as never,
}));
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => {
  const { KIN_SCOPE_ALL } = await import("@t3tools/client-runtime/kin/kinViewerScope");
  return { ...(await importOriginal()), useKinViewerScope: (() => KIN_SCOPE_ALL) as never };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinSearchDialog } from "./KinSearchDialog";

const at = "2026-11-18T10:00:00.000Z";

function setup(search: Partial<KinSearchState>) {
  state.search = {
    text: "",
    closed: false,
    hits: null,
    answered: "",
    loading: false,
    failed: null,
    ...search,
  } satisfies KinSearchState;
}

const dialog = () => (
  <AppAtomRegistryProvider>
    <KinSearchDialog
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("org-1")}
      onOpen={() => {}}
      onClose={() => {}}
    />
  </AppAtomRegistryProvider>
);

describe("KinSearchDialog", () => {
  it("says before anything is typed that an identifier finds a record", async () => {
    setup({});
    await using screen = await render(dialog());
    await expect
      .element(screen.getByText(/by any words in them or an identifier like W-12\.$/))
      .toBeVisible();
  });

  it("shows each result's identifier beside its kind and state", async () => {
    setup({
      text: "w12",
      answered: "w12",
      hits: [
        {
          recordId: KinRecordId.make("r-w12"),
          key: KinRecordKey.make("W-12"),
          kind: "work",
          title: "Fix the tins",
          snippet: "Fix the tins",
          sensitive: false,
          closed: true,
          updatedAt: at,
        },
      ],
    });
    await using _screen = await render(dialog());
    const row = page.getByRole("button", { name: "Task: Fix the tins. W-12. Closed" });
    await expect.element(row).toBeVisible();
    await expect.element(row.getByText("Task · W-12", { exact: true })).toBeVisible();
  });
});
