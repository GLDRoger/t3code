import { EnvironmentId, KinOrgId, KinRecordId, type KinRecordLink } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { KinWorkLinks } from "./KinWorkItemSheet";

const linkTo = (key: string, title: string): KinRecordLink => ({
  kind: "record",
  relation: "relates",
  target: `rec_${key}`,
  chatId: null,
  label: null,
  createdAt: "2026-11-18T09:00:00.000Z",
  record: { recordId: KinRecordId.make(`rec_${key}`), key, title },
});
const tasks = [2, 3, 4, 5, 6, 7].map((n) => linkTo(`W-${n}`, `Ambermill shelf ${n}`));

describe("a task's Linked section", () => {
  it("shows a doc linking to it, five tasks and 1 more, and opens an entry in place", async () => {
    const onOpenKey = vi.fn();
    await using screen = await render(
      <KinWorkLinks
        environmentId={EnvironmentId.make("env-1")}
        orgId={KinOrgId.make("org-1")}
        item={{
          key: "W-1",
          project: { recordId: KinRecordId.make("rec_P-4"), key: "P-4", title: "Ambermill shop" },
          links: tasks,
          linkedFrom: [linkTo("D-11", "Ambermill launch plan")],
        }}
        links={[]}
        title="Linked"
        onOpenKey={onOpenKey}
        onClose={() => {}}
      />,
    );
    await expect.element(screen.getByRole("button", { name: /D-11/ })).toBeVisible();
    await expect.element(screen.getByText("Ambermill launch plan")).toBeVisible();
    for (const n of [2, 3, 4, 5, 6])
      await expect.element(screen.getByText(`Ambermill shelf ${n}`)).toBeVisible();
    await expect.element(screen.getByText("Ambermill shelf 7")).not.toBeInTheDocument();
    // The panel's Details row shows the project already.
    await expect.element(screen.getByText("Ambermill shop")).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "1 more" }));

    await expect.element(screen.getByText("Ambermill shelf 7")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "1 more" })).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: /D-11/ }));
    expect(onOpenKey).toHaveBeenCalledWith("D-11");
  });
});
