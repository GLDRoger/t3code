import { createFileRoute } from "@tanstack/react-router";

import { KinSettingsMoved } from "../kin/KinSettingsView";

import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import { KinCompanyProfileSettings } from "../kin/KinCompanyProfile";
import { KinCompanyTimeZoneSetting } from "../kin/KinCompanyTimeZone";
import { KinAgentsSetting } from "../kin/KinAgentsSetting";
import { KinDailyLimitSetting } from "../kin/KinDailyLimit";

// Moved into Kin's Settings; this address goes there once Kin's host is known.
function SettingsCompanyRoute() {
  const searchableSetting = useSearchableSetting();
  return (
    <KinSettingsMoved
      page="company"
      fallback={
        <SettingsPageContainer>
          <SettingsSection {...searchableSetting("company-details")} variant="plain">
            <KinCompanyProfileSettings />
          </SettingsSection>
          <KinCompanyTimeZoneSetting />
          <KinDailyLimitSetting />
          <KinAgentsSetting />
        </SettingsPageContainer>
      }
    />
  );
}

export const Route = createFileRoute("/_chat/settings/company")({
  component: SettingsCompanyRoute,
});
