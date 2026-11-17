import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppRouteModal } from "../components/AppRouteModal";
import { Button } from "../components/ui/button";
import { KIN_DIALOG_PARTS } from "./kinOverlayParts";

/** True when a press at the element's centre lands on it, not on a layer in front of it. */
function onTop(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return hit !== null && element.contains(hit);
}

function Detail(props: { readonly onRemove: () => void }) {
  const Parts = KIN_DIALOG_PARTS;
  return (
    <Parts.Root open>
      <Parts.Popup>
        <Parts.Header>
          <Parts.Title>Arjun Rao</Parts.Title>
          <Parts.Description>Joined</Parts.Description>
        </Parts.Header>
        <Button onClick={props.onRemove}>Remove access</Button>
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
});
