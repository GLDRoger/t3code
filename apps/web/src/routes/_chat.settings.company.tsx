import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { KinCompanyProfileSettings } from "../kin/KinCompanyProfile";
import { KinCheckInsSetting } from "../kin/KinCheckIns";
import { KinDailyLimitSetting } from "../kin/KinDailyLimit";

function SettingsCompanyRoute() {
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("company-details")} variant="plain">
        <KinCompanyProfileSettings />
      </SettingsSection>
      <KinDailyLimitSetting />
      <KinCheckInsSetting />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/company")({
  component: SettingsCompanyRoute,
});
