import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinDocDetail,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  doc: null as KinDocDetail | null,
}));

vi.mock(import("./useKinDocs"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinDoc: (() => ({
    state: { _tag: "ready", value: state.doc, stale: false },
    refresh: () => {},
  })) as never,
  useKinDocAsk: () => null,
  useKinDocHistory: (() => ({
    state: { loading: false, failed: null, records: [], more: false },
    list: { refresh: () => {}, loadMore: async () => {} },
  })) as never,
}));
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: () => true,
}));
vi.mock(import("./useKinDocDelete"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinDocDelete: (() => ({
    allowed: false,
    busy: null,
    remove: async () => null,
    restore: async () => null,
  })) as never,
}));
vi.mock(import("./useKinShell"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinShell: () => null,
}));
vi.mock(import("./KinWatchLine"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinWatchLine: () => null,
}));
vi.mock(import("./KinWorkShareRow"), async (importOriginal) => ({
  ...(await importOriginal()),
  KinWorkShareRow: () => null,
}));
vi.mock(import("./KinConfirm"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinDocLabel: () => ({
    action: null,
    ask: () => {},
    dialog: <></>,
    problem: null,
    dismiss: () => {},
  }),
}));
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinHostConnected: () => true,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const { commandRun } = await import("../../test/commandRun");
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const allowed = Atom.make(false);
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      docRestore: {
        label: "test:docRestore",
        permissionAtom: () => allowed,
        run: commandRun(async () => AsyncResult.success({})),
      },
      docRender: {
        label: "test:docRender",
        permissionAtom: () => allowed,
        run: commandRun(async () => AsyncResult.success({ documents: [] })),
      },
      docFile: {
        label: "test:docFile",
        permissionAtom: () => allowed,
        run: commandRun(async () => AsyncResult.success({})),
      },
      workLooked: {
        label: "test:workLooked",
        permissionAtom: () => allowed,
        run: commandRun(async () => AsyncResult.success({})),
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinDocPage } from "./KinDocPage";
import { scrollIntoViewRespectingMotion } from "./KinSinceLookedLine";

const box = (tag: string, css: string) => {
  const element = document.createElement(tag);
  element.style.cssText = css;
  return element;
};

const mounted = (element: HTMLElement) => {
  document.body.append(element);
  return { [Symbol.dispose]: () => element.remove() };
};

describe("scrollIntoViewRespectingMotion", () => {
  it("moves only the section's own scroller, never the clipped page around it", () => {
    using _reduced = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    // The app shell: a clipped frame whose content runs past it, holding the sheet's scroller.
    const frame = box("main", "height: 300px; overflow: hidden");
    const scroller = box("div", "height: 300px; overflow-y: auto");
    // The section sits near the scroller's end, so the scroller alone can't bring it to the top.
    const section = box("section", "height: 100px");
    scroller.append(box("div", "height: 500px"), section);
    frame.append(scroller, box("div", "height: 200px"));
    using _frame = mounted(frame);

    scrollIntoViewRespectingMotion(section);

    expect(scroller.scrollTop).toBe(300);
    expect(frame.scrollTop).toBe(0);
  });
});

describe("KinDocPage since-looked line", () => {
  it("does not draw the since-looked line when the single change is the version Updated already names", async () => {
    const meeraId = KinPersonId.make("meera");
    const rheaId = KinPersonId.make("rhea");
    const meera = { _tag: "person", personId: meeraId } as const;
    const v2 = {
      version: 2,
      at: "2026-11-27T14:24:00.000Z",
      kind: "edited" as const,
      summary: 'Changed "When this applies" by hand',
      provenance: { by: meera },
    };
    state.doc = {
      recordId: KinRecordId.make("rec-d3"),
      key: KinRecordKey.make("D-3"),
      title: "Reviewing and merging code",
      owner: meera,
      kind: "playbook",
      sensitive: false,
      archived: false,
      bodyKind: "markdown",
      latest: { ...v2, bodyKind: "markdown" },
      version: { ...v2, bodyKind: "markdown" },
      lookedAt: "2026-11-27T10:00:00.000Z",
      sinceLooked: { total: 1, from: 1, versions: [v2] },
      body: "## When this applies\n\nEvery merge.",
      outline: [{ id: "when", level: 2, title: "When this applies" }],
      links: [],
      seq: 2,
    } as unknown as KinDocDetail;

    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinDocPage
          environmentId={EnvironmentId.make("env-1")}
          orgId={KinOrgId.make("tidewater")}
          where={{ doc: KinRecordKey.make("D-3") }}
          directory={
            {
              names: {
                people: new Map([
                  [rheaId, "Rhea"],
                  [meeraId, "Meera"],
                ]),
                agents: new Map(),
                me: rheaId,
                owner: rheaId,
                zone: "UTC",
                readerZone: "UTC",
              },
            } as never
          }
          onGo={() => {}}
          linkTo={() => ""}
          placeTitle="Docs"
          inPane={false}
          onOpenKey={() => {}}
          onOpenClient={() => {}}
          onOpenProject={() => {}}
        />
      </AppAtomRegistryProvider>,
      { router: "/kin/env-1/tidewater/docs/D-3" },
    );

    await expect.element(page.getByText(/Updated .* by Meera/)).toBeVisible();
    expect(document.querySelector('[data-slot="kin-since-looked"]')).toBeNull();
  });
});
