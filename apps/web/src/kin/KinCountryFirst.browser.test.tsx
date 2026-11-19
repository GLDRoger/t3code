import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// What the host's `kin.access.me` says: a company made new, and whether this person runs it.
const host = vi.hoisted(() => ({ countryNeeded: true, ownerLevel: true }));

vi.mock(
  import("./useKinMoney"),
  () => ({ useKinCountryNeeded: () => host.countryNeeded }) as never,
);
vi.mock(import("./useKinOwnerLevel"), () => ({ useKinOwnerLevel: () => host.ownerLevel }) as never);

import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";

import "~/index.css";
import { render } from "../../test/render";
import { KinCountryFirst } from "./KinCountryFirst";

function setup(state: { readonly countryNeeded: boolean; readonly ownerLevel: boolean }) {
  host.countryNeeded = state.countryNeeded;
  host.ownerLevel = state.ownerLevel;
}

const money = () => (
  <KinCountryFirst environmentId={EnvironmentId.make("env-1")}>
    <p>Ambermill's money</p>
  </KinCountryFirst>
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

  it("tells a teammate the owner chooses it, with nothing to open", async () => {
    setup({ countryNeeded: true, ownerLevel: false });
    await using _screen = await render(money(), { router: "/kin/work" });
    await expect.element(page.getByText(KIN_MONEY.countryFirstMember.detail)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: KIN_MONEY.chooseCountry }))
      .not.toBeInTheDocument();
  });
});
