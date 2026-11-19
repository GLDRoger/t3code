import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinRecordId,
  KinRecordKey,
  type KinDocListRow,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  rows: [] as Array<unknown>,
  pinned: null as unknown,
  start: null as null | ((draft: string) => Promise<boolean>),
}));

vi.mock(import("./useKinDocs"), async (importOriginal) => {
  const { KIN_DOCS_DEFAULT_FILTER, KIN_SEARCH_INITIAL } =
    await import("@t3tools/client-runtime/kin/kinDocs");
  return {
    ...(await importOriginal()),
    useKinDocsLive: (() => ({ refused: false, live: { seq: 1 } })) as never,
    useKinDocsList: (() => ({
      state: {
        filter: KIN_DOCS_DEFAULT_FILTER,
        records: state.rows,
        total: state.rows.length,
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
    useKinSearch: (() => ({
      state: KIN_SEARCH_INITIAL,
      search: { setText: () => {}, setClosed: () => {}, retry: () => {} },
    })) as never,
    useKinWhatWeSell: (() => state.pinned) as never,
    useKinWhatWeSellStart: (() =>
      state.start === null ? null : { agent: "Growth", start: state.start }) as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinDocsList } from "./KinDocsList";

const growth = KinAgentId.make("growth");
const at = "2026-11-18T10:00:00.000Z";
const doc = (key: string, title: string, patch: Partial<KinDocListRow> = {}) =>
  ({
    recordId: KinRecordId.make(`r-${key}`),
    key: KinRecordKey.make(key),
    title,
    owner: { _tag: "agent", agentId: growth },
    company: true,
    sensitive: false,
    archived: false,
    bodyKind: "markdown",
    latest: {
      version: 2,
      at,
      kind: "edited",
      summary: "Added the single-site start",
      provenance: { by: { _tag: "agent", agentId: growth } },
    },
    createdAt: at,
    updatedAt: at,
    rev: 1,
    ...patch,
  }) satisfies KinDocListRow;

function setup(options: {
  readonly rows: ReadonlyArray<KinDocListRow>;
  readonly pinned: KinDocListRow | null;
  readonly start?: (draft: string) => Promise<boolean>;
}) {
  state.rows = [...options.rows];
  state.pinned = options.pinned;
  state.start = options.start ?? null;
}

const list = () => (
  <AppAtomRegistryProvider>
    <KinDocsList
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("org-1")}
      directory={
        {
          names: { people: new Map(), agents: new Map([[growth, "Growth"]]), me: null, zone: null },
        } as never
      }
      stale={false}
      onOpen={() => {}}
      lists={null}
      onOpenList={() => {}}
      onAsk={null}
    />
  </AppAtomRegistryProvider>
);

describe("Docs, Company", () => {
  it("pins What we sell first, reading like any doc, though the page read before it holds others", async () => {
    setup({
      rows: [
        doc("D-2", "Brand notes", { updatedAt: "2026-11-19T10:00:00.000Z" }),
        doc("D-3", "Office rules", { updatedAt: "2026-11-20T10:00:00.000Z" }),
      ],
      pinned: doc("D-1", "What we sell", { whatWeSell: true }),
    });
    await using _screen = await render(list());
    const rows = page.getByRole("button", { name: /^(What we sell|Brand notes|Office rules)\./ });
    await expect
      .element(rows.first())
      .toHaveAccessibleName(
        /^What we sell\. Pinned\. Company\. Updated .* by Growth · Added the single-site start$/,
      );
    expect(rows.elements().map((row) => row.getAttribute("aria-label")?.split(".")[0])).toEqual([
      "What we sell",
      "Office rules",
      "Brand notes",
    ]);
    await expect.element(page.getByText(/offerings?$/)).not.toBeInTheDocument();
    await expect.element(page.getByText("Pinned")).toBeVisible();
    await expect.element(page.getByText("Tell Kin what you sell")).not.toBeInTheDocument();
  });

  it("offers three ways in when nobody has written it, each starting it with its first words", async () => {
    const start = vi.fn(async (_draft: string) => true);
    setup({ rows: [doc("D-2", "Brand notes")], pinned: null, start });
    await using _screen = await render(list());
    await expect
      .element(page.getByRole("region", { name: "Tell Kin what you sell" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Send your website" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Send a brochure or price list" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Tell Growth about it" }));
    expect(start).toHaveBeenCalledWith(
      "Let's write What we sell together. Ask me what you need, one question at a time.",
    );
  });

  it("shows a teammate no way in to start it", async () => {
    setup({ rows: [doc("D-2", "Brand notes")], pinned: null });
    await using _screen = await render(list());
    await expect.element(page.getByRole("button", { name: /^Brand notes\./ })).toBeVisible();
    await expect.element(page.getByText("Tell Kin what you sell")).not.toBeInTheDocument();
  });
});
