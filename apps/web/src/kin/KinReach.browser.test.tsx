import { EnvironmentId, KinLeadProfile, KinOrgId, KinPersonId } from "@t3tools/contracts";
import type { KinReachListResult, KinReachSetInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinAgentSection } from "./KinLeadAccess";
import { KinAgentReach, KinPersonReach, KinReachList } from "./KinReach";

// A host that keeps the restricted pairs and answers `kin.reach.*` as the server does.
const host = vi.hoisted(() => ({
  may: true,
  limits: [] as Array<KinReachListResult["limits"][number]>,
  sets: [] as Array<{ readonly restricted: boolean }>,
}));

vi.mock("./kinClient", async () => {
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const key = (party: KinReachSetInput["a"]) =>
    party.kind === "person" ? party.personId : party.agentId;
  const same = (one: KinReachSetInput["a"], other: KinReachSetInput["a"]) =>
    key(one) === key(other);
  const reach = A.make(() =>
    R.success({ limits: [...host.limits], restrictable: ["dev", "zoya", "arjun"] }),
  ).pipe(A.keepAlive);
  const people = A.make(
    R.success({
      people: [
        { personId: "rhea", displayName: "Rhea Kapoor" },
        { personId: "meera", displayName: "Meera Iyer" },
        { personId: "dev", displayName: "Dev Malhotra" },
        { personId: "zoya", displayName: "Zoya Sheikh" },
        { personId: "arjun", displayName: "Arjun Rao" },
      ],
      joined: [],
    }),
  ).pipe(A.keepAlive);
  const leads = A.make(
    R.success({ leads: [{ agentId: "finance", name: "Finance", ownerChatId: "rhea-finance" }] }),
  ).pipe(A.keepAlive);
  const may = A.make(() => host.may);
  return {
    kinClient: {
      reach: () => reach,
      people: () => people,
      leads: () => leads,
      reachSet: {
        permissionAtom: () => may,
        run: async ({ input }: { readonly input: KinReachSetInput }) => {
          host.sets.push({ restricted: input.restricted });
          const at = host.limits.findIndex(
            (limit) =>
              (same(limit.one, input.a) && same(limit.other, input.b)) ||
              (same(limit.one, input.b) && same(limit.other, input.a)),
          );
          if (input.restricted && at === -1)
            host.limits.push({
              one: input.a,
              other: input.b,
              setBy: KinPersonId.make("rhea"),
              setAt: "2026-11-20T08:00:00.000Z",
            });
          if (!input.restricted && at !== -1) host.limits.splice(at, 1);
          return R.success({ limits: host.limits, restrictable: [] });
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { run: (input: unknown) => Promise<unknown> }) => command.run,
}));

const environmentId = EnvironmentId.make("env-1");
const orgId = KinOrgId.make("ambermill");
const lead = Schema.decodeSync(KinLeadProfile)({
  orgId: "ambermill",
  agentId: "finance",
  name: "Finance",
  domain: "finance",
  charter: "Handles billing questions and invoices.",
  model: "gpt-5.5",
  ownerChatId: "rhea-finance",
  working: false,
  tracking: [],
});

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section aria-label={props.title} className="flex flex-col gap-2">
      {props.children}
    </section>
  );
}

function setup(may = true) {
  host.may = may;
  host.limits.length = 0;
  host.sets.length = 0;
}

