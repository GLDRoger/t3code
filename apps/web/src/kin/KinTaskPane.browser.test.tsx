import { EnvironmentId, KinOrgId, KinPersonId, KinRecordKey } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("./useKinWork"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinWork: (() => ({ _tag: "ready", live: { seq: 1, summary: null }, stale: false })) as never,
  useKinWorkDirectory: (() => ({
    names: {
      people: new Map([["rhea", "Rhea"]]),
      agents: new Map(),
      me: KinPersonId.make("rhea"),
      zone: null,
    },
  })) as never,
  useKinWorkItemWatch: () => {},
}));
vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAskAgent: () => null,
  useKinLists: (() => ({ state: { _tag: "loading" } })) as never,
}));
// The list's own reads are its tests'; here it is two rows that open their task.
vi.mock(import("./KinWorkTasks"), async (importOriginal) => {
  const real = await importOriginal();
  const row = (key: string, title: string) =>
    ({
      key,
      title,
      state: "open",
      tick: null,
      suggested: false,
      accessibilityLabel: title,
      ownerAvatar: { kind: "person", seed: "rhea" },
      holder: "You",
      detail: "",
      markText: null,
      mark: null,
    }) as never;
  return {
    ...real,
    KinWorkTaskList: ((props: {
      readonly openKey: string | null;
      readonly onOpen: (key: string) => void;
    }) => (
      <ul>
        {[row("T-12", "Send the Pinecrest quote"), row("T-13", "Book the Ambermill van")].map(
          (held: { readonly key: string }) => (
            <li key={held.key}>
              <real.KinWorkRow
                row={held as never}
                saving={false}
                selected={props.openKey === held.key}
                onOpen={() => props.onOpen(held.key)}
                onAct={null}
              />
            </li>
          ),
        )}
      </ul>
    )) as never,
  };
});

import { useState } from "react";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinPlaceView } from "./KinPlaceView";

function Tasks() {
  const [openKey, setOpenKey] = useState<KinRecordKey | null>(null);
  return (
    <KinPlaceView
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("org-1")}
      place="tasks"
      tab="clients"
      onTab={() => {}}
      record={null}
      onGo={() => {}}
      openKey={openKey}
      onOpenKey={setOpenKey}
      dialog={null}
      onDialog={() => {}}
      docLink={() => ""}
      onLeave={() => {}}
    />
  );
}

describe("a task on a wide window", () => {
  it("opens in the pane beside its list, and closing it hands focus back to its row", async () => {
    await page.viewport(1440, 900);
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <Tasks />
      </AppAtomRegistryProvider>,
      { router: "/kin/env-1/org-1/tasks" },
    );
    const row = page.getByRole("button", { name: "Send the Pinecrest quote" });
    await userEvent.click(row);

    const pane = page.getByRole("region", { name: "T-12" });
    await expect.element(pane).toHaveFocus();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Book the Ambermill van" }))
      .toBeVisible();
    await expect.element(row).toHaveAttribute("aria-current", "true");

    await userEvent.click(page.getByRole("button", { name: "Close task" }));
    await expect.element(pane).not.toBeInTheDocument();
    await expect.element(row).toHaveFocus();

    await userEvent.click(row);
    await expect.element(pane).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(pane).not.toBeInTheDocument();
    await expect.element(row).toHaveFocus();
  });
});
