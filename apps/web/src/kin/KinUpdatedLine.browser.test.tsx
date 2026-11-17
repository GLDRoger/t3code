import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerWelcomeAtom } from "../state/server";
import { kinDraftAtom, restoreCarriedKinDrafts } from "./kinDraft";
import { reloadPage } from "./kinPageReload";
import { KinUpdatedLine } from "./KinUpdatedLine";

vi.mock("./kinPageReload", () => ({
  devBundle: false,
  pageBuild: () => "https://kin.example/assets/index-aaa.js",
  reloadPage: vi.fn(),
}));

vi.mock("../state/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/server")>()),
  primaryServerWelcomeAtom: Atom.make<unknown>(null).pipe(Atom.keepAlive),
}));

const DRAFT_KEY = "env-1:org-1:chat-1";

function setup() {
  vi.mocked(reloadPage).mockClear();
  window.sessionStorage.clear();
  appAtomRegistry.set(kinDraftAtom(DRAFT_KEY), "");
  appAtomRegistry.set(primaryServerWelcomeAtom as Atom.Writable<unknown>, null);
}

function Composer() {
  const atom = kinDraftAtom(DRAFT_KEY);
  const text = useAtomValue(atom);
  return (
    <textarea
      aria-label="Message Asha"
      value={text}
      onChange={(event) => appAtomRegistry.set(atom, event.target.value)}
    />
  );
}

describe("a tab older than its Kin host", () => {
  it("keeps typed text, shows one line, and carries the text through Reload", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinUpdatedLine />
        <Composer />
      </AppAtomRegistryProvider>,
    );
    const box = page.getByRole("textbox", { name: "Message Asha" });
    await userEvent.type(box, "Invoice is ready");

    // The server restarted on a newer build and the reconnect's welcome says so.
    appAtomRegistry.set(primaryServerWelcomeAtom as Atom.Writable<unknown>, {
      environment: { webBuild: "assets/index-bbb.js" },
    });

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Kin was updated. Reload to get the latest. Reload");
    await expect.element(box).toHaveValue("Invoice is ready");
    expect(reloadPage).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Reload" }));
    expect(reloadPage).toHaveBeenCalledOnce();

    // What the reloaded page finds on boot.
    appAtomRegistry.set(kinDraftAtom(DRAFT_KEY), "");
    restoreCarriedKinDrafts();
    expect(appAtomRegistry.get(kinDraftAtom(DRAFT_KEY))).toBe("Invoice is ready");
  });
});
