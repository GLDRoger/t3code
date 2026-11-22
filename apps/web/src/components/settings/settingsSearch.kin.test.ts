import { expect, it } from "vite-plus/test";

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
  const first = (query: string, hasKinHost: boolean, kinSectionsOff: ReadonlyArray<string> = []) =>
    searchSettings(
      query,
      filterAvailableSettingsSearchItems({ ...availability, hasKinHost, kinSectionsOff }),
    )[0];
  expect(first("quiet", true)).toMatchObject({
    id: "kin-quiet-hours",
    to: "/settings/kin-profile",
  });
  expect(first("working hours", true)?.id).toBe("kin-working-hours");
  expect(first("away", true)?.id).toBe("kin-away");
  expect(first("quiet", false)?.id).not.toBe("kin-quiet-hours");
  expect(first("legal name", true)?.id).toBe("company-details");
  expect(first("legal name", false)?.id).not.toBe("company-details");
  // Deal stages go with Deals.
  expect(first("deal stages", true)?.id).toBe("kin-deals");
  expect(first("deal stages", true, ["deals"])?.id).not.toBe("kin-deals");
});
