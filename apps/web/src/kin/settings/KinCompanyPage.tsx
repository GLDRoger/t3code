import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { KinCompanyProfileSettings } from "../KinCompanyProfile";
import { KinCompanyTimeZoneSetting } from "../KinCompanyTimeZone";
import { KinDailyLimitSetting } from "../KinDailyLimit";
import { KinStopSetting } from "../KinStopSetting";

/** Settings → Company details. Not yet on the shared anatomy (web-settings-patterns.md). */
export function KinCompanyPage() {
  const searchableSetting = useSearchableSetting();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("company-details")} variant="plain">
        <KinCompanyProfileSettings />
      </SettingsSection>
      <KinCompanyTimeZoneSetting />
      <KinDailyLimitSetting />
      <KinStopSetting />
    </SettingsPageContainer>
  );
}
