import {
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinOrgId,
  type KinAgentPage,
  type KinLeadProfile,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// The host: the agent's page as read, what Save sent, and a refusal it answers with when set.
const host = vi.hoisted(() => ({
  page: null as unknown,
  updates: [] as Array<unknown>,
  refuse: null as string | null,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { KinChatError: Refused } = await import("@t3tools/contracts");
  const allowed = Atom.make(true);
  const agentPage = Atom.make(() => AsyncResult.success(host.page)).pipe(Atom.keepAlive);
  const leads = Atom.make(() =>
    AsyncResult.success({ leads: [(host.page as KinAgentPage).profile] }),
  ).pipe(Atom.keepAlive);
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      agentPage: () => agentPage,
      leads: () => leads,
      leadUpdate: {
        label: "test:leadUpdate",
        permissionAtom: () => allowed,
        run: async (_registry: unknown, { input }: { readonly input: unknown }) => {
          host.updates.push(input);
          return host.refuse === null
            ? AsyncResult.success((host.page as KinAgentPage).profile)
            : AsyncResult.failure(
                Cause.fail(new Refused({ reason: "not_allowed", message: host.refuse })),
              );
        },
      },
    } as never,
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinAgentDetails } from "./KinAgentPage";
import { KinLeadDialogHost } from "./KinLeadDialog";

// Ambermill, invented: its Finance agent.
const target = { environmentId: EnvironmentId.make("env-1"), orgId: KinOrgId.make("org-1") };
const finance: KinLeadProfile = {
  orgId: target.orgId,
  agentId: KinAgentId.make("ambermill-finance"),
  name: "Finance",
  domain: "finance",
  charter: "Invoices and the bank.",
  model: "invented-model",
  ownerChatId: KinChatId.make("chat-finance"),
  working: false,
  tracking: [],
} as unknown as KinLeadProfile;

function setup(refuse: string | null) {
  host.page = {
    profile: finance,
    model: { instanceId: "invented", model: "invented-model" },
    runsOn: { instanceId: "invented", model: "invented-model" },
    modelNote: null,
    character: null,
    teamAgent: false,
    usedThisMonth: { turns: 0, tokens: 0 },
    quietHours: { from: "20:00", to: "08:00" },
    connections: [],
    playbooks: [],
  };
  host.updates = [];
  host.refuse = refuse;
}

const screen = () => (
  <AppAtomRegistryProvider>
    <KinAgentDetails
      {...target}
      agentId={finance.agentId}
      activeAgents={2}
      onClose={() => {}}
      onOpenSettings={() => {}}
    />
    <KinLeadDialogHost />
  </AppAtomRegistryProvider>
);

async function editRemit(remit: string) {
  await expect.element(page.getByText("Invoices and the bank.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Edit agent" }));
  const box = page.getByRole("textbox", { name: "What it's responsible for" });
  await userEvent.clear(box);
  await userEvent.type(box, remit);
  return box;
}

describe("an agent's page", () => {
  it("saves a changed remit as only that change, once", async () => {
    setup(null);
    await using _screen = await render(screen());
    await editRemit("Invoices, the bank and payroll.");

    await userEvent.dblClick(page.getByRole("button", { name: "Save changes" }));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(host.updates).toEqual([
      {
        orgId: target.orgId,
        agentId: finance.agentId,
        charter: "Invoices, the bank and payroll.",
      },
    ]);
  });

  it("shows the host's refusal and keeps the remit as typed", async () => {
    setup("refused");
    await using _screen = await render(screen());
    const box = await editRemit("Invoices, the bank and payroll.");

    await userEvent.click(page.getByRole("button", { name: "Save changes" }));
    await expect
      .element(page.getByText("Only the person who set up this agent can change it."))
      .toBeVisible();
    await expect.element(box).toHaveValue("Invoices, the bank and payroll.");
  });
});
