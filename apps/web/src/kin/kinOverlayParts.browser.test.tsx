import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppRouteModal } from "../components/AppRouteModal";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { KIN_DIALOG_PARTS, useKinFormOpen } from "./kinOverlayParts";

/** True when a press at the element's centre lands on it, not on a layer in front of it. */
function onTop(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit !== null && element.contains(hit);
}

function AwayForm(props: { readonly onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogTitle>Away until</DialogTitle>
      </DialogPopup>
    </Dialog>
  );
}

function Detail(props: { readonly onRemove: () => void }) {
  const Parts = KIN_DIALOG_PARTS;
  const [away, setAway] = useKinFormOpen();
  return (
    <Parts.Root open>
      <Parts.Popup>
        <Parts.Header>
          <Parts.Title>Arjun Rao</Parts.Title>
          <Parts.Description>Joined</Parts.Description>
        </Parts.Header>
        <Button onClick={props.onRemove}>Remove access</Button>
        <Button onClick={() => setAway(true)}>Set away</Button>
        {away ? <AwayForm onClose={() => setAway(false)} /> : null}
      </Parts.Popup>
    </Parts.Root>
  );
}

describe("Kin details over Settings", () => {
  it("open in front of the Settings modal and take clicks", async () => {
    const onRemove = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <Detail onRemove={onRemove} />
      </AppRouteModal>,
      { router: "/kin?settings=team" },
    );

    const remove = page.getByRole("button", { name: "Remove access" });
    await expect.element(remove).toBeVisible();
    expect(onTop(remove.element() as HTMLElement)).toBe(true);
    await userEvent.click(remove);
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("show one sheet at a time: a form replaces its detail, and Back closes the form", async () => {
    await using screen = await render(
      <AppRouteModal label="Settings">
        <Detail onRemove={() => {}} />
      </AppRouteModal>,
      { router: "/kin?settings=team" },
    );
    screen.router!.history.push("/kin?settings=team&profile=p1");

    await userEvent.click(page.getByRole("button", { name: "Set away" }));
    await expect.element(page.getByText("Away until")).toBeVisible();
    await expect.element(page.getByText("Arjun Rao")).not.toBeVisible();

    screen.router!.history.back();
    await expect.element(page.getByText("Away until")).not.toBeInTheDocument();
    await expect.element(page.getByText("Arjun Rao")).toBeVisible();
  });
});
