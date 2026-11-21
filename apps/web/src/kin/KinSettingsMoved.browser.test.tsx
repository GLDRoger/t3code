import type { KinSettingsPage } from "@t3tools/client-runtime/kin/kinNavigation";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock(import("./KinNewLeadButton"), async (importOriginal) => ({
  ...(await importOriginal()),
  kinNewLeadTarget: () => ({ environmentId: "env-1", orgId: "org-1", lead: null }) as never,
}));

import { render } from "../../test/render";
import type { SettingsPath } from "../components/settings/settingsSearch";
import { KIN_SETTINGS_SEARCH_ITEMS, KIN_SETTINGS_SECTION_LABELS } from "./kinSettingsSearch";
import { useKinSettingLanding } from "./kinSettingsAddress";
import { KinSettingsMoved } from "./KinSettingsView";

// The page each moved app address hands Kin's Settings, as its route file passes it.
const ROUTE_PAGE: Partial<Record<SettingsPath, KinSettingsPage>> = {
  "/settings/approvals": "approvals",
  "/settings/check-ins": "check-ins",
  "/settings/company": "company",
  "/settings/deals": "deals",
  "/settings/kin-connections": "connections",
  "/settings/kin-profile": "profile",
};

// The page of Kin's Settings that draws each Kin setting the app's search offers.
const HOLDS: Readonly<Record<string, KinSettingsPage>> = {
  "approval-phones": "approvals",
  "kin-check-ins": "check-ins",
  "kin-deals": "deals",
  "company-details": "company",
  "kin-time-zone": "company",
  "kin-daily-limit": "company",
  "kin-agents": "agents",
  "kin-who-can-message": "team",
  "kin-connections": "connections",
  "kin-quiet-hours": "profile",
  "kin-working-hours": "profile",
  "kin-away": "profile",
  "kin-github-username": "profile",
};

const kinEntries = () => KIN_SETTINGS_SEARCH_ITEMS;

describe("an app settings address that moved into Kin's Settings", () => {
  it("opens every Kin setting the app's search offers on the page that holds it", async () => {
    expect(Object.keys(ROUTE_PAGE).toSorted()).toEqual(
      Object.keys(KIN_SETTINGS_SECTION_LABELS).toSorted(),
    );
    // A new Kin entry fails here until the page that draws it is named above.
    expect(
      kinEntries()
        .map((item) => item.id)
        .toSorted(),
    ).toEqual(Object.keys(HOLDS).toSorted());

    for (const item of kinEntries()) {
      const found = "targetId" in item && item.targetId !== undefined ? item.targetId : item.id;
      await using screen = await render(
        <KinSettingsMoved page={ROUTE_PAGE[item.to]!} fallback={null} />,
        { router: `${item.to}#${found}` },
      );
      await vi.waitFor(() =>
        expect(screen.router!.state.location.href).toBe(
          `/kin?settings=${HOLDS[item.id]}&at=${found}`,
        ),
      );
    }
  });

  it("lands on the found row once it draws, keeps it in view as the page settles, and lets go when touched", async () => {
    await using screen = await render(<SettingsPage loaded={false} />, {
      router: "/kin?settings=company&at=kin-daily-limit",
    });
    // The company's details and the row draw once their data comes in.
    screen.rerender(<SettingsPage loaded />);
    const row = () => document.getElementById("kin-daily-limit")!;
    await vi.waitFor(() => expect(document.activeElement).toBe(row()));
    expect(row().hasAttribute("data-kin-setting-found")).toBe(true);
    const box = document.querySelector("[data-settings-page-scroll]")!.getBoundingClientRect();
    expect(row().getBoundingClientRect().top).toBeGreaterThanOrEqual(box.top);
    expect(row().getBoundingClientRect().bottom).toBeLessThanOrEqual(box.bottom);

    await userEvent.click(page.getByText("Company details"));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.searchStr).toBe("?settings=company"),
    );
    expect(row().hasAttribute("data-kin-setting-found")).toBe(false);
  });
});

function SettingsPage(props: { readonly loaded: boolean }) {
  const landing = useKinSettingLanding();
  return (
    <div ref={landing} className="flex h-60 flex-col">
      <div data-settings-page-scroll className="flex-1 overflow-y-auto">
        {props.loaded ? (
          <>
            <p className="h-[600px]">Company details</p>
            <section id="kin-daily-limit" tabIndex={-1} className="h-20">
              Daily limit
            </section>
          </>
        ) : null}
        <p className="h-[600px]">Agents</p>
      </div>
    </div>
  );
}
