import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// What the host's `kin.access.me` says: a company made new, whether this person runs it, and
// whether a teammate's places include Money. Read as the real atom is, so a change re-renders.
const host = vi.hoisted(() => ({
  countryNeeded: true,
  ownerLevel: true,
  money: false,
  heard: new Set<() => void>(),
}));

vi.mock(import("./useKinMoney"), async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    host.heard.add(listener);
    return () => host.heard.delete(listener);
  };
  return {
    ...(await importOriginal()),
    useKinCountryNeeded: (() => useSyncExternalStore(subscribe, () => host.countryNeeded)) as never,
  };
});
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: (() => host.ownerLevel) as never,
  useKinPlaceReach: (() => ({ money: host.money, clients: false, docs: false })) as never,
}));

import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { KIN_WORK_FORM_COPY } from "@t3tools/client-runtime/kin/kinWorkForms";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { KinCountryFirst } from "./KinCountryFirst";
import { KinProjectDialog } from "./KinWorkForms";

function setup(state: {
  readonly countryNeeded: boolean;
  readonly ownerLevel: boolean;
  readonly money?: boolean;
}) {
  host.countryNeeded = state.countryNeeded;
  host.ownerLevel = state.ownerLevel;
  host.money = state.money ?? false;
  for (const listener of host.heard) listener();
}

const money = () => (
  <KinCountryFirst environmentId={EnvironmentId.make("env-1")}>
    <p>Ambermill's money</p>
  </KinCountryFirst>
);

const newProject = () => (
  <AppAtomRegistryProvider>
    <KinProjectDialog
      environmentId={EnvironmentId.make("env-1")}
      orgId={KinOrgId.make("ambermill")}
      editing={null}
      party={null}
      choices={{ clients: [], projects: [], doneProjects: [], projectClients: new Map() }}
      onSaved={() => {}}
      onOpenExisting={() => {}}
      onClose={() => {}}
    />
  </AppAtomRegistryProvider>
);

describe("Money for a company made new", () => {
  it("asks for the country first, opens Company details over it, and shows Money once saved", async () => {
    setup({ countryNeeded: true, ownerLevel: true });
    await using screen = await render(money(), { router: "/kin/work" });
    await expect.element(page.getByText(KIN_MONEY.countryFirst.detail)).toBeVisible();
    await expect.element(page.getByText("Ambermill's money")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: KIN_MONEY.chooseCountry }));
    expect(screen.router?.history.location.pathname).toBe("/kin/work");
    expect(new URLSearchParams(screen.router?.history.location.search).get("settings")).toBe(
      "company",
    );
    // The country saved, the host's read no longer says so.
    setup({ countryNeeded: false, ownerLevel: true });
    await screen.rerender(money());
    await expect.element(page.getByText("Ambermill's money")).toBeVisible();
    await expect.element(page.getByText(KIN_MONEY.countryFirst.detail)).not.toBeInTheDocument();
  });

  it("tells a teammate with Money that an owner chooses it, with nothing to open", async () => {
    setup({ countryNeeded: true, ownerLevel: false, money: true });
    await using _screen = await render(money(), { router: "/kin/work" });
    await expect
      .element(
        page.getByText(
          "An owner chooses the company's country first, so amounts, tax and dates read right.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: KIN_MONEY.chooseCountry }))
      .not.toBeInTheDocument();
  });

  it("leaves a teammate without Money where they were: Money's own refusal", async () => {
    setup({ countryNeeded: true, ownerLevel: false, money: false });
    await using _screen = await render(money(), { router: "/kin/work" });
    await expect.element(page.getByText("Ambermill's money")).toBeVisible();
    await expect
      .element(page.getByText(KIN_MONEY.countryFirstMember.title))
      .not.toBeInTheDocument();
  });

  it("puts the step where a project's value goes, and keeps what was typed", async () => {
    setup({ countryNeeded: true, ownerLevel: true });
    await using screen = await render(newProject(), { router: "/kin/work" });
    const name = page.getByRole("textbox", { name: KIN_WORK_FORM_COPY.project.name });
    await userEvent.fill(name, "Invented shop fit");
    await expect
      .element(page.getByRole("textbox", { name: KIN_WORK_FORM_COPY.project.value }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(KIN_MONEY.countryFirst.detail)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: KIN_MONEY.chooseCountry }));
    expect(new URLSearchParams(screen.router?.history.location.search).get("settings")).toBe(
      "company",
    );
    // Back from Company details with the country saved: the field is there, the name kept.
    setup({ countryNeeded: false, ownerLevel: true });
    await expect.element(name).toHaveValue("Invented shop fit");
    await expect
      .element(page.getByRole("textbox", { name: KIN_WORK_FORM_COPY.project.value }))
      .toBeVisible();
  });
});
