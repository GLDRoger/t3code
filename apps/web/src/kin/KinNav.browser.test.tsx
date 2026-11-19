import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const target = {
  environmentId: EnvironmentId.make("env-ambermill"),
  orgId: KinOrgId.make("org-1"),
};

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ ...target, lead: null }),
}));
vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinTasksNeedsYou"), () => ({ useKinTasksNeedsYou: () => 3 }));
vi.mock(import("./kinListSwitch"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinInboxUnreadAtom: Atom.family((_: EnvironmentId) => Atom.make(2)),
}));

import "~/index.css";
import { render } from "../../test/render";
import { Sidebar, SidebarProvider, SidebarTrigger } from "../components/ui/sidebar";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { registerKinListCommands } from "./kinListSwitch";
import { KinNav } from "./KinNav";

const placesPath = (place: string) => `/kin/${target.environmentId}/${target.orgId}/${place}`;

describe("KinNav in a narrow window", () => {
  it("is the sidebar sheet's places, and ⌘1 to ⌘5 still reach them while it is closed", async () => {
    await page.viewport(390, 844);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <Sidebar>
            <KinNav />
          </Sidebar>
          <SidebarTrigger />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
      { router: placesPath("money") },
    );
    using _commands = {
      [Symbol.dispose]: registerKinListCommands(screen.router!, appAtomRegistry),
    };
    const pathname = () => screen.router!.state.location.pathname;
    const sheet = () => document.querySelector('[data-mobile="true"][data-sidebar="sidebar"]');
    // Closed, the sheet stays mounted but hidden, out of the accessibility tree.
    const sheetShown = () => sheet()?.checkVisibility() ?? false;

    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const nav = page.getByRole("navigation", { name: "Kin" });
    await expect.element(nav).toBeVisible();
    expect(sheet()?.contains(nav.element())).toBe(true);
    expect(document.querySelectorAll('nav[aria-label="Kin"]')).toHaveLength(1);
    expect(
      [...nav.element().querySelectorAll("[data-kin-destination]")].map((link) =>
        link.getAttribute("data-kin-destination"),
      ),
    ).toEqual(["chats", "tasks", "money", "clients", "docs"]);
    await expect.element(nav.getByLabelText("2 unread")).toBeVisible();
    await expect.element(nav.getByLabelText("3 need you")).toBeVisible();

    await userEvent.click(nav.getByRole("link", { name: /Tasks/ }));
    await vi.waitFor(() => expect(pathname()).toBe(placesPath("tasks")));
    await vi.waitFor(() => expect(sheetShown()).toBe(false));

    await userEvent.keyboard("{Meta>}{Control>}5{/Control}{/Meta}");
    await vi.waitFor(() => expect(pathname()).toBe(placesPath("docs")));
    await vi.waitFor(() => expect(sheetShown()).toBe(false));
  });
});
