import { useAtomValue } from "@effect/atom-react";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import { EnvironmentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const target = {
  environmentId: EnvironmentId.make("env-ambermill"),
  orgId: KinOrgId.make("org-1"),
};

const hostWith = (connected: boolean): KinHost => ({
  _tag: "host",
  environmentId: target.environmentId,
  connected,
  probe: {
    _tag: "ready",
    orgs: { orgs: [], me: [{ orgId: target.orgId, personId: KinPersonId.make("person-rhea") }] },
  },
});

vi.mock(import("./useKinPlaces"), () => ({
  useKinDestinations: (() => ({
    destinations: ["chats", "tasks", "money", "clients", "docs"],
    known: true,
  })) as never,
}));
vi.mock(import("./useKinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinTasksNeedsYou: () => 3,
}));
// The host the nav is drawn for; each test's setup() says whether it is connected.
vi.mock(import("./useKinHost"), async (importOriginal) => {
  const host = Atom.make<KinHost>({ _tag: "searching" }).pipe(Atom.keepAlive);
  return { ...(await importOriginal()), kinHostAtom: host, useKinHost: () => useAtomValue(host) };
});
vi.mock(import("./kinPlacesAtom"), async (importOriginal) => {
  const places = Atom.make({
    destinations: ["chats", "tasks", "money", "clients", "docs"] as const,
    answered: true,
  });
  return { ...(await importOriginal()), kinPlacesAtom: () => places };
});
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
import { kinHostAtom } from "./useKinHost";

const setup = (connected: boolean) =>
  appAtomRegistry.set(kinHostAtom as Atom.Writable<KinHost>, hostWith(connected));

const placesPath = (place: string) => `/kin/${target.environmentId}/${target.orgId}/${place}`;

describe("KinNav in a narrow window", () => {
  it("is the sidebar sheet's places, and ⌘1 to ⌘5 still reach them while it is closed", async () => {
    setup(true);
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

  it("keeps the places and the last Tasks count while the host is offline", async () => {
    setup(false);
    await using screen = await render(
      <AppAtomRegistryProvider>
        <SidebarProvider>
          <Sidebar>
            <KinNav />
          </Sidebar>
          <SidebarTrigger />
        </SidebarProvider>
      </AppAtomRegistryProvider>,
      { router: placesPath("docs") },
    );
    await userEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    const nav = page.getByRole("navigation", { name: "Kin" });
    await expect.element(nav).toBeVisible();
    await expect.element(nav.getByLabelText("3 need you")).toBeVisible();
    await userEvent.click(nav.getByRole("link", { name: /Clients/ }));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(placesPath("clients")),
    );
  });
});
