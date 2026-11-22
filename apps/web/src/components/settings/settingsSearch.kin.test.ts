import { expect, it } from "vite-plus/test";

import { kinSettingsShown } from "../../kin/kinNoCode";
import { kinSettingsPageHolding } from "../../kin/kinSettingsSearch";
import { filterAvailableSettingsSearchItems, searchSettings } from "./settingsSearch";

it("finds Kin's own Profile settings only where a host runs Kin", () => {
  const availability = {
    hasCloudPublicConfig: false,
    hasEnvironment: true,
    hasProviderSettingsEnvironment: true,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement: false,
  };
  const first = (query: string, hasKinHost: boolean) =>
    searchSettings(query, filterAvailableSettingsSearchItems({ ...availability, hasKinHost }))[0];
  expect(first("quiet", true)).toMatchObject({
    id: "kin-quiet-hours",
    to: "/settings/kin-profile",
  });
  expect(first("working hours", true)?.id).toBe("kin-working-hours");
  expect(first("away", true)?.id).toBe("kin-away");
  expect(first("quiet", false)?.id).not.toBe("kin-quiet-hours");
  expect(first("legal name", true)?.id).toBe("company-details");
  expect(first("legal name", false)?.id).not.toBe("company-details");
  // The Kin web app hides General's thread notifications; the search finds Kin's own instead.
  const kinWeb = kinSettingsShown(
    filterAvailableSettingsSearchItems({ ...availability, hasKinHost: true }),
    true,
  );
  const notifications = searchSettings("notifications", kinWeb)[0];
  expect(notifications).toMatchObject({ id: "kin-notifications", to: "/settings/kin-profile" });
  expect(kinSettingsPageHolding("profile", notifications!.targetId!)).toBe("notifications");
});
