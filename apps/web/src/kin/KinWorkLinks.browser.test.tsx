import {
  EnvironmentId,
  KinChatId,
  KinOrgId,
  KinRecordId,
  type KinRecordLink,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { KinLinkedGroups, KinWorkLinks } from "./KinWorkItemSheet";

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

    await userEvent.click(page.getByRole("button", { name: /W-7/ }));
    expect(onOpenKey).toHaveBeenCalledWith("W-7");
  });

  it("on a doc, shows a task linking to it and a doc it links to, and opens the task", async () => {
    const onOpen = vi.fn();
    await using screen = await render(
      <KinLinkedGroups
        item={{
          key: "D-11",
          links: [linkTo("D-12", "Ambermill price list")],
          linkedFrom: [linkTo("W-2", "Send Ambermill the quote")],
        }}
        title="Linked"
        parentsShown
        onOpen={onOpen}
      />,
    );
    await expect.element(screen.getByText("Tasks")).toBeVisible();
    await expect.element(screen.getByText("Docs")).toBeVisible();
    await expect.element(screen.getByText("Ambermill price list")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: /W-2/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "W-2", kind: "task" }));
  });

  it("on a doc a member reads, tells the chat they aren't in, and opens only the one they are", async () => {
    const onOpen = vi.fn();
    const source = (target: string, rest: Partial<KinRecordLink>): KinRecordLink => ({
      kind: "message",
      relation: "source",
      target,
      chatId: null,
      label: null,
      createdAt: "2026-11-18T09:00:00.000Z",
      ...rest,
    });
    await using screen = await render(
      <KinLinkedGroups
        item={{
          key: "D-11",
          links: [
            source("msg-rhea", { closedChat: { agent: "Chief of staff" } }),
            source("msg-dev", { chatId: KinChatId.make("chat-dev"), label: "Dev asked here" }),
          ],
        }}
        title="Linked"
        parentsShown
        onOpen={onOpen}
      />,
    );
    const told = screen.getByText("Where this came from: a chat with Chief of staff");
    await expect.element(told).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /Chief of staff/ }))
      .not.toBeInTheDocument();
    await userEvent.click(told);
    expect(onOpen).not.toHaveBeenCalled();

    await userEvent.click(page.getByRole("button", { name: "Dev asked here" }));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "chat", chatId: "chat-dev" }),
    );
  });
});