describe("who can message whom", () => {
  it("restricts someone from an agent's page after a confirm, and lifts them without one", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinAgentReach lead={lead} environmentId={environmentId} section={KinAgentSection} />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(page.getByText("Everyone in the company can message Finance."))
      .toBeVisible();
    const canMessage = page.getByRole("list", { name: "Can message" });
    await expect.element(canMessage.getByText("Dev Malhotra")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Restrict someone" }));
    // Owners and co-owners are never offered.
    await expect
      .element(page.getByRole("menuitem", { name: "Meera Iyer" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("menuitem", { name: "Dev Malhotra" }));
    await expect.element(page.getByText("Restrict Dev Malhotra and Finance?")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Neither can message the other until you lift this. Dev Malhotra keeps their chat with Finance to read.",
        ),
      )
      .toBeVisible();
    expect(host.sets).toEqual([]);
    await userEvent.click(page.getByRole("button", { name: "Restrict", exact: true }));

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Dev Malhotra and Finance can't message each other now.");
    const restricted = page.getByRole("list", { name: "Restricted" });
    await expect.element(restricted.getByText("Dev Malhotra")).toBeVisible();
    await expect.element(canMessage.getByText("Dev Malhotra")).not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Everyone in the company can message Finance, except the people under Restricted.",
        ),
      )
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Lift Dev Malhotra and Finance" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Dev Malhotra and Finance can message each other again.");
    await expect.element(restricted).not.toBeInTheDocument();
    await expect.element(canMessage.getByText("Dev Malhotra")).toBeVisible();
    await expect
      .element(page.getByText("Everyone in the company can message Finance."))
      .toBeVisible();
    expect(host.sets).toEqual([{ restricted: true }, { restricted: false }]);
  });

  it("restricts two people from a person's page, lists it, and lifts it; an owner-level page offers nothing", async () => {
    setup();
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinPersonReach
          environmentId={environmentId}
          orgId={orgId}
          personId={KinPersonId.make("dev")}
          name="Dev Malhotra"
          ownerLevel={false}
          onOpenAgent={() => {}}
          section={Section}
        />
        <KinReachList environmentId={environmentId} orgId={orgId} />
        <KinPersonReach
          environmentId={environmentId}
          orgId={orgId}
          personId={KinPersonId.make("meera")}
          name="Meera Iyer"
          ownerLevel
          onOpenAgent={() => {}}
          section={Section}
        />
      </AppAtomRegistryProvider>,
    );
    await expect
      .element(
        page.getByText(
          "Meera Iyer can message everyone, as an owner or co-owner. That can't be restricted.",
        ),
      )
      .toBeVisible();
    const agents = page.getByRole("region", { name: "Agents" });
    await expect.element(agents.getByText("Can message")).toBeVisible();
    await expect
      .element(page.getByText("Dev Malhotra can message everyone on the team."))
      .toBeVisible();
    await expect.element(page.getByText(/^Nobody is restricted/)).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Restrict messaging with…" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Zoya Sheikh" }));
    await expect.element(page.getByText("Restrict Dev Malhotra and Zoya Sheikh?")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Restrict", exact: true }));

    const cant = page.getByRole("list", { name: "Can't message" });
    await expect.element(cant.getByText("Zoya Sheikh")).toBeVisible();
    // Settings, Team lists the same pair, with who set it.
    await expect
      .element(page.getByText("Dev Malhotra and Zoya Sheikh", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(/^Restricted by Rhea Kapoor on /)).toBeVisible();

    await userEvent.click(
      page.getByRole("button", { name: "Lift Dev Malhotra and Zoya Sheikh" }).first(),
    );
    await expect.element(cant).not.toBeInTheDocument();
    await expect.element(page.getByText(/^Nobody is restricted/)).toBeVisible();
    expect(host.sets).toEqual([{ restricted: true }, { restricted: false }]);
  });

  it("shows a teammate no list and no control", async () => {
    setup(false);
    await using _screen = await render(
      <AppAtomRegistryProvider>
        <KinAgentReach lead={lead} environmentId={environmentId} section={KinAgentSection} />
        <KinReachList environmentId={environmentId} orgId={orgId} />
        <KinPersonReach
          environmentId={environmentId}
          orgId={orgId}
          personId={KinPersonId.make("dev")}
          name="Dev Malhotra"
          ownerLevel={false}
          onOpenAgent={() => {}}
          section={Section}
        />
      </AppAtomRegistryProvider>,
    );
    await expect.element(page.getByText("Who can message")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button")).not.toBeInTheDocument();
  });
});
