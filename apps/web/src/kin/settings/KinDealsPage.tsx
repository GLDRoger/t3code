import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { KinDealsSetting } from "../KinDealsSetting";

/** Settings → Deals. Not yet on the shared anatomy (web-settings-patterns.md). */
export function KinDealsPage() {
  return (
    <SettingsPageContainer>
      <KinDealsSetting />
    </SettingsPageContainer>
  );
}
