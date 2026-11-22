import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { useComposerDraftStore } from "../composerDraftStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { useKinComposerAttachments } from "./KinComposerAttachments";
import { kinAttachmentTarget, kinDraftAtom, restoreCarriedKinDrafts } from "./kinDraft";
import { reloadPage, serverBuildAtom } from "./kinPageBuild";
import { KinUpdatedLine } from "./KinUpdatedLine";

vi.mock("./kinPageBuild", () => ({
  devBundle: false,
  pageBuild: () => "https://kin.example/assets/index-aaa.js",
  serverBuildAtom: Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive),
  reloadPage: vi.fn(),
}));

const DRAFT_KEY = "env-1:org-1:chat-1";

function setup() {
  vi.mocked(reloadPage).mockClear();
  window.sessionStorage.clear();
  appAtomRegistry.set(kinDraftAtom(DRAFT_KEY), "");
  appAtomRegistry.set(serverBuildAtom as Atom.Writable<string | undefined>, undefined);
  useComposerDraftStore.getState().clearComposerContent(kinAttachmentTarget(DRAFT_KEY));
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

    // The server restarted on a newer build and the reconnect's config snapshot says so.
    appAtomRegistry.set(
      serverBuildAtom as Atom.Writable<string | undefined>,
      "assets/index-bbb.js",
    );

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

  it("waits for a draft that holds only a picture, and keeps the picture for the reload", async () => {
    setup();
    function Pictures() {
      useKinComposerAttachments({ environmentId: EnvironmentId.make("env-1"), draftKey: DRAFT_KEY });
      return null;
    }
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinUpdatedLine />
        <Pictures />
      </AppAtomRegistryProvider>,
    );
    const target = kinAttachmentTarget(DRAFT_KEY);
    const file = new File([new Uint8Array([1, 2, 3])], "receipt.png", { type: "image/png" });
    useComposerDraftStore.getState().addImages(target, [
      {
        type: "image",
        id: "receipt",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
        file,
      },
    ]);

    appAtomRegistry.set(
      serverBuildAtom as Atom.Writable<string | undefined>,
      "assets/index-bbb.js",
    );

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Kin was updated. Reload to get the latest. Reload");
    expect(reloadPage).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        useComposerDraftStore
          .getState()
          .getComposerDraft(target)
          ?.persistedAttachments.map((attachment) => attachment.id),
      ).toEqual(["receipt"]),
    );
  });
});
