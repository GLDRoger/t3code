import type { KinBudget, KinBudgetLimits } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinDailyLimitSetting } from "./KinDailyLimit";

const host = vi.hoisted(() => ({
  limits: { leadUnits: 2_000_000, workerUnits: 6_000_000 } as KinBudgetLimits,
  calls: [] as KinBudgetLimits[],
  show: () => {},
}));

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));

vi.mock(import("./kinClient"), async (importOriginal) => {
  const real = await importOriginal();
  const { Atom: A, AsyncResult: R } = await import("effect/reactivity");
  const { appAtomRegistry: registry } = await import("../rpc/atomRegistry");
  const { KinOrgId } = await import("@t3tools/contracts");
  const budget = (): KinBudget => ({
    orgId: KinOrgId.make("org-1"),
    day: "2026-11-20",
    leadUnits: 2_500_000,
    workerUnits: 40_000,
    limits: host.limits,
    usual: { leadUnits: 2_000_000, workerUnits: 6_000_000 },
  });
  const read = A.make(() => R.success(budget())).pipe(A.keepAlive);
  const allowed = A.make(true);
  host.show = () => registry.refresh(read);
  return {
    ...real,
    kinClient: {
      ...real.kinClient,
      budget: () => read,
      budgetSet: {
        ...real.kinClient.budgetSet,
        permissionAtom: () => allowed,
        run: async (
          _registry: unknown,
          { input }: { readonly input: { readonly limits: KinBudgetLimits } },
        ) => {
          host.calls.push(input.limits);
          host.limits = input.limits;
          return R.success(budget());
        },
      },
    },
  };
});

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { run: (registry: unknown, input: unknown) => Promise<unknown> }) =>
    (input: unknown) =>
      command.run(null, input),
}));

function setup() {
  host.limits = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
  host.calls.length = 0;
  host.show();
}

const setting = () => (
  <AppAtomRegistryProvider>
    <KinDailyLimitSetting />
  </AppAtomRegistryProvider>
);

const pick = async (label: string) => {
  await userEvent.click(page.getByRole("combobox", { name: "Daily limit" }));
  await userEvent.click(page.getByRole("option", { name: label }));
};

describe("Settings → Daily limit", () => {
  it("asks once before No limit, keeps today's use in view, and sets a limit again at once", async () => {
    setup();
    await using _screen = await render(setting());
    const trigger = page.getByRole("combobox", { name: "Daily limit" });
    await expect.element(trigger).toHaveTextContent("The usual (2M units a day)");

    await pick("No limit");
    const ask = page.getByRole("alertdialog");
    await expect
      .element(ask.getByText(/^With no limit, Kin never pauses agents for cost\./))
      .toBeVisible();
    await userEvent.click(ask.getByRole("button", { name: "Cancel" }));
    await expect.element(ask).not.toBeInTheDocument();
    expect(host.calls).toEqual([]);

    await pick("No limit");
    await userEvent.click(page.getByRole("button", { name: "Set no limit" }));
    await expect.element(trigger).toHaveTextContent("No limit");
    expect(host.calls).toEqual([{ leadUnits: null, workerUnits: null, teammateUnits: null }]);
    await expect
      .element(page.getByText("Used today: agents 2.5M units, tasks they started 40k units"))
      .toBeVisible();

    await pick("Twice the usual (4M units a day)");
    await expect.element(trigger).toHaveTextContent("Twice the usual (4M units a day)");
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
    expect(host.calls.at(-1)).toEqual({
      leadUnits: 4_000_000,
      workerUnits: 12_000_000,
      teammateUnits: null,
    });
  });
});
