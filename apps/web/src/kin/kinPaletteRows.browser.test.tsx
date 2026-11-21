import type { KinDestination } from "@t3tools/client-runtime/kin/kinNavigation";
import { EnvironmentId, KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const target = {
  environmentId: EnvironmentId.make("env-ambermill"),
  orgId: KinOrgId.make("org-ambermill"),
};
const chief = KinAgentId.make("agent-chief");

const groupsSeen = vi.hoisted(() => ({ values: [] as Array<ReadonlyArray<string>> }));

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ ...target, lead: null }),
}));
vi.mock(import("./kinAgentPageLink"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinPaletteAgents: () =>
    [
      {
        agentId: chief,
        name: "Chief of staff",
        domain: "operations",
        ownerChatId: KinChatId.make("chat-chief"),
      },
    ] as never,
}));
const fixture = vi.hoisted(() => {
  const chat = (chatId: string, kind: "direct" | "group", title: string | null) => ({
    chatId,
    orgId: "org-ambermill",
    kind,
    title,
    teamId: null,
    createdAt: "2026-11-08T09:00:00.000Z",
    archivedAt: null,
    lastMessageAt: null,
    members: [
      { principal: { _tag: "person", personId: "rhea" }, role: "member", leftAt: null },
      ...(kind === "direct"
        ? [{ principal: { _tag: "agent", agentId: "agent-chief" }, role: "member", leftAt: null }]
        : []),
    ],
    lastMessage: null,
    unread: 0,
  });
  return {
    host: {
      _tag: "host",
      environmentId: "env-ambermill",
      connected: true,
      probe: {
        _tag: "ready",
        orgs: {
          orgs: [
            {
              orgId: "org-ambermill",
              agents: [{ agentId: "agent-chief", displayName: "Chief of staff", retired: false }],
            },
          ],
          me: [{ orgId: "org-ambermill", personId: "rhea" }],
        },
      },
    },
    chats: [chat("chat-chief", "direct", null), chat("chat-team-room", "group", "Team room")],
  };
});
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinHost: () => fixture.host as never,
}));
vi.mock(import("./kinClient"), async (importOriginal) => {
  const actual = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const inbox = Atom.make(AsyncResult.success({ value: { chats: fixture.chats, waiting: [] } }));
  return { ...actual, kinClient: { ...actual.kinClient, inbox: () => inbox } as never };
});
vi.mock(import("../components/CommandPalette.logic"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    filterCommandPaletteGroups: (input) => {
      groupsSeen.values.push(
        input.activeGroups.flatMap((group) => group.items.map((item) => item.value)),
      );
      return actual.filterCommandPaletteGroups(input);
    },
  };
});

import { render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { CommandPalette } from "../components/CommandPalette";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { kinShownDestinationsAtom } from "./kinListSwitch";

const chatsPath = `/kin/${target.environmentId}/${target.orgId}/chat-chief`;
const KIN_ROWS =
  /^(Chats|Tasks|Money|Clients|Docs|Projects|Lists|Dates|Go to)\b|: model, character/;

function setup(destinations: ReadonlyArray<KinDestination>) {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
  groupsSeen.values = [];
  appAtomRegistry.set(kinShownDestinationsAtom, { target, destinations });
}

async function renderPalette() {
  const screen = await render(
    <AppAtomRegistryProvider>
      <CommandPalette>{null}</CommandPalette>
    </AppAtomRegistryProvider>,
    { router: chatsPath },
  );
  openCommandPalette();
  await expect.element(page.getByRole("option", { name: /^Chats:/ })).toBeVisible();
  return screen;
}

// The shortcut sign follows the platform; CI runs on Linux.
const onMac = () => vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");

const kinRowNames = () =>
  page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent ?? "")
    .filter((text) => KIN_ROWS.test(text));

describe("Kin's rows in the command palette", () => {
  it("offers the owner each place once, with its shortcut, and no two rows share a value", async () => {
    setup(["chats", "tasks", "money", "clients", "docs"]);
    using _mac = onMac();
    await using _screen = await renderPalette();

    expect(kinRowNames()).toEqual([
      "Chats: your agents, rooms and people⌘1",
      "Tasks: what's open and who has it⌘2",
      "Money: who owes you, what came in and what went out⌘3",
      "Clients: what you owe them and what they owe you⌘4",
      "Docs: what your agents have written up⌘5",
      "Projects: how each one is going",
      "Lists: everything your agents keep track of",
      "Dates: everything due, across every list",
      "Chief of staff: model, character and settings",
    ]);
    const roots = groupsSeen.values.at(-1) ?? [];
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.filter((value, index) => roots.indexOf(value) !== index)).toEqual([]);

    // A word the old descriptive row was found by still finds the one Money row.
    await userEvent.type(page.getByRole("combobox"), "invoices");
    await expect.element(page.getByRole("option", { name: /^Money: who owes you/ })).toBeVisible();
  });

  it("offers a teammate without Money no Money and no Dates, and Projects opens its tab", async () => {
    setup(["chats", "tasks", "clients", "docs"]);
    using _mac = onMac();
    await using screen = await renderPalette();

    const names = kinRowNames();
    expect(names.some((name) => name.startsWith("Money"))).toBe(false);
    expect(names.some((name) => name.startsWith("Dates"))).toBe(false);
    expect(names).toContain("Clients: what you owe them and what they owe you⌘3");
    expect(names).toContain("Projects: how each one is going");
    expect(names).toContain("Lists: everything your agents keep track of");

    await userEvent.click(page.getByRole("option", { name: /^Projects: how each one is going/ }));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.href).toBe(
        `/kin/${target.environmentId}/${target.orgId}/clients?tab=projects`,
      ),
    );
  });

  it("finds a chat by its name and opens it, ahead of the agent's settings", async () => {
    setup(["chats", "tasks"]);
    await using screen = await renderPalette();

    await userEvent.type(page.getByRole("combobox"), "Chief of staff");
    await expect.element(page.getByRole("option", { name: /^Chief of staffChat$/ })).toBeVisible();
    const found = page
      .getByRole("option")
      .elements()
      .map((option) => option.textContent ?? "");
    expect(found.indexOf("Chief of staffChat")).toBeLessThan(
      found.indexOf("Chief of staff: model, character and settings"),
    );

    await userEvent.clear(page.getByRole("combobox"));
    await userEvent.type(page.getByRole("combobox"), "Team room");
    await userEvent.click(page.getByRole("option", { name: /^Team roomChat$/ }));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.pathname).toBe(
        `/kin/${target.environmentId}/${target.orgId}/chat-team-room`,
      ),
    );
  });
});
